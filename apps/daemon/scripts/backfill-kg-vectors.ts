/**
 * 存量知识节点向量一次性回填脚本（批1 WP-B）。
 *
 * `bun apps/daemon/scripts/backfill-kg-vectors.ts [--home <dir>] [--dry-run]
 *  [--project-root <dir,dir,...>]`
 *
 * ## 这是什么
 *
 * kg 向量基建（node_vectors 表）落地后，对存量**活跃节点**（status ≠
 * superseded）做一次性向量回填：逐节点按 §4.2 公式（doc = name + scene +
 * digest + body.slice(0,1500)，content_hash = sha256(doc)）增量嵌入落表。
 * 与写入口增量重嵌（KgVectorService）同一实现同一判据——hash 未变 ∧ model
 * 未变跳过，**幂等可重跑**；失败逐条 warn 留档（下次重跑修复）。
 *
 * ## 形态裁决（与 brief 建议的差异，留档）
 *
 * brief 写作 `scripts/backfill-kg-vectors.ts`（照 backfill-memory-classify.ts
 * 先例）——先例实体在 `apps/daemon/scripts/`（daemon 域脚本目录，可直接
 * import src 面），本脚本随先例落同目录；顶层 scripts/ 是构建/工具链脚本域
 * （compile-daemon/typecheck-all 等），不收 daemon 业务脚本。
 * 嵌入调用为 EmbeddingPort.embed 单文本形态（与记忆面同款 OpenAI 兼容端点
 * 基建），逐条嵌入即天然「失败逐条 warn」——不引入批调用聚合（398~千级
 * 节点全量余弦场景下逐条可接受，失败隔离语义优先）。
 *
 * ## 安全语义（绝不丢数据、绝不误删）
 *
 * - 只写 node_vectors（可再生缓存——文本唯一 source of truth，弃表零损失）；
 *   nodes/edges/change_log 零触碰，零 DELETE；
 * - 端点缺失（embedding.defaultEndpointId 未设/悬空/非 kind=embedding）→
 *   整批放弃零写入退出（可选件纪律）；dry-run 判定照跑零落库；
 * - 幂等可重跑：hash 判据跳过未变节点；superseded 节点不嵌（相似度面不
 *   收留史节点——supersede 删向量语义的回填同口径）。
 */
import { existsSync } from "node:fs";
import type { EmbeddingEndpointConfig, EmbeddingPort } from "../src/application/ports/outbound/EmbeddingPort";
import type { KgVectorSyncReport } from "../src/application/services/kg/KgVectorService";
import { KgVectorService } from "../src/application/services/kg/KgVectorService";
import {
  parseRecords,
  resolveDefaultRecordOf,
  endpointConfigOf,
  type EmbeddingEndpointRecord,
} from "../src/application/embedding/EmbeddingConfigService";
import { SqliteKnowledgeStore } from "../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { nodeVectorContentHash } from "../src/adapters/driven/sqlite-kg/node-vector-codec";
import { KgDatabase } from "../src/adapters/driven/sqlite-kg/KgDatabase";
import { OpenAiCompatEmbeddingAdapter } from "../src/adapters/driven/embedding/OpenAiCompatEmbeddingAdapter";
import { createPaths } from "../src/infrastructure/paths";
import { openTaskLedgerDatabase } from "../src/adapters/driven/sqlite-session/WriteQueue";

// ── 编排面（测试消费：fake service + fake store 即可全断言） ──────

export interface KgVectorBackfillOptions {
  /** 只判不写（判定照跑零落库——预演模式）。 */
  readonly dryRun: boolean;
}

export interface KgVectorBackfillReport {
  readonly status: "done" | "aborted";
  /** aborted 原因（默认端点缺失等）。 */
  readonly reason?: string;
  /** 实际嵌入并落行数（dryRun = 预估可嵌数）。 */
  readonly embedded: number;
  /** hash/model 未变跳过数。 */
  readonly skipped: number;
  /** 嵌入失败数（逐条 warn 留档）。 */
  readonly failed: number;
  /** 端点缺失降级数。 */
  readonly degraded: number;
  /** warn 留档清单（含节点 id 定位）。 */
  readonly warnings: readonly string[];
}

/** 回填编排：端点前置检查（可选件纪律）→ 逐项目 syncAll（同一增量判据）→ 报告。 */
export async function runKgVectorBackfill(deps: {
  readonly service: KgVectorService;
  readonly projectRoots: readonly string[];
  readonly options?: Partial<KgVectorBackfillOptions>;
  readonly log?: (line: string) => void;
}): Promise<KgVectorBackfillReport> {
  const options: KgVectorBackfillOptions = { dryRun: false, ...deps.options };
  const log = deps.log ?? (() => {});
  const zero = { embedded: 0, skipped: 0, failed: 0, degraded: 0, warnings: [] as readonly string[] };
  if (!deps.service.endpointAvailable()) {
    return {
      status: "aborted",
      reason: "默认 embedding 端点未配置（embedding.defaultEndpointId 未设/悬空）——整批放弃零写入",
      ...zero,
    };
  }
  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  let degraded = 0;
  const warnings: string[] = [];
  for (const projectRoot of deps.projectRoots) {
    const report: KgVectorSyncReport = await deps.service.syncAll(projectRoot, { dryRun: options.dryRun });
    embedded += report.embedded;
    skipped += report.skipped;
    failed += report.failed;
    degraded += report.degraded;
    for (const w of report.warnings) warnings.push(w);
    log(
      `项目 ${projectRoot}：嵌入 ${report.embedded} / 跳过 ${report.skipped} / 失败 ${report.failed} / 降级 ${report.degraded}` +
        (options.dryRun ? "（DRY-RUN 零落库）" : ""),
    );
  }
  return { status: "done", embedded, skipped, failed, degraded, warnings };
}

