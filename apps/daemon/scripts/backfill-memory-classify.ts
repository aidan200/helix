/**
 * 存量长期记忆条目判官批量分类回填（批B，一次性运维脚本）。
 *
 * `bun apps/daemon/scripts/backfill-memory-classify.ts [--home <dir>] [--dry-run]
 *  [--batch-size N] [--projects a,b]`
 *
 * ## 这是什么
 *
 * 批A（b8ba4490，E-279）落地 domain 维度后，存量条目按迁移缺省打了标
 * （progress→project、其余→habit、kind 保持原值——session-summary 历史
 * 条目全为 preference）。本脚本用现有分类判官端点（JudgePort /
 * JudgeAdapterFactory 双通道，E-199）对存量**自动生产源**条目
 * （auto-sediment + session-summary，E-213 AUTO_SOURCES 同集）批量重判
 * kind（preference|fact）+ domain（habit|general|project）并回写，让存量
 * 与新写入同判据（判据单源 E-279，措辞与总结器提取 prompt 同款）。
 *
 * ## 形态裁决（与 brief 建议的差异，留档）
 *
 * brief 建议「每条编号 + 文本一次判 N 条 + 输出严格 JSON」——但现有
 * JudgePort 契约面只有 noul(state, question) → [0,1] 单概率（无生成形态），
 * 单次调用无法归因到多条。按 brief「可依实况调整但须留档」授权，调整为
 * **每条分层问句**：kind 一问 + domain 两问（habit 未命中才问 project，
 * 命中即短路——多数条目两问收口）。「解析失败重试/跳过」对应为问级重试
 * 一次、仍败该条 skip 保持现状。
 *
 * ## 安全语义（绝不丢数据、绝不误删）
 *
 * - 只 UPDATE entries 的 kind/domain/project_scope 三列（单写面方法
 *   SqliteVecMemoryStore.reclassifyMany——TR-20 写 SQL 收口存储实现层）；
 *   text/向量/生命周期列/updated_at/source/created_at/session_id 零触碰；
 * - 零 DELETE；progress / steward-turn / manual 条目不进重判集（显式语义
 *   优先，E-279 scene）；
 * - domain=project 取名从条目文本机械匹配候选项目名（唯一命中才用；零/
 *   多命中回落 general+global + warn——宁可保守归 global 不伪造项目名），
 *   一致性约束经 resolveMemoryWriteAttrs 单点出口（E-279，回写路径同生效）；
 * - 幂等可重跑：meta 表标记 BACKFILL_CLASSIFY_MARKER 登记已判 id——重跑
 *   跳过已判条目（选定「跳过」而非「覆盖」：判官概率非确定，覆盖会抖动；
 *   跳过 = 幂等且省调用），skip 条目不标记（下次可重判）；
 * - 判官缺席（端点未配置/非 classifier）→ 整批放弃零写入退出；
 *   dry-run 判定照跑零落库。
 */
import { existsSync } from "node:fs";
import { getLoadablePath } from "sqlite-vec";
import type { JudgePort } from "../src/application/ports/outbound/JudgePort";
import type { MemoryDomain, StewardMemoryEntry } from "../src/application/ports/outbound/StewardMemoryPort";
import { resolveMemoryWriteAttrs, MEMORY_SCOPE_GLOBAL } from "../src/application/steward/StewardMemoryService";
import { SqliteVecMemoryStore } from "../src/adapters/driven/steward-memory/SqliteVecMemoryStore";
import { resolveVec0Path } from "../src/adapters/driven/steward-memory/resolve-vec0";
import { makeJudgeAdapter } from "../src/adapters/driven/embedding/JudgeAdapterFactory";
import { parseRecords, type EmbeddingEndpointRecord } from "../src/application/embedding/EmbeddingConfigService";
import { createPaths } from "../src/infrastructure/paths";
import { AuthStore } from "../src/infrastructure/auth-store";
import { ModelCatalog, createModelsBase } from "../src/adapters/driven/llm";
import { openTaskLedgerDatabase } from "../src/adapters/driven/sqlite-session/WriteQueue";

// ── 常量（判据单源 E-279；措辞与 SessionSummaryService 提取 prompt 同款）──

/** 幂等标记键（meta 表；v1 = 判据版本——判据演进换键即重判全量）。 */
export const BACKFILL_CLASSIFY_MARKER = "backfill:classify:v1";

/** 重判对象 = 自动生产源（E-213 AUTO_SOURCES 同集：B5 历史存量 + 总结器
 *  记忆点）。progress（kind 语义固定）与 steward-turn/manual（显式写入）
 *  不重判——本批不复制 src 内私有集合，语义等值集 + 指路注释。 */
const BACKFILL_SOURCES: ReadonlySet<string> = new Set(["auto-sediment", "session-summary"]);

