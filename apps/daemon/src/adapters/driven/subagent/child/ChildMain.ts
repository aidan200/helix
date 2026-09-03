/**
 * ChildMain —— SubAgent 子进程入口（O-7 候选 A 形态）。
 *
 * 装配即同构（TR-AD-4 零 kind 分支）：复用 PiAgentEngineAdapter（内含
 * AgentRuntime + SubAgentProfile 声明装配），不另起驱动层。流程：
 *
 *   argv/env 解析（--task / HELIX_MODEL_JSON 透传 / HELIX_API_KEYS_JSON /
 * HELIX_TOOL_CWD / HELIX_FAKE_ENGINE_SCRIPT 剧本注入）
 *     → PiAgentEngineAdapter + SubAgentProfile 装配（+ ParkGuardHooks 挂起硬拦截）
 *     → started 行（含 pid + model 回显）
 *     → stdin send 行 → 协议指令分派（park/resume 标记）或 Agent.steer()
 *     → 单次驱动 engine.start(task)（single-shot，不进 persistent 循环）
 *     → park/resume 循环（⑤ park/resume 批）：run 结束点检测
 *       <<<PARK {...} PARK>>> 标记 → parked 行上行 + 挂起等待（不收口不退出）
 *       → RESUME 注入唤醒 → continueRun 续跑（同一会话，PARK 摘要在对话
 *       历史 + 暂存 steer 随 run drain）→ 可多次挂起/恢复
 *     → 最后一条 assistant 文本解析 closure 块（五字段）→ closure 行 → exit(0)
 *     → SIGTERM（O-6 优雅路径）→ abort / 唤醒挂起等待 → failed(terminated)
 *       closure → exit(0)
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
import { ParkGuardHooks } from "./ParkGuardHooks";
import {
  isParkInstruction,
  isResumeInstruction,
  parseParkBlock,
} from "../../../../application/services/scheduler/parkProtocol";
import { loadFakeEngineScript, makeScriptedStreamFn } from "./scriptedEngine";
import type { FakeEngineScript } from "./scriptedEngine";
import type { InstanceClosurePayload } from "../../../../domain/events/DomainEvent";
import { KgDatabase } from "../../sqlite-kg/KgDatabase";
import type { AgentEngineEvent } from "../../../../application/ports/outbound/AgentEnginePort";
import { SqliteKnowledgeGraph } from "../../sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../sqlite-kg/SqliteKnowledgeStore";
import { KgWriteService } from "../../../../application/services/kg/KgWriteService";
import { KgQueryService } from "../../../../application/services/kg/KgQueryService";
import { kgReadProjects, scanWorkspaceProjects } from "../../workspace-scan";
import { LazyWorkLedger } from "../../sqlite-session/WorkLedger";
import { WorkLedgerService } from "../../../../application/services/task/WorkLedgerService";
import type { PlanToolDeps } from "../../tools/plan/PlanTools";
import { openTaskLedgerDatabase } from "../../sqlite-session/WriteQueue";
import { readTaskContextByInstance } from "../../sqlite-session/TaskStore";
import { accessSync, constants as fsConstants } from "node:fs";
import { CodegraphEngineAdapter } from "../../codegraph-engine/CodegraphEngineAdapter";
import { resolveCodegraphPath } from "../../codegraph-engine/resolve-codegraph";

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
 *
 * 闭标记容错（task-778eb18a 三连败修复）：provider SSE 丢尾 delta 会
 * 精确截掉最后一个字符（6 样本 5 截，`CLOSURE>>>` → `CLOSURE>>`）——
 * 闭标记放宽为 ≥2 个 `>`，信封残缺但信件（JSON）完整即接受；开标记
 * 保持恰好 3 个 `<` 不放宽（报告/正文讨论协议的字面示例不误收口），
 * JSON 合法性仍是从严门梣（残缺标记 + 非法 JSON 照拒）。
 */
