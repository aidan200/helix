/**
 * ChildMain —— SubAgent 子进程入口（O-7 候选 A 形态）。
 *
 * 装配即同构（TR-AD-4 零 kind 分支）：复用 PiAgentEngineAdapter（内含
 * AgentRuntime + SubAgentProfile 声明装配），不另起驱动层。流程：
 *
 *   argv/env 解析（--task / HELIX_MODEL_JSON 透传 / HELIX_API_KEYS_JSON /
 * HELIX_TOOL_CWD / HELIX_FAKE_ENGINE_SCRIPT 剧本注入）
 *     → PiAgentEngineAdapter + SubAgentProfile 装配
 *     → started 行（含 pid + model 回显）
 *     → stdin send 行 → engine.steer()（AD-7⑤：Agent.steer() 内建队列）
 *     → 单次驱动 engine.start(task)（single-shot，不进 persistent 循环）
 *     → 最后一条 assistant 文本解析 closure 块（五字段）→ closure 行 → exit(0)
 *     → SIGTERM（O-6 优雅路径）→ abort → failed(terminated) closure → exit(0)
 *     → 任何异常 → crash 行 → exit(1)（父侧崩溃检测判 failed）
 *
 * 本模块只在 `bun run ChildMain.ts` 直跑时执行 main（import.meta.main 守卫，
 * 测试可导入 parseClosureBlock 单测）。
 */
import type { Model } from "@earendil-works/pi-ai";
import { PiAgentEngineAdapter } from "../../pi-engine/PiAgentEngineAdapter";
import { supportsThinkingLevel } from "../../pi-engine/model-provider";
import { SubAgentProfile } from "../../pi-engine/runtime/profiles/SubAgentProfile";
import { CoreToolExecutor, type KgToolOptions } from "../../tools/CoreToolExecutor";
import { encodeLine, parseParentLine } from "../transport/wire";
import type { ChildOutboundLine, SendLine, ToolResponseLine } from "../transport/wire";
import { RemoteBrowserPort } from "./RemoteBrowserPort";
import { loadFakeEngineScript, makeScriptedStreamFn } from "./scriptedEngine";
import type { FakeEngineScript } from "./scriptedEngine";
import type { InstanceClosurePayload } from "../../../../domain/events/DomainEvent";
import { KgDatabase } from "../../sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../sqlite-kg/SqliteKnowledgeStore";
import { KgWriteService } from "../../../../application/services/kg/KgWriteService";
import { KgQueryService } from "../../../../application/services/kg/KgQueryService";
import { existingKgProjects, scanWorkspaceProjects } from "../../workspace-scan";
import { LazyWorkLedger } from "../../sqlite-session/WorkLedger";
import { WorkLedgerService } from "../../../../application/services/task/WorkLedgerService";
import type { PlanToolDeps } from "../../tools/plan/PlanTools";
import { openTaskLedgerDatabase } from "../../sqlite-session/WriteQueue";
import { readTaskContextByInstance } from "../../sqlite-session/TaskStore";

// ── argv/env 解析 ──────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function writeLine(line: ChildOutboundLine): void {
  process.stdout.write(encodeLine(line));
}

// ── closure 块解析（收口协议） ─────────────────────────────

/** closure 块解析结果（五字段，可选字段归一 null——全字段必发纪律）。 */
export interface ParsedClosure {
  readonly status: "done" | "failed";
  readonly summary: string;
  readonly reportPath: string | null;
  readonly findings: unknown[] | null;
  readonly taskId: string | null;
}

/**
 * 从 assistant 文本解析 `<<<CLOSURE {...} CLOSURE>>>` 块。
 * 无块 / 非法 JSON / status 非法 / summary 缺失 → undefined（调用方按
 * 「未按 closure 协议收口」failed 处理）。
 */
export function parseClosureBlock(text: string): ParsedClosure | undefined {
  const match = text.match(/<<<CLOSURE\s*([\s\S]*?)\s*CLOSURE>>>/);
  if (!match) return undefined;
  try {
    const raw = JSON.parse(match[1]!) as {
      status?: unknown;
      summary?: unknown;
      reportPath?: unknown;
      findings?: unknown;
      taskId?: unknown;
    };
    if ((raw.status !== "done" && raw.status !== "failed") || typeof raw.summary !== "string") {
      return undefined;
    }
    return {
      status: raw.status,
      summary: raw.summary,
      reportPath: typeof raw.reportPath === "string" ? raw.reportPath : null,
      findings: Array.isArray(raw.findings) ? raw.findings : null,
      taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    };
  } catch {
    return undefined;
  }
}

// ── closure 兜底摘要（并入 engine 错误原因） ─────────

