import type { CodegraphEnginePort } from "../../../application/ports/outbound/CodegraphEnginePort";
import type { EngineUnavailableInfo, IndexFreshness, SymbolSet } from "../../../domain/kg/types";
import { rm } from "node:fs/promises";
import { CODEGRAPH_SCHEMA_MAX_VERSION, codegraphDbPath, codegraphDirPath, projectCodegraphSymbols } from "./codegraph-db-projection";

export { CODEGRAPH_SCHEMA_MAX_VERSION };

/**
 * CodegraphEngineAdapter —— codegraph 引擎被动封装（T2.1/AF-2 裁决，
 * AD-8 引擎降位 + AD-15 调度权反转）。
 *
 * 被动模式（AF-2 机械细则）：只调一次性命令 status/init/index/sync，每次
 * 调用即起即退（spawn 子进程跑完收集退出码/stdout）；**代码层不提供**
 * serve --mcp / daemon / watch 调用面（与被动模式相悖的禁用面）。
 *
 * 构建路由（以真实 CLI 契约为准，22 命令面实测）：
 * - `status -j <root>` 探测：未初始化返回 `{initialized:false}` exit 0；
 * - 未初始化 → `init <root>`（全量首建——真实 CLI 的 `index` 拒绝未初始化
 *   项目，init 是唯一建库入口；stdin=ignore 使 CLI 尾部交互提示自动取消）；
 * - 已初始化且索引健康 → `sync -q <root>`（增量：size+mtime 预过滤→SHA256）；
 * - 索引截断（index.state=partial/indexing/failed）或 reindexRecommended →
 *   `index -q <root>`（全量重建—— poisoned/截断索引不进投影）。
 *
 * degraded 三入口统一抛 EngineUnavailable（二进制不可达/子进程失败或超时/
 * 投影面 schema 超限或缺表或库缺失）；exportSymbols 与二进制解耦（只读
 * 直连 db，构建面降级不阻断已建索引的投影）。
 */
export class CodegraphEngineAdapter implements CodegraphEnginePort {
  private readonly binaryPath: string | null;
  private readonly timeoutMs: number;

  constructor(opts: { binaryPath: string | null; timeoutMs?: number }) {
    this.binaryPath = opts.binaryPath;
    this.timeoutMs = opts.timeoutMs ?? CODEGRAPH_COMMAND_TIMEOUT_MS;
  }

  async ensureIndex(projectRoot: string): Promise<IndexFreshness> {
    const binaryPath = this.requireBinary();
    const status = await this.runCli(binaryPath, ["status", "-j", projectRoot], "status 探测失败");
    let parsed: CliStatus;
    try {
      parsed = JSON.parse(status.stdout.trim()) as CliStatus;
    } catch (e) {
      throw new EngineUnavailableError(`status -j 输出非 JSON（${brief(e)}）`);
    }
    if (typeof parsed.initialized !== "boolean") {
      throw new EngineUnavailableError("status -j 输出缺 initialized 布尔字段");
    }
    if (!parsed.initialized) {
      // 全量首建（init = 真实 CLI 唯一建库入口）
      await this.runCli(binaryPath, ["init", projectRoot], "init 全量首建失败");
      return { initialized: true, mode: "init", lastIndexed: null };
    }
    const lastIndexed = typeof parsed.lastIndexed === "string" ? parsed.lastIndexed : null;
    const indexState = parsed.index?.state;
    const reindexRecommended = parsed.index?.reindexRecommended === true;
    if (reindexRecommended || indexState === "partial" || indexState === "indexing" || indexState === "failed") {
      // 截断/陈旧索引 → 全量重建（增量 sync 会把截断态带进投影）
      await this.runCli(binaryPath, ["index", "-q", projectRoot], "index 全量重建失败");
      return { initialized: true, mode: "index", lastIndexed };
    }
    await this.runCli(binaryPath, ["sync", "-q", projectRoot], "sync 增量失败");
    return { initialized: true, mode: "sync", lastIndexed };
  }

  async exportSymbols(projectRoot: string): Promise<SymbolSet> {
    try {
      return projectCodegraphSymbols(codegraphDbPath(projectRoot));
    } catch (e) {
      // 库缺失/schema 门/缺表/只读打开失败 → 统一 degraded（绝不写/迁移）
      throw new EngineUnavailableError(`只读投影失败：${brief(e)}`);
    }
  }

  /**
   * 删除项目索引目录（kg.index.delete 消费，C1）：`<projectRoot>/.codegraph`
   * 整目录递归删除；幂等（目录不存在 = no-op）。纯文件系统操作不经 CLI
   * （被动模式无 delete 命令面）；kg 侧状态复位由调用方（KgMaintenanceService）
   * 编排，本方法只管目录。
   */
  async deleteIndex(projectRoot: string): Promise<void> {
    await rm(codegraphDirPath(projectRoot), { recursive: true, force: true });
  }

  /** 二进制不可达（resolve 三级全 miss）→ degraded 第一入口。 */
  private requireBinary(): string {
    if (this.binaryPath === null) {
      throw new EngineUnavailableError("codegraph 二进制不可达（resolve 三级全 miss）");
    }
    return this.binaryPath;
  }

  /** 一次性子进程调用：超时 kill；非零退出/启动失败 → EngineUnavailable。 */
  private async runCli(binaryPath: string, args: string[], failLabel: string): Promise<{ exitCode: number; stdout: string }> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      // stdin=ignore：CLI 尾部交互提示（init 的 watch 回退选择等）收到 EOF
      // 即取消跳过——被动调用永不因等待交互输入而挂起。
      proc = Bun.spawn([binaryPath, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      throw new EngineUnavailableError(`${failLabel}：子进程启动失败（${brief(e)}）`);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, this.timeoutMs);
    let exitCode: number | null = null;
    let stdout = "";
    try {
      const [out, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      stdout = out;
      exitCode = code;
    } catch (e) {
      throw new EngineUnavailableError(`${failLabel}：子进程收集失败（${brief(e)}）`);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      throw new EngineUnavailableError(`${failLabel}：子进程超时（${this.timeoutMs}ms，已 kill）`);
    }
    if (exitCode !== 0) {
      throw new EngineUnavailableError(`${failLabel}：退出码 ${exitCode}`);
    }
    return { exitCode, stdout };
  }
}

/** 被动命令超时保护（brief：如 120s；超时 = degraded）。 */
export const CODEGRAPH_COMMAND_TIMEOUT_MS = 120_000;

/** status -j 输出面（本适配器消费的字段子集）。 */
interface CliStatus {
  initialized?: unknown;
  lastIndexed?: unknown;
  index?: { state?: string; reindexRecommended?: boolean };
}

/**
 * 引擎不可用统一降级信号（AF-2 三入口）。application 层（T2.2）按
 * `kind === "EngineUnavailable"` 鸭子判别（domain 定义 tag 形状，
 * 免跨层 import 本类，TR-AD-1）。
 */
export class EngineUnavailableError extends Error implements EngineUnavailableInfo {
  readonly kind = "EngineUnavailable" as const;
  constructor(readonly reason: string) {
    super(reason);
    this.name = "EngineUnavailableError";
  }
}

function brief(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