export function parseClosureBlock(text: string): ParsedClosure | undefined {
  const match = text.match(/<<<CLOSURE\s*([\s\S]*?)\s*CLOSURE>{2,}/);
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

// ── stdin 父侧行读取（AD-7⑤ send → Agent.steer()；H-3 tool-res → RemoteBrowserPort；
//      park/resume 协议指令分派 → 挂起标志/唤醒） ──────

/** 协议指令分派结果（readStdin 消费面）。 */
interface StdinDispatch {
  /** park 请求到达（置挂起标志 + steer 指令）。 */
  onPark: (text: string) => void;
  /** resume 到达（清挂起标志 + steer 指令 + 唤醒挂起等待）。 */
  onResume: (text: string) => void;
  /** 普通注入（含挂起期暂存——steer 队列内建缓冲，resume run 一并 drain）。 */
  onSteer: (text: string) => void;
}

function readStdin(instanceId: string, dispatch: StdinDispatch, onToolRes: (line: ToolResponseLine) => void): void {
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
          if (line) {
            if (line.type === "tool-res") onToolRes(line);
            else if (isParkInstruction(line.text)) dispatch.onPark(line.text);
            else if (isResumeInstruction(line.text)) dispatch.onResume(line.text);
            else dispatch.onSteer(line.text);
          } else writeLine({ type: "log", instanceId, text: `忽略无法解析的 stdin 行：${raw.slice(0, 60)}` });
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
  // W-R3 读穿透（D8）：toolCwd 在 .worktrees 下 → 读面只读直读主仓 kg.db
  //（kgReadProjects 归一）；写面 scanProjects 仍原口径（kg-update 行为本任务不改）。
  const query = new KgQueryService({ graph, projects: () => kgReadProjects(workspaceRoot) });
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

// ── 子进程本地 codegraph 栈（W1-B，R5/R7：codegraph 工具注入面） ─────

/**
 * 子进程本地 codegraph 栈：与 buildLocalKgStack 同构——ChildMain 是子进程
 * 组合根（new 具体 adapter 不违 AG-02④ 扫描域）。二进制三级解析缺
 * config 级（子进程不读 config.json）——父进程定格路径经
 * HELIX_CODEGRAPH_PATH env 透传补齐（bundle 级命中）。
 * 解析失败 → binaryPath=null（工具仍在，调用 degraded EngineUnavailable，
 * 不阻断子进程装配）。workspaceRoot = toolCwd（同 kg 栈口径）。
 */
function buildLocalCodegraphStack(workspaceRoot: string): { readonly engine: CodegraphEngineAdapter; readonly workspaceRoot: string } {
  const resolution = resolveCodegraphPath({
    bundlePath: process.env.HELIX_CODEGRAPH_PATH,
    probe: isExecutableFile,
  });
  return {
    engine: new CodegraphEngineAdapter({ binaryPath: resolution.kind === "resolved" ? resolution.path : null }),
    workspaceRoot,
  };
}

/** 可执行文件探测（container.ts 同款：抛错一律视为不可用）。 */
function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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
  // T3.3：kg/kg-update 双工具本地栈（子进程组合根装配——D8 W-R6 后
  // subagent-worker 只声明 kg、subagent-kg-writer（图谱产出型批次）声明双工具；
  // 注册面恒宽（声明面管控谁可见）
  // T4.2：任务归属解析器（HELIX_DB_PATH 同面；批次子进程命中 batch 行 →
  // kg-update taskId/originBatchId 机械注入；非任务上下文零注入）
  const taskContext = createKgTaskContextResolver(process.env.HELIX_DB_PATH, instanceId);
  const kg = buildLocalKgStack(toolCwd, taskContext);
  // W1-B：codegraph 只读工具本地栈（SubAgentProfile 声明该名；二进制不可达
  // → degraded 不阻断装配，同 ensureIndex degraded 先例）
  const codegraph = buildLocalCodegraphStack(toolCwd);
  // T1.4：plan 三工具本地栈（AD-6① 全量配给——SubAgentProfile 声明三名；
  // HELIX_DB_PATH 缺席时注册常驻、首调报未装配）
  const workLedger = buildLocalWorkLedgerStack(process.env.HELIX_DB_PATH, instanceId);
  const executor = new CoreToolExecutor({
    cwd: toolCwd,
    browser: remoteBrowser,
    ownerId: instanceId,
    kg: kg.tools,
    codegraph,
    plan: workLedger.tools,
    // grep rg 单后端：父进程定格路径经 HELIX_RG_PATH env 透传（SubagentLauncher
    // 显式注入或形态 env 继承——bundle 级）；缺席 → 门面响亮失败（无 TS 兜底）
    grep: { rgPath: process.env.HELIX_RG_PATH },
  });
  // ⑤ park/resume 批：挂起协议子进程侧状态（共享对象——stdin 读取器写、
  // ParkGuardHooks 读；P6 双保险：标志位即硬拦截输入）
  const parkState = { parkRequested: false };
  /** 挂起等待唤醒器（parked 循环内量；RESUME/SIGTERM 解除）。 */
  let parkedWake: (() => void) | undefined;
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
    // ⑤ park/resume 批：挂起硬拦截入链（R12 预留位首个实例）
    extraHooks: [new ParkGuardHooks(parkState)],
  });

  // O-6 优雅路径：SIGTERM → abort 当前 run / 唤醒挂起等待 → drive 收敛 →
  // failed closure → exit(0)
  let terminated = false;
  process.on("SIGTERM", () => {
    terminated = true;
    parkState.parkRequested = false; // 终止路径解除拦截（收尾无新工具）
    parkedWake?.(); // 挂起等待唤醒 → failed(terminated) closure 路径
    engine.abort();
  });

  let lastAssistantText = "";
  let lastEngineError: string | undefined; // 多轮错误取末条 engine_error message（单变量覆盖）
  /** 引擎事件回调（start/continueRun 同一翻译链：上行 + 末条 assistant 跟踪）。 */
  const onEngineEvent = (event: AgentEngineEvent) => {
    if (event.type === "message_end" && event.role === "assistant" && event.stopReason !== "error") {
      lastAssistantText = event.text;
    }
    if (event.type === "engine_error") {
      lastEngineError = event.message;
    }
    // P2 ⑦：网络重试等待可观测（stderr inherit 直达 daemon 日志——子进程无
    // 注入 logger，console 走既有 stderr 通道；父侧另有 engine.retrying 领域事件）
    if (event.type === "engine_retrying") {
      console.warn(
        `[subagent:${instanceId}] LLM 网络重试（第 ${event.attempt}/${event.totalAttempts} 次，约 ${Math.round(event.waitMs / 1000)}s 后）：${event.message}`,
      );
    }
    writeLine({ type: "event", instanceId, event });
  };
  writeLine({ type: "started", instanceId, pid: process.pid, model });
  readStdin(
    instanceId,
    {
      // park 指令：置挂起标志（硬拦截立即生效——在飞工具完成后新调用一律拒）
      // + 指令 steer 入队（协作式第一层：turn 边界 drain 为新 turn）
      onPark: (text) => {
        parkState.parkRequested = true;
        engine.steer(text);
      },
      // resume 指令：清拦截标志（复活）+ 指令 steer 入队（continue 的 drain
      // 首条 user 消息）+ 唤醒挂起等待
      onResume: (text) => {
        parkState.parkRequested = false;
        engine.steer(text);
        parkedWake?.();
      },
      onSteer: (text) => engine.steer(text), // AD-7⑤：Agent.steer() 内建队列（挂起期即暂存）
    },
    (line) => remoteBrowser.handleResponse(line), // H-3：tool-res → pending 关联 settle
  );

  // single-shot：驱动一次 run（含 steer drain 轮）
  await engine.start(task, onEngineEvent);

  // ⑤ park/resume 批：挂起/恢复循环——run 结束点检测 PARK 标记（协作式第一
  // 层）。挂起等待不收口不退出（进程驻留、上下文在内存、零 token）；RESUME
  // 唤醒后 continueRun 从断点续跑（PARK 摘要已在对话历史，暂存 steer 随 run
  // drain）。可多次挂起/恢复；无标记/terminated → 走收口路径。
  while (!terminated) {
    const parked = parseParkBlock(lastAssistantText);
    if (parked === undefined) break; // 无挂起标记：正常收口
    writeLine({ type: "parked", instanceId, summary: parked });
    await new Promise<void>((resolve) => {
      parkedWake = resolve;
    });
    parkedWake = undefined;
    if (terminated) break; // SIGTERM 唤醒：走收口路径（failed terminated）
    await engine.continueRun(onEngineEvent); // 恢复续跑（同一会话）
  }

  // H-3：退出清场——abort/异常中断的在飞转发请求统一拒绝（定时器同清）
  remoteBrowser.rejectAll("子进程退出清场");

  // 任务归属机械注入（缺口修复）：closure 的 taskId 缺省回落本实例归属 jobId——
  // 与 kg-update 工具 taskContext 同源；LLM 显式写优先，缺省机械注入（kg-review
  // SOP「接线层机械注入，LLM 无需透传」的兑现）；非任务上下文零注入。
  const resolvedTask = taskContext?.();
  // closure 块预解析（兜底在组装前 await——process.exit 不等未决 Promise）
  const parsedClosure = terminated ? undefined : parseClosureBlock(lastAssistantText);
  // closure done 收口前机械兑底（task-8659b320 三连败修复）：实例忘
  // plan_update 标记收口项（in_progress 悬置）时，父进程判据②会
  // failBatch → 重试耗尽全损。closure done = 实例已自证完成，此处只兑
  // 「忘标记」的 in_progress（带机械 note 可追溯）；pending（声明未开工）
  // 不兑——真漏做照旧未决。同步写，writeLine 前完成可见。
  if (parsedClosure?.status === "done") {
    try {
      const out = await workLedger.tools.service.forceResolveInProgress(
        instanceId,
        "closure done 机械兑底（实例未逐项标记，收口前置机械补标）",
      );
      if (out.resolved > 0) {
        writeLine({ type: "log", instanceId, text: `closure 兑底：${out.resolved} 项 in_progress 机械补标 done` });
      }
    } catch (err) {
      writeLine({ type: "log", instanceId, text: `closure 兑底失败（照常上送 closure，父侧判据裁决）：${(err as Error).message}` });
    }
  }
  const closure: InstanceClosurePayload = terminated
    ? {
        status: "failed",
        summary: "terminated by user（SIGTERM）",
        reportPath: null,
        findings: null,
        taskId: resolvedTask?.taskId ?? null,
      }
    : parsedClosure === undefined
      ? {
          status: "failed",
          summary: buildFallbackSummary(lastAssistantText, lastEngineError),
          reportPath: null,
          findings: null,
          taskId: resolvedTask?.taskId ?? null,
        }
      : { ...parsedClosure, taskId: parsedClosure.taskId ?? resolvedTask?.taskId ?? null };
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
