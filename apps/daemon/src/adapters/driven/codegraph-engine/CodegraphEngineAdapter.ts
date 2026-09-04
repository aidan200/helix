import type { CodegraphEnginePort, CodegraphQueryRequest } from "../../../application/ports/outbound/CodegraphEnginePort";
import type { EngineUnavailableInfo, IndexFreshness, SymbolSet } from "../../../domain/kg/types";
import { rm } from "node:fs/promises";
import { CODEGRAPH_SCHEMA_MAX_VERSION, codegraphDbPath, codegraphDirPath, projectCodegraphSymbols } from "./codegraph-db-projection";

export { CODEGRAPH_SCHEMA_MAX_VERSION };

/**
 * CLI spawn 命令组装（TR-95 windows-x64 兼容面）：win32 上 .cmd/.bat launcher
 * （codegraph windows bundle 的 bin/codegraph.cmd）不是可执行映像，
 * CreateProcess 直起必抛 ENOENT——经 cmd.exe /d /s /c 包装（含空格路径逐参
 * 双引号包裹）。posix / 非脚本二进制原样直通（零行为变化）。
 */
export function cliSpawnCmd(
  binaryPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(binaryPath)) {
    return [binaryPath, ...args];
  }
  const quote = (s: string): string => (/[ \t"&|^<>%]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["cmd.exe", "/d", "/s", "/c", [quote(binaryPath), ...args.map(quote)].join(" ")];
}

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

  /**
   * 只读查询面（W1-B，R5/R6）：六 op → 一次性 CLI 子命令（即起即退，同
   * ensureIndex 被动模式）；stdout 截断保护后返回。**零写面子命令**——
   * 建索引永远走 ensureIndex 构建路由，本面连 status 探测都不会触发 init。
   */
  async runQuery(projectRoot: string, request: CodegraphQueryRequest): Promise<string> {
    const binaryPath = this.requireBinary();
    const { stdout } = await this.runCli(binaryPath, queryCliArgs(projectRoot, request), `${request.op} 查询失败`);
    return truncateQueryOutput(stdout);
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
      proc = Bun.spawn(cliSpawnCmd(binaryPath, args), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
    let stderr = "";
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      stdout = out;
      stderr = err;
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
      const errSnippet = stderr.trim().slice(0, 200);
      throw new EngineUnavailableError(
        `${failLabel}：退出码 ${exitCode}${errSnippet !== "" ? `（stderr：${errSnippet}）` : ""}`,
      );
    }
    return { exitCode, stdout };
  }
}

/** 查询面输出上限（W1-B：防失控输出撑爆 agent 上下文；超出截断 + 标记）。 */
export const CODEGRAPH_QUERY_MAX_OUTPUT_CHARS = 50_000;

/** 输出截断：超 cap 截断并附标记（agent 可见，可改用小 limit/depth 重查）。 */
function truncateQueryOutput(stdout: string): string {
  if (stdout.length <= CODEGRAPH_QUERY_MAX_OUTPUT_CHARS) return stdout;
  return `${stdout.slice(0, CODEGRAPH_QUERY_MAX_OUTPUT_CHARS)}\n…（输出已截断，超 ${CODEGRAPH_QUERY_MAX_OUTPUT_CHARS} 字符——用 limit/depth 收窄后重查）`;
}

/**
 * 六 op → CLI argv 映射（真实 CLI 契约实测：status/query/callers/callees/
 * impact 有 -j JSON 面；node 为文本面，无 -j——输出即 MCP codegraph_node
 * 同形文本）。项目路径：status 走位置参数（与 ensureIndex 探测同形），
 * 查询四命令走 -p。
 */
function queryCliArgs(projectRoot: string, request: CodegraphQueryRequest): string[] {
  switch (request.op) {
    case "status":
      return ["status", "-j", projectRoot];
    case "search": {
      const args = ["query", request.pattern, "-j", "-p", projectRoot];
      if (request.kind !== undefined) args.push("-k", request.kind);
      if (request.limit !== undefined) args.push("-l", String(request.limit));
      return args;
    }
    case "node": {
      const args = ["node"];
      if (request.file !== undefined) {
        args.push("-f", request.file);
        if (request.symbol !== undefined) args.push(request.symbol); // 符号定位钉到文件（CLI：name + -f 同给 = 文件内符号）
      } else if (request.symbol !== undefined) {
        args.push(request.symbol);
      }
      args.push("-p", projectRoot);
      if (request.offset !== undefined) args.push("--offset", String(request.offset));
      if (request.limit !== undefined) args.push("--limit", String(request.limit));
      if (request.symbolsOnly === true) args.push("--symbols-only");
      return args;
    }
    case "callers":
    case "callees": {
      const args = [request.op, request.symbol, "-j", "-p", projectRoot];
      if (request.limit !== undefined) args.push("-l", String(request.limit));
      return args;
    }
    case "impact": {
      const args = ["impact", request.symbol, "-j", "-p", projectRoot];
      if (request.depth !== undefined) args.push("-d", String(request.depth));
      return args;
    }
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