/**
 * 兜底 closure 摘要组装：有 engine_error 原因时并入
 * 「（engine: <原因>）」段（原因不截断，透传 provider 原文）；无原因时
 * 保持现状格式逐字节不变（非错误轮回归锚定）。80 截断仅施于
 * lastAssistantText。
 */
export function buildFallbackSummary(lastAssistantText: string, lastEngineError: string | undefined): string {
  const reason = lastEngineError !== undefined ? `（engine: ${lastEngineError}）` : "";
  return `未按 closure 协议收口${reason}：${lastAssistantText.slice(0, 80)}`;
}

// ── stdin 父侧行读取（AD-7⑤ send → Agent.steer()；H-3 tool-res → RemoteBrowserPort） ──────

function readStdin(instanceId: string, onLine: (line: SendLine | ToolResponseLine) => void): void {
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of Bun.stdin.stream()) {
        buf += decoder.decode(chunk as Uint8Array);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          const line = parseParentLine(raw);
          if (line) onLine(line);
          else writeLine({ type: "log", instanceId, text: `忽略无法解析的 stdin 行：${raw.slice(0, 60)}` });
        }
      }
    } catch {
      /* stdin 关闭：正常退出路径 */
    }
  })();
}

// ── spawn 快照 env 解析 ───────────────────────

/**
 * 父进程 spawn 快照 env（HELIX_SYSTEM_PROMPT / HELIX_TOOLS_JSON）→ profile
 * 声明面覆盖（组合根在 launch 时刻组装定格透传；快照语义——spawn 后主会话
 * toggle 不影响本实例）。缺席（既有测试形态/未接线）→ 空覆盖，回退
 * SubAgentProfile 静态声明。非法 JSON 抛错（父进程恒写合法 JSON，出现即
 * bug——crash 行可见）。
 */
export function spawnOverridesFromEnv(
  env: Record<string, string | undefined>,
): { systemPrompt?: string; tools?: readonly string[] } {
  const systemPrompt = env["HELIX_SYSTEM_PROMPT"];
  const toolsJson = env["HELIX_TOOLS_JSON"];
  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(toolsJson !== undefined ? { tools: JSON.parse(toolsJson) as string[] } : {}),
  };
}

// ── 子进程本地 kg 栈（T3.3：kg/kg-update 双工具注入面） ─────

/**
 * 子进程本地 kg 栈：独立进程持有自己的 per-project SQLite 连接（WAL +
 * busy_timeout 跨进程安全——父 daemon 与子进程写事务由 SQLite 写锁串行化）。
 * 读面项目域 = 已建 .kg 项目（读面绝不新建库文件）；写面目标解析 =
 * workspace 全扫描。无跨通道会话注册表（任务切片注入在父进程 spawn 时
 * 已完成——本栈只消费）。ChildMain 是子进程的组合根（CoreToolExecutor
 * 同款先例），此处 new 具体 adapter/service 不违 AG-02④ 扫描域（driven）。
 *
 * T4.2（AD-10/AF-T4.1.4）：taskContext 机械注入面——批次子进程的任务归属
 * （jobId/batchId）由 createKgTaskContextResolver 惰性解析，kg-update 三写
 * 路径默认值源；非任务上下文（dbPath 缺席/无批次行）零注入。
 */
function buildLocalKgStack(
  workspaceRoot: string,
  taskContext?: () => { readonly taskId: string; readonly originBatchId: string } | undefined,
): { readonly tools: KgToolOptions; readonly database: KgDatabase } {
  const database = new KgDatabase();
  const graph = new SqliteKnowledgeGraph({ database });
  const query = new KgQueryService({ graph, projects: () => existingKgProjects(workspaceRoot) });
  const write = new KgWriteService({ store: new SqliteKnowledgeStore({ database }) });
  return {
    tools: {
      query,
      write,
      workspaceRoot,
      scanProjects: () => scanWorkspaceProjects(workspaceRoot),
      ...(taskContext !== undefined ? { taskContext } : {}),
    },
    database,
  };
}

// ── 任务归属解析器（T4.2，AD-10 衔接面的接线层兑现） ──────────

/**
 * kg-update 任务归属解析器（机械注入源）：HELIX_DB_PATH + HELIX_INSTANCE_ID
 * 同面（env 通道既有两键，AG-08 零新键）——惰性直连 helix.db 查
 * batch.instance_id = 本实例 → { taskId=jobId, originBatchId=batchId }。
 *
 * 为何子进程侧解析而非父进程 env 透传：批次归属在 spawn 时刻父进程尚不
 * 可知（insertBatch→spawn→dispatchBatch 序——batch.instance_id 在
 * dispatchBatch 才落章，launch 组 env 时为 NULL）；子进程首次 kg-update
 * 时 instance_id 早已落章，惰性查询机械可靠。命中后记忆化；未命中
 * （非任务上下文/极早期竞态）不缓存——下次调用重查（退化为现状 LLM
 * 透传行为，非回归）。dbPath 缺席 → 返回 undefined（零触盘零注入）。
 */