// ── 装配与入口（独立进程最小装配，不起 daemon——先例同构） ─────────

interface DefaultEndpointResolution {
  readonly endpoint: EmbeddingEndpointConfig | null;
  readonly reason: string;
}

/** 从 helix.db KV 解析默认 embedding 端点（embedding.defaultEndpointId →
 *  embedding_endpoints 记录，kind=embedding 校验）。判据 = 与父进程
 *  EmbeddingConfigService.resolveDefault 共享的纯函数单点（评审 F1——此前三处
 *  本地复刻，语义靠注释维系）；本脚本额外保留失败定位文案（未配置/悬空/非向量
 *  三类退出提示）。 */
function resolveDefaultEndpoint(dbPath: string): DefaultEndpointResolution {
  const db = openTaskLedgerDatabase(dbPath);
  try {
    const readKey = (key: string): string | undefined => {
      const row = db.prepare("SELECT value FROM runtime_config WHERE key = ?").get(key) as { value: string } | undefined;
      return row === undefined ? undefined : row.value;
    };
    const id = readKey("embedding.defaultEndpointId");
    if (id === undefined || id.trim() === "") {
      return { endpoint: null, reason: "embedding.defaultEndpointId 未配置" };
    }
    const records = parseRecords(readKey("embedding_endpoints"));
    const record = resolveDefaultRecordOf(records, id, "embedding");
    if (record === null) {
      const referenced = records.find((r) => r.id === id);
      return {
        endpoint: null,
        reason:
          referenced === undefined
            ? `默认端点记录不存在（悬空：${id}）`
            : `默认端点 ${referenced.name} 不是向量端点（kind=${referenced.kind}）`,
      };
    }
    return { endpoint: endpointConfigOf(record), reason: "" };
  } finally {
    db.close();
  }
}

function argValue(flag: string): string | undefined {
  const argv = process.argv;
  const at = argv.indexOf(flag);
  return at !== -1 && at + 1 < argv.length ? argv[at + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/** main：装配（helix.db 默认端点 + .helix-kg/kg.db per-project）→ 回填 → 报告。 */
async function main(): Promise<void> {
  const home = argValue("--home");
  const paths = createPaths(home);
  const dryRun = hasFlag("--dry-run");
  // 项目根缺省 = cwd（.helix-kg/kg.db 所在项目根）；--project-root 可给逗号清单
  const projectRoots = (argValue("--project-root") ?? process.cwd())
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const missing = projectRoots.filter((root) => !existsSync(`${root}/.helix-kg/kg.db`));
  if (missing.length > 0) {
    console.error(`项目根缺 .helix-kg/kg.db：${missing.join("、")}`);
    process.exit(1);
  }
  const { endpoint, reason } = resolveDefaultEndpoint(paths.dbPath());
  if (endpoint === null) {
    console.error(`中止：${reason}——请先在模型配置 → 向量模型设置默认 embedding 端点`);
    process.exit(1);
  }
  // node_vectors 在 bun:sqlite 的 kg.db 内（不引 vec0/better-sqlite3——全量
  // 余弦场景 bun:sqlite 即可，设计稿 §4.1）；无需 vec0 扩展探测。
  const embedding: EmbeddingPort = new OpenAiCompatEmbeddingAdapter({ getConfig: () => endpoint });
  console.log(`默认端点：${endpoint.model} @ ${endpoint.baseUrl}（${dryRun ? "DRY-RUN" : "回写模式"}，项目根 [${projectRoots.join(", ")}]）`);
  const database = new KgDatabase();
  try {
    const store = new SqliteKnowledgeStore({ database });
    const service = new KgVectorService({
      store,
      embedding,
      resolveEndpoint: () => endpoint,
      contentHash: nodeVectorContentHash,
      logger: { warn: (message) => console.warn(`  warn：${message}`) },
    });
    const report = await runKgVectorBackfill({ service, projectRoots, options: { dryRun }, log: (line) => console.log(line) });
    console.log(`\n嵌入 ${report.embedded} 条；跳过 ${report.skipped} 条；失败 ${report.failed} 条；降级 ${report.degraded} 条；warn ${report.warnings.length} 条`);
    for (const w of report.warnings) console.log(`  warn：${w}`);
    if (report.status === "aborted") {
      console.error(`中止：${report.reason}`);
      process.exit(1);
    }
  } finally {
    database.closeAll();
  }
}

if (import.meta.main) {
  await main();
}