/** kind 判据问句（preference = 用户偏好/习惯/要求；fact = 事实/环境/纠正）。 */
export const KIND_QUESTION =
  "该陈述是否在描述用户的偏好、习惯或要求（用户喜欢/要求/习惯怎么做），而非事实、环境或项目状态陈述？";

/** domain 问句一：habit = 关于用户怎么干活，换个团队也成立。 */
export const HABIT_QUESTION = "该陈述是否描述用户的工作方式或偏好——无论换到哪个团队都成立（与任何具体项目无关）？";

/** domain 问句二：project = 绑定具体项目才有意义，换个项目不成立
 *  （habit 未命中才问）。 */
export const PROJECT_QUESTION = "该陈述是否绑定某个具体项目才有意义（换个项目就不成立）？";

/** 校准概率判定阈值（0.5 中点——noul 是校准概率，非 softmax 分数）。 */
const NOUL_YES = 0.5;

/** 问级重试次数（首次失败后再试一次——brief「解析失败该批重试一次或跳过」）。 */
const RETRY_ONCE = 1;

/** 缺省项目名候选（本记忆库条目实际来自 helix 会话；--projects 可覆盖扩充）。 */
const DEFAULT_PROJECTS: readonly string[] = ["helix"];

// ── 纯函数：概率→判定映射 + 机械取名 ───────────────────────

export interface Verdict {
  readonly kind: "preference" | "fact";
  readonly domain: MemoryDomain;
}

/** 三问概率 → 判定（habitP 命中短路——projectP 不消费）。任一已消费概率
 *  非法（NaN/越界）→ null = 该条跳过保持现状。 */
export function verdictFromProbabilities(
  kindP: number,
  habitP: number,
  projectP: number | undefined,
): Verdict | null {
  if (!isFinite01(kindP) || !isFinite01(habitP)) return null;
  const kind: "preference" | "fact" = kindP >= NOUL_YES ? "preference" : "fact";
  if (habitP >= NOUL_YES) return { kind, domain: "habit" };
  if (projectP === undefined) return null;
  if (!isFinite01(projectP)) return null;
  return { kind, domain: projectP >= NOUL_YES ? "project" : "general" };
}