/** kg-update 任务归属上下文（jobId/batchId——change_log.task_id / nodes.origin_batch_id 默认值源）。 */
export interface KgTaskContext {
  readonly taskId: string;
  readonly originBatchId: string;
}

/** 任务归属解析器面（解析 + 连接收尾；惰性未开过 = close no-op）。 */
export type KgTaskContextResolver = (() => KgTaskContext | undefined) & { close(): void };

export function createKgTaskContextResolver(
  dbPath: string | undefined,
  instanceId: string,
): KgTaskContextResolver | undefined {
  if (dbPath === undefined) return undefined;
  let db: ReturnType<typeof openTaskLedgerDatabase> | null = null;
  let resolved: KgTaskContext | undefined;
  const resolve = (() => {
    if (resolved !== undefined) return resolved;
    db ??= openTaskLedgerDatabase(dbPath);
    const hit = readTaskContextByInstance(db, instanceId);
    if (hit !== undefined) resolved = { taskId: hit.jobId, originBatchId: hit.batchId };
    return resolved;
  }) as KgTaskContextResolver;
  resolve.close = () => {
    db?.close();
    db = null;
  };
  return resolve;
}

// ── 子进程本地 work_item 栈（T1.4，AD-6①：plan 三工具注入面） ─────

/**
 * 子进程本地 work_item 栈（buildLocalKgStack 同构）：helix.db 直连
 * （LazyWorkLedger 首次读写才开库——WAL + busy_timeout 由
 * openTaskLedgerDatabase 自设，子连接不依赖父进程设置）+ WorkLedgerService
 * 双面 + plan 三工具装配面。chat/task 两域派出的实例走同一装配（零 kind
 * 分支，AD-6① 统一性）。
 *
 * instanceId 由子进程上下文注入（HELIX_INSTANCE_ID）——工具参数零
 * instanceId（防 LLM 伪造他实例台账）；dbPath 来自 HELIX_DB_PATH（父进程
 * spawn 时注入；缺席 → plan 工具首调报未装配，注册常驻——browser 先例）。
 * 表域由父进程先行建库保证（子进程总是父进程写入 batch.instance_id
 * 后才被拉起；未拉台账调用不触盘，TR-TEST-4）。
 */
export function buildLocalWorkLedgerStack(
  dbPath: string | undefined,
  instanceId: string,
): { readonly tools: PlanToolDeps; readonly ledger: LazyWorkLedger } {
  const ledger = new LazyWorkLedger(dbPath);
  const service = new WorkLedgerService({ reader: ledger, writer: ledger });
  return { tools: { service, instanceId }, ledger };
}

// ── 主流程 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const task = argValue("--task") ?? "";
  const instanceId = process.env.HELIX_INSTANCE_ID ?? "agent-?";
  const modelJson = process.env.HELIX_MODEL_JSON;
  if (!modelJson) throw new Error("缺少 HELIX_MODEL_JSON（父进程未透传完整 Model 对象，F-14）");
  const model = JSON.parse(modelJson) as Model<any>;
  const apiKeys = JSON.parse(process.env.HELIX_API_KEYS_JSON ?? "{}") as Record<string, string>;
  const toolCwd = process.env.HELIX_TOOL_CWD ?? process.cwd();
  // thinking 定格值（AD-1 落点二：父进程 launch 段 resolveThinkingFor 解析
  // 快照，子进程全生命周期只消费定格值——无解析链，与 HELIX_MODEL_JSON
  // 同哲学）；缺席（既有测试形态/旧父进程）→ 不装注入器，行为不变
  const thinkingLevel = process.env.HELIX_THINKING_LEVEL;
  const scriptPath = process.env.HELIX_FAKE_ENGINE_SCRIPT;
  const script: FakeEngineScript | undefined = scriptPath !== undefined ? loadFakeEngineScript(scriptPath) : undefined;

  // 装配（TR-AD-4：与主引擎同一防腐墙同一 runtime，仅 profile 声明不同）
  // spawn 快照 env 覆盖（systemPrompt 三段组装产物 + 生效工具集，
  // launch 时刻定格）；缺席回退 SubAgentProfile 静态声明面
  const spawnOverrides = spawnOverridesFromEnv(process.env as Record<string, string | undefined>);
  const profile: typeof SubAgentProfile = {
    ...SubAgentProfile,
    ...(spawnOverrides.systemPrompt !== undefined ? { systemPrompt: spawnOverrides.systemPrompt } : {}),
    ...(spawnOverrides.tools !== undefined ? { tools: spawnOverrides.tools } : {}),
  };
  // H-3：browser 工具经 wire 转发通道接入 daemon 全局唯一 CDP 单例
  // （子进程零 CDP 知识/零连接状态；ownerId = 本实例 instanceId）
  const remoteBrowser = new RemoteBrowserPort(instanceId, writeLine);
  // T3.3：kg/kg-update 双工具本地栈（子进程组合根装配——SubAgentProfile
  // 声明两名，未注册则 resolveTools fail-fast）
  // T4.2：任务归属解析器（HELIX_DB_PATH 同面；批次子进程命中 batch 行 →
  // kg-update taskId/originBatchId 机械注入；非任务上下文零注入）
  const taskContext = createKgTaskContextResolver(process.env.HELIX_DB_PATH, instanceId);
  const kg = buildLocalKgStack(toolCwd, taskContext);
  // T1.4：plan 三工具本地栈（AD-6① 全量配给——SubAgentProfile 声明三名；
  // HELIX_DB_PATH 缺席时注册常驻、首调报未装配）
  const workLedger = buildLocalWorkLedgerStack(process.env.HELIX_DB_PATH, instanceId);
  const executor = new CoreToolExecutor({
    cwd: toolCwd,
    browser: remoteBrowser,
    ownerId: instanceId,
    kg: kg.tools,
    plan: workLedger.tools,
  });
  const engine = new PiAgentEngineAdapter({
    profile,
    model, // env JSON 解析的完整对象透传（与父侧深度相等）
    apiKeys,
    ...(script ? { streamFnOverride: makeScriptedStreamFn(script, model) } : {}),
    // §3.5 装配点 2：定格值 + 能力过滤（§3.3 同构——定格值不被模型支持
    // → undefined → 注入器不动 options）。包装在 adapter 内 override 外侧，
    // fake 剧本通道不被破坏（注入器包裹 fake streamFn，剧本可捕获 reasoning）
    ...(thinkingLevel !== undefined
      ? { resolveThinking: (m: Model<any>) => (supportsThinkingLevel(m, thinkingLevel) ? thinkingLevel : undefined) }
      : {}),
    resolveTools: (names) => executor.resolveTools(names),
  });

  // O-6 优雅路径：SIGTERM → abort 当前 run → drive 收敛 → failed closure → exit(0)
  let terminated = false;
  process.on("SIGTERM", () => {
    terminated = true;
    engine.abort();
  });

  let lastAssistantText = "";
  let lastEngineError: string | undefined; // 多轮错误取末条 engine_error message（单变量覆盖）
  writeLine({ type: "started", instanceId, pid: process.pid, model });
  readStdin(instanceId, (line) => {
    if (line.type === "send") engine.steer(line.text); // AD-7⑤：Agent.steer() 内建队列
    else remoteBrowser.handleResponse(line); // H-3：tool-res → pending 关联 settle
  });

  // single-shot：驱动一次 run（含 steer drain 轮），结束即收口
  await engine.start(task, (event) => {
    if (event.type === "message_end" && event.role === "assistant" && event.stopReason !== "error") {
      lastAssistantText = event.text;
    }
    if (event.type === "engine_error") {
      lastEngineError = event.message;
    }
    writeLine({ type: "event", instanceId, event });
  });

  // H-3：退出清场——abort/异常中断的在飞转发请求统一拒绝（定时器同清）
  remoteBrowser.rejectAll("子进程退出清场");

  const closure: InstanceClosurePayload = terminated
    ? {
        status: "failed",
        summary: "terminated by user（SIGTERM）",
        reportPath: null,
        findings: null,
        taskId: null,
      }
    : (parseClosureBlock(lastAssistantText) ?? {
        status: "failed",
        summary: buildFallbackSummary(lastAssistantText, lastEngineError),
        reportPath: null,
        findings: null,
        taskId: null,
      });
  writeLine({ type: "closure", instanceId, closure });
  kg.database.closeAll(); // 正常收尾关连接（崩溃路径走 WAL 恢复，无需显式关）
  workLedger.ledger.close(); // T1.4：台账直连连接同单点收尾（惰性未开过 = no-op）
  taskContext?.close(); // T4.2：任务归属解析器直连连接同收尾（惰性未开过 = no-op）
  process.exit(0);
}

/**
 * 子进程入口（两形态同一路径）：dev = bun 直跑本文件（import.meta.main
 * 守卫）或经 main.ts `--child-main` argv 分发；compile 产物 = 内嵌 main.ts
 * 分发（main.ts 与本文件同 bundle，spawn 自身产物重入）。
 */
export function runChildMainEntry(): void {
  main().catch((err) => {
    process.stdout.write(
      encodeLine({
        type: "crash",
        instanceId: process.env.HELIX_INSTANCE_ID ?? "agent-?",
        error: err instanceof Error ? err.message : String(err),
      } satisfies ChildOutboundLine),
    );
    process.exit(1);
  });
}

if (import.meta.main) {
  runChildMainEntry();
}