function isFinite01(v: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** 条目文本机械匹配项目名：唯一命中 → 名字；零/多命中 → undefined（保守
 *  回落 general+global——宁可不归项目，不伪造项目名）。大小写不敏感。 */
export function matchProjectName(text: string, candidates: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  const hits = candidates.filter((name) => name.trim() !== "" && lower.includes(name.trim().toLowerCase()));
  return hits.length === 1 ? hits[0]!.trim() : undefined;
}

// ── 判定链（单条：2-3 问 + 一致性约束单点出口）──────────────

export type ClassifyOutcome =
  | {
      readonly ok: true;
      readonly kind: "preference" | "fact";
      readonly domain: MemoryDomain;
      readonly projectScope: string;
      readonly warnings: string[];
    }
  | { readonly ok: false; readonly reason: string };

/** 单问执行：重试一次仍抛错/非法值 → 上抛由 classifyEntry 转 skip。 */
async function ask(judge: JudgePort, state: string, question: string): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_ONCE; attempt += 1) {
    try {
      const p = await judge.noul(state, question);
      if (!isFinite01(p)) throw new Error(`判官概率非法：${String(p)}`);
      return p;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function classifyEntry(
  judge: JudgePort,
  text: string,
  projects: readonly string[],
  hooks?: { readonly warn?: (message: string) => void },
): Promise<ClassifyOutcome> {
  try {
    const kindP = await ask(judge, text, KIND_QUESTION);
    const habitP = await ask(judge, text, HABIT_QUESTION);
    const projectP = habitP >= NOUL_YES ? undefined : await ask(judge, text, PROJECT_QUESTION);
    const verdict = verdictFromProbabilities(kindP, habitP, projectP);
    if (verdict === null) {
      return { ok: false, reason: `判官概率非法（条目：${text.slice(0, 40)}…）` };
    }
    // 一致性约束单点出口（E-279）：domain=project 且文本无唯一项目名 →
    // 单点回落 general+global + warn（不伪造项目名）。
    const matched = verdict.domain === "project" ? matchProjectName(text, projects) : undefined;
    const warnings: string[] = [];
    const attrs = resolveMemoryWriteAttrs({
      kind: verdict.kind,
      domain: verdict.domain,
      ...(verdict.domain === "project" && matched !== undefined ? { project: matched } : {}),
      warn: (m) => {
        warnings.push(m);
        hooks?.warn?.(m);
      },
    });
    return { ok: true, kind: verdict.kind, domain: attrs.domain, projectScope: attrs.projectScope, warnings };
  } catch (err) {
    return { ok: false, reason: `判官不可用/重试仍败（${(err as Error).message}）` };
  }
}

// ── 编排器 ─────────────────────────────────────────────────

export interface BackfillOptions {
  /** 每批条目数（批 = 回写事务单位 + 进度输出单位）。 */
  readonly batchSize: number;
  /** 项目名候选（domain=project 机械取名）。 */
  readonly projects: readonly string[];
  /** 只判不写（输出预期分布，零落库零标记）。 */
  readonly dryRun: boolean;
}

export interface DistRow {
  readonly source: string;
  readonly kind: string;
  readonly domain: string;
  readonly projectScope: string;
  readonly n: number;
}

export interface BackfillReport {
  readonly status: "done" | "aborted";
  /** aborted 原因（判官缺席等）。 */
  readonly reason?: string;
  readonly before: readonly DistRow[];
  readonly after: readonly DistRow[];
  /** 幂等过滤后的待判条数。 */
  readonly planned: number;
  /** 判定成功并回写的条数（dryRun = 判定成功条数）。 */
  readonly processed: number;
  /** 判定失败跳过的条数（保持现状，下次可重判）。 */
  readonly skipped: number;
  readonly warnings: string[];
}

export interface BackfillStoreFace {
  readonly list: () => readonly StewardMemoryEntry[];
  readonly readMetaIds: (key: string) => ReadonlySet<number>;
  readonly reclassifyMany: SqliteVecMemoryStore["reclassifyMany"];
}

function distribution(entries: readonly StewardMemoryEntry[]): DistRow[] {
  const key = (e: StewardMemoryEntry) => `${e.source}|${e.kind}|${e.domain}|${e.projectScope}`;
  const counts = new Map<string, DistRow>();
  for (const e of entries) {
    const k = key(e);
    const prev = counts.get(k);
    counts.set(k, {
      source: e.source,
      kind: e.kind,
      // 可选形态归一（真库恒携带；缺省 = 迁移缺省语义：habit/global）
      domain: e.domain ?? "habit",
      projectScope: e.projectScope ?? MEMORY_SCOPE_GLOBAL,
      n: (prev?.n ?? 0) + 1,
    });
  }
  return [...counts.values()].sort((a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind) || a.domain.localeCompare(b.domain));
}

/** 批量回填编排：幂等过滤 → 分批判定（批内并发）→ 批事务回写 → 报告。
 *  judge=null（判官缺席）→ aborted 零写入。 */
export async function runBackfill(deps: {
  readonly store: BackfillStoreFace;
  readonly judge: JudgePort | null;
  readonly options?: Partial<BackfillOptions>;
  readonly log?: (line: string) => void;
}): Promise<BackfillReport> {
  const options: BackfillOptions = {
    batchSize: 10,
    projects: DEFAULT_PROJECTS,
    dryRun: false,
    ...deps.options,
  };
  const log = deps.log ?? (() => {});
  const warnings: string[] = [];
  const before = distribution(deps.store.list());
  if (deps.judge === null) {
    return { status: "aborted", reason: "判官缺席（端点未配置/非 classifier）——整批放弃零写入", before, after: before, planned: 0, processed: 0, skipped: 0, warnings };
  }
  const done = deps.store.readMetaIds(BACKFILL_CLASSIFY_MARKER);
  const targets = deps.store
    .list()
    .filter((e) => BACKFILL_SOURCES.has(e.source) && e.kind !== "progress" && !done.has(e.id));
  let processed = 0;
  let skipped = 0;
  for (let offset = 0; offset < targets.length; offset += options.batchSize) {
    const batch = targets.slice(offset, offset + options.batchSize);
    const outcomes = await Promise.all(
      batch.map(async (entry) => ({ entry, outcome: await classifyEntry(deps.judge!, entry.text, options.projects, { warn: (m) => warnings.push(`#${entry.id} ${m}`) }) })),
    );
    const hits = outcomes.flatMap(({ entry, outcome }) =>
      outcome.ok ? [{ id: entry.id, kind: outcome.kind, domain: outcome.domain, projectScope: outcome.projectScope }] : [],
    );
    const misses = outcomes.filter(({ outcome }) => !outcome.ok);
    skipped += misses.length;
    for (const { outcome } of misses) {
      if (!outcome.ok) log(`skip：${outcome.reason}`);
    }
    if (hits.length > 0) {
      processed += options.dryRun ? hits.length : deps.store.reclassifyMany(hits, BACKFILL_CLASSIFY_MARKER);
      log(`批次 ${Math.floor(offset / options.batchSize) + 1}：回写 ${hits.length} 条，skip ${misses.length} 条`);
    } else {
      log(`批次 ${Math.floor(offset / options.batchSize) + 1}：全 skip（零写入）`);
    }
  }
  const after = distribution(deps.store.list());
  return { status: "done", before, after, planned: targets.length, processed, skipped, warnings };
}

// ── 装配与入口（独立进程最小装配——ChildMain 批E 轻量先例同构）──

interface JudgeResolution {
  readonly judge: JudgePort | null;
  readonly reason: string;
}

/** 从 helix.db KV 解析判官端点（memory.judgeEndpointId → embedding_endpoints
 *  记录，kind=classifier 校验——与 StewardMemoryService.judgeEndpointRecord
 *  同判）；经 makeJudgeAdapter 注册表分派（jev 直连 / pi-ai 目录双通道）。 */
function resolveJudge(dbPath: string, paths: ReturnType<typeof createPaths>): JudgeResolution {
  const db = openTaskLedgerDatabase(dbPath);
  try {
    const readKey = (key: string): string | undefined => {
      const row = db.prepare("SELECT value FROM runtime_config WHERE key = ?").get(key) as { value: string } | undefined;
      return row === undefined ? undefined : row.value;
    };
    const judgeEndpointId = readKey("memory.judgeEndpointId");
    if (judgeEndpointId === undefined || judgeEndpointId === "") {
      return { judge: null, reason: "memory.judgeEndpointId 未配置" };
    }
    const record = parseRecords(readKey("embedding_endpoints")).find((r) => r.id === judgeEndpointId) as EmbeddingEndpointRecord | undefined;
    if (record === undefined) {
      return { judge: null, reason: `判官端点记录不存在（${judgeEndpointId}）` };
    }
    if (record.kind !== "classifier") {
      return { judge: null, reason: `端点 ${record.name} 不是 classifier（kind=${record.kind ?? "embedding(缺席)"}）` };
    }
    const authStore = new AuthStore(paths.authPath());
    const models = createModelsBase();
    const catalog = new ModelCatalog({ storePath: paths.modelsStorePath(), models });
    const judge = makeJudgeAdapter(
      () => record,
      { getModels: () => catalog.modelsView(), getApiKey: (provider) => authStore.apiKeyOf(provider) },
    );
    return { judge, reason: "" };
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

function renderDist(title: string, rows: readonly DistRow[]): string {
  const lines = [`${title}`];
  for (const r of rows) {
    lines.push(`  ${r.source.padEnd(16)} ${r.kind.padEnd(10)} ${r.domain.padEnd(8)} ${r.projectScope.padEnd(8)} × ${r.n}`);
  }
  return lines.join("\n");
}

/** main：装配（独立进程最小装配，不起 daemon）→ runBackfill → 报告。 */
async function main(): Promise<void> {
  const home = argValue("--home");
  const paths = createPaths(home);
  const dryRun = hasFlag("--dry-run");
  const batchSize = Number.parseInt(argValue("--batch-size") ?? "10", 10);
  const projects = (argValue("--projects") ?? DEFAULT_PROJECTS.join(",")).split(",").map((s) => s.trim()).filter((s) => s !== "");
  const vec0 = resolveVec0Path({
    bundlePath: process.env.HELIX_VEC_PATH,
    nodeModulesPath: (() => {
      try {
        return getLoadablePath();
      } catch {
        return undefined;
      }
    })(),
    probe: (p) => existsSync(p),
  });
  if (vec0.kind !== "resolved") {
    console.error(`vec0 扩展不可解析：${vec0.reasons.join("；")}`);
    process.exit(1);
  }
  const store = new SqliteVecMemoryStore(paths.stewardMemoryDbPath(), vec0.path);
  try {
    const { judge, reason } = resolveJudge(paths.dbPath(), paths);
    if (judge === null) {
      const entries = store.list();
      console.log(renderDist("判官缺席——整批放弃零写入（现状分布如下）", distribution(entries)));
      console.error(`中止：${reason}`);
      process.exit(1);
    }
    console.log(`判官：${judge.endpointLabel()}（${dryRun ? "DRY-RUN" : "回写模式"}，批大小 ${batchSize}，项目候选 [${projects.join(", ")}]）`);
    const report = await runBackfill({
      store,
      judge,
      options: { batchSize, projects, dryRun },
      log: (line) => console.log(line),
    });
    console.log(renderDist("\n== 前分布（source × kind × domain × scope）==", report.before));
    console.log(renderDist("\n== 后分布 ==", report.after));
    console.log(`\n待判 ${report.planned} 条；回写 ${report.processed} 条；skip ${report.skipped} 条；warn ${report.warnings.length} 条`);
    for (const w of report.warnings) console.log(`  warn：${w}`);
    if (report.status === "aborted") {
      console.error(`中止：${report.reason}`);
      process.exit(1);
    }
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
