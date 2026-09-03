/**
 * E 层 daemon launcher（TS3/TS4）—— **必须以 bun 运行**（Playwright Node 进程
 * 无法 import Bun.serve / bun:sqlite）。由 e2e/harness/daemon-fixture.ts 以
 * 子进程方式 spawn，stdout 控制行协议：
 *
 *   ##HELIX-DAEMON## ready {"port":<n>}
 *   ##HELIX-DAEMON## stopped          （SIGTERM 优雅收尾后）
 *   ##HELIX-DAEMON## fatal <message>  （装配失败；进程退出码 1）
 *
 * 装配复用 apps/daemon/test/integration 既有模式（container.test.ts 的
 * createDaemon + test-profile/tools-loop 的 FakeLLM 注入）：
 * - PiAgentEngineAdapter + streamFnOverride（剧本化 FakeLLM，无网络无真实 key）；
 * - CoreToolExecutor 指向 fixture 准备的 tmp 沙箱 cwd（工具真实执行）；
 * - --home tmp（TR-TEST-4：真实 ~/.helix 零触碰）+ 可指定端口（防撞 7333）；
 * - SIGTERM → daemon.shutdown()（drain 写队列 + 释放锁）→ 退出（TS4 优雅变体）。
 *
 * 本文件是测试基建（不属于生产路径）；daemon src 只读引用。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import * as path_posix from "node:path";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { CdpConnectionManager } from "../../src/adapters/driven/cdp/CdpConnectionManager";
import { buildModels } from "../../src/adapters/driven/pi-engine/model-provider";
import type { InstanceRunner, InstanceRunnerCallbacks, InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import type { AgentOrchestrationPort, SpawnOutcome, SendOutcome, KillOutcome, AgentInstanceStatus } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { DaemonScript, DaemonScriptEntry, SubagentScript, OrchestratorScript, OrchestratorScriptEntry } from "../../../../e2e/harness/daemon-script";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

// ── CLI 参数 ────────────────────────────────────────────────

function argOf(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const home = argOf("--home");
const port = Number(argOf("--port") ?? "0");
const scriptPath = argOf("--script");
const subagentScriptPath = argOf("--subagent-script");
const subagentEngineScriptPath = argOf("--subagent-engine-script");
const staticDir = argOf("--static-dir");
const toolCwd = argOf("--tool-cwd");
const orchestratorScriptPath = argOf("--orchestrator-script");
const kgWorkspaceRoot = argOf("--kg-workspace-root");

if (!home || !scriptPath || !Number.isFinite(port)) {
  console.error("##HELIX-DAEMON## fatal 用法: launcher.ts --home <dir> --port <n> --script <json> [--subagent-script <json>] [--static-dir <dir>] [--tool-cwd <dir>] [--orchestrator-script <json>] [--kg-workspace-root <dir>]");
  process.exit(1);
}

// ── FakeLLM（M2 级 mock；与 tools-loop.test.ts 的 makeToolScriptedLLM 同构，
//    增加 reply 的逐段流式分片——制造可观测的 streaming / steer 窗口）────

const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages" as Api,
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const fakeModels = {
  getModel: (provider: string, id: string) =>
    provider === "fake" && id === "model" ? fakeModel : undefined,
  getModels: (provider: string) => (provider === "fake" ? [fakeModel] : []),
  streamSimple: () => {
    throw new Error("不应走到真实流（streamFnOverride 未生效）");
  },
} as unknown as Models;

function baseAssistant(content: AssistantMessage["content"], stopReason: string, usage?: AssistantMessage["usage"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fake",
    model: "model",
    usage: usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 带 thinking 块的回复消息（T5.3 R4）：usage 附 reasoning=7 / totalTokens=9
 *  （与剧本每轮固定用量同风格——reasoning 维度可断言且数值可预期）。 */
function thinkingTextMessage(thinking: string, text: string): AssistantMessage {
  return baseAssistant(
    [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
    "stop",
    { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 7, totalTokens: 9, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  );
}

/** 带思考块的纯文本回复（无 thinking 参数时退化为纯文本）。 */
function textMessage(text: string, thinking?: string): AssistantMessage {
  if (thinking !== undefined && thinking !== "") return thinkingTextMessage(thinking, text);
  return baseAssistant([{ type: "text", text }], "stop");
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return baseAssistant([{ type: "toolCall", id, name, arguments: args }], "toolUse");
}

/** provider 失败消息（终验热修）：空 content + stopReason=error + errorMessage
 *  + 全零 usage——与真实失败形态逐字段对齐（pi-ai 429 路径实测形状）。 */
function errorMessage(text: string): AssistantMessage {
  const m = baseAssistant([], "error", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  (m as AssistantMessage & { errorMessage?: string }).errorMessage = text;
  return m;
}

/** context 中全部 toolResult 文本（结果回注可观测面）。 */
function toolResultTexts(context: Context): string[] {
  return context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
}

/** 剧本条目 → 本次 LLM 输出文本（replyFromResult 以真实工具结果续写）。 */
function resolveText(entry: DaemonScriptEntry, context: Context): string {
  if (entry.kind === "reply") return entry.text;
  if (entry.kind === "replyFromResult") {
    return entry.template.replace("{last}", toolResultTexts(context).at(-1) ?? "(无工具结果)");
  }
  return "";
}

/** 任意目录 id → 合成 fake Model（T4.2 模型链：model.set 目标可为真实 builtin
 *  id——引擎侧解析到携带该 provider/id 的 fake 对象，流式仍走剧本 FakeLLM，
 *  每 turn 实际请求的 model 可经记录面观测）。 */
function fakeModelFor(modelId: string): Model<any> {
  const slash = modelId.indexOf("/");
  const provider = slash > 0 ? modelId.slice(0, slash) : "fake";
  const id = slash > 0 ? modelId.slice(slash + 1) : modelId;
  return { ...fakeModel, provider, id } as unknown as Model<any>;
}

function makeScriptedStreamFn(entries: readonly DaemonScriptEntry[], modelLogPath?: string): StreamFn {
  const queue = [...entries];
  let seq = 0;
  return (model, context, _options) => {
    // T4.2 模型感知记录：每次 LLM 调用（= 一个 turn 的真实请求面）追加一行
    // ——set_model 下一 turn 生效 / in-flight 不变的机械判据数据源
    if (modelLogPath !== undefined) {
      appendFileSync(
        modelLogPath,
        `${JSON.stringify({ model: `${(model as { provider: string }).provider}/${(model as { id: string }).id}`, at: Date.now() })}\n`,
        "utf8",
      );
    }
    const entry = queue.shift() ?? { kind: "reply" as const, text: "（剧本耗尽）" };
    const isTool = entry.kind === "tool";
    // 终验热修：provider 失败剧本——只发 error 帧（与真实 pi-ai 失败路径
    // 同构：无 start/无 delta，agentLoop 收口 stopReason=error）
    if (entry.kind === "error") {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: errorMessage(entry.message) });
      return stream;
    }
    const reply = entry.kind === "tool" ? undefined : (entry as { text?: string; thinking?: string; template?: string; chunkSize?: number; chunkDelayMs?: number });
    const text = isTool ? "" : entry.kind === "replyFromResult" ? resolveText(entry, context as Context) : (entry as { text: string }).text;
    const thinking = !isTool && entry.kind === "reply" ? ((entry as { thinking?: string }).thinking ?? "") : "";
    const message = isTool
      ? toolCallMessage(`call-${++seq}`, entry.toolName, entry.args)
      : textMessage(text, thinking);
    const chunkSize = reply?.chunkSize ?? 0;
    const chunkDelayMs = reply?.chunkDelayMs ?? 0;

    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: message });
      // thinking 块（contentIndex 0，T5.3 R4）：先于正文流式分片发出
      if (!isTool && thinking !== "") {
        stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
        for (let i = 0; i < thinking.length; i += Math.max(chunkSize, 1)) {
          await new Promise((r) => setTimeout(r, Math.max(chunkDelayMs, 1)));
          stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.slice(i, i + Math.max(chunkSize, 1)), partial: message });
        }
        stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial: message });
      }
      const textIndex = thinking !== "" ? 1 : 0;
      if (!isTool && chunkSize > 0 && chunkDelayMs > 0 && text.length > chunkSize) {
        // 逐段流式：制造可观测的 streaming 窗口（chat.stream.delta 逐帧下发）
        for (let i = 0; i < text.length; i += chunkSize) {
          await new Promise((r) => setTimeout(r, chunkDelayMs));
          stream.push({ type: "text_delta", contentIndex: textIndex, delta: text.slice(i, i + chunkSize), partial: message });
        }
        stream.push({ type: "text_end", contentIndex: textIndex, content: text, partial: message });
      }
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

// ── 编排主 agent FakeLLM（T4.1）：剧本驱动批次循环 LLM 判断面 ──────
// 与 chat FakeLLM 同构（工具轮 toolUse + 文本轮 stop）；参数/文本模板占位
// {last.<field>} = 最近一次真实工具结果 JSON 字段（insert_batch 回执的
// batchId/jobId 组入 spawn brief——brief 携带任务元数据交批次子进程落账）。
// 剧本随本进程消费（重启从头——重启场景传新剧本文件）。
function interpolateOrchestratorValue(
  value: unknown,
  findField: (field: string) => string | number | undefined,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\{(?:last|any)\.([A-Za-z0-9_]+)\}/g, (_all, field: string) => {
      const hit = findField(field);
      if (hit === undefined) {
        throw new Error(`编排剧本模板 {${_all}} 无可得值（工具结果面无可命中字段）`);
      }
      return String(hit);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateOrchestratorValue(v, findField));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateOrchestratorValue(v, findField);
    return out;
  }
  return value;
}

/** 模板字段解析面：{last.f} = 最近一次工具结果的 JSON 字段；{any.f} = 全部
 * 工具结果自新向旧首个命中该字段的值（dispatch 时 batchId 在两次前的 insert
 * 回执里，agentId 在刚才的 spawn 回执里——两占位同帧可用）。 */
function fieldFinderOf(context: Context): (field: string) => string | number | undefined {
  const texts = toolResultTexts(context);
  const parsed = texts
    .map((t) => {
      try {
        const v = JSON.parse(t) as unknown;
        return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })
    .filter((v): v is Record<string, unknown> => v !== null);
  return (field) => {
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      const hit = parsed[i]![field];
      if (hit !== undefined && (typeof hit === "string" || typeof hit === "number")) return hit;
    }
    return undefined;
  };
}

function makeOrchestratorStreamFn(entries: readonly OrchestratorScriptEntry[]): StreamFn {
  const queue = [...entries];
  let seq = 0;
  return (_model, context) => {
    const entry = queue.shift() ?? { kind: "reply" as const, text: "（剧本耗尽，等待收口注入）" };
    const findField = fieldFinderOf(context as Context);
    const message =
      entry.kind === "tool"
        ? baseAssistant(
            [
              {
                type: "toolCall",
                id: `orch-call-${++seq}`,
                name: entry.toolName!,
                arguments: interpolateOrchestratorValue(entry.args ?? {}, findField) as Record<string, unknown>,
              },
            ],
            "toolUse",
          )
        : baseAssistant([{ type: "text", text: entry.text ?? "（编排等待中）" }], "stop");
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

// ── ScriptedSubagentRunner（T2.4 E 层 R1~R3）：按剧本驱动实例收口 ──
// launch 次序消费剧本条目：有形条目 delayMs 后收口（closure 回调）；null/
// 耗尽 = 挂起（保持 running——重启收口场景的现场构造）。kill 通道可选不实现
// （E 层 R1~R3 不涉 kill）。
class ScriptedSubagentRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private idx = 0;
  private readonly script: SubagentScript;
  constructor(script: SubagentScript) {
    this.script = script;
  }
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }, _task: string): void {
    void _task;
    const entry = this.script[this.idx++];
    if (entry === null || entry === undefined || this.callbacks === undefined) return;
    const outcome: InstanceClosureOutcome =
      entry.result === "done"
        ? { result: "done", closure: { status: "done", summary: entry.summary, reportPath: null, findings: null, taskId: null } }
        : { result: "failed", error: entry.summary, closure: { status: "failed", summary: entry.summary, reportPath: null, findings: null, taskId: null } };
    setTimeout(() => this.callbacks?.onInstanceClosure(instance.instanceId, outcome), entry.delayMs);
  }
}

// ── 延迟编排代理（T2.4 E 层）：agent_spawn 等编排工具需回口真调度器，
// 而调度器在 createDaemon 内部装配（引擎先建）——工具执行时才解引用
// （首个工具调用必然发生在 daemon 装配完成后）。 ────────────────────
let orchestrationRef: AgentOrchestrationPort | undefined;
const lazyOrchestration: AgentOrchestrationPort = {
  spawn(task, profileKind): SpawnOutcome {
    return orchestrationRef!.spawn(task, profileKind);
  },
  send(agentId, message): SendOutcome {
    return orchestrationRef!.send(agentId, message);
  },
  status(agentId?): AgentInstanceStatus[] {
    return orchestrationRef!.status(agentId);
  },
  kill(agentId): KillOutcome {
    return orchestrationRef!.kill(agentId);
  },
  inspect(agentId) {
    return orchestrationRef!.inspect(agentId);
  },
  park(agentId) {
    return orchestrationRef!.park(agentId);
  },
  resume(agentId) {
    return orchestrationRef!.resume(agentId);
  },
};

// ── 装配与生命周期 ──────────────────────────────────────────

async function main(): Promise<void> {
  const script = JSON.parse(readFileSync(scriptPath!, "utf8")) as DaemonScript;
  const subagentScript: SubagentScript = subagentScriptPath
    ? (JSON.parse(readFileSync(subagentScriptPath, "utf8")) as SubagentScript)
    : [];
  // T3r 跟随（T0.1 实跑修复）：MainSessionProfile 声明 browser 工具后，
  // executor 缺 browser 注册面会在 daemon 启动 resolveTools 即 fatal
  // （与生产组合根同构：browserPort 懒连接，E 层剧本零 browser 调用即
  // 零真实连接；homeDir 用 --home tmp，TR-TEST-4 真实 ~/.helix 零触碰）。
  const executor = new CoreToolExecutor({
    cwd: toolCwd ?? process.cwd(),
    orchestration: lazyOrchestration,
    browser: new CdpConnectionManager({ homeDir: home! }),
  });
  // SubAgent runner（T5.2）：真子进程模式（--subagent-engine-script，K3 剧本
  // 引擎注入真 SubagentLauncher——agent_spawn 真实 spawn detached 子进程，
  // teardown 兜底回收观测面）优先；缺省进程内剧本 runner（R1~R3 无子进程）。
  const subagentRunner: InstanceRunner = subagentEngineScriptPath
    ? new SubagentLauncher({
        profile: SubAgentProfile,
        model: fakeModel,
        apiKeys: { fake: "explicit-key" },
        // T4.1：bootstrap 批次子进程需要 kg 写目标 = workspace 根（--kg-workspace-root
        // 给出时优先；否则田沙箱 cwd）；台账库 = 与父进程同库（plan 工具落账）
        toolCwd: kgWorkspaceRoot ?? toolCwd ?? process.cwd(),
        fakeEngineScript: subagentEngineScriptPath,
        ledgerDbPath: path_posix.join(home!, "helix.db"),
      })
    : new ScriptedSubagentRunner(subagentScript);
  // T4.2（多会话 E 层）：engine 以工厂形态注入——每会话独立引擎实例
  // （FakeLLM 剧本队列 per-session 从头消费；两会话可并行驱动 turn，与生产
  // engineFor 工厂同构）。既有单会话 spec 行为不变（单会话仅建一次引擎，
  // 剧本消费序与共享实例形态一致）。模型链（T4.2）：每 turn 实际请求的
  // model 追加记录 <home>/llm-model-log.jsonl；set_model 目标 id 经
  // fakeModelFor 解析（catalog 校验 → 引擎 AgentState.model 直改全链真跑）。
  const modelLogPath = path_posix.join(home!, "llm-model-log.jsonl");
  // T4.2 模型链：set_model 目标可为任意 builtin provider——显式 key 表覆盖
  // 全部 provider（否则引擎按 provider 取 key 时 fail-fast，切模后 turn 直接
  // 引擎错误——与生产 auth.json 源同接口的测试注入形态）
  const fakeApiKeys: Record<string, string> = Object.fromEntries(
    ["fake", ...buildModels().getProviders().map((p) => p.id)].map((p) => [p, "explicit-key"]),
  );
  const engineFor = (): PiAgentEngineAdapter =>
    new PiAgentEngineAdapter({
      profile: {
        ...MainSessionProfile,
        // E 层 chat 引擎注册面一致性（T4.1 基线修复）：launcher 的
        // CoreToolExecutor 不注册 kg/kg-update/task_create/codegraph（生产组合根注入
        // 面），静态声明面同步剔除——与 buildSessionStack 生产引擎的
        // W1/taskCreate 过滤同构（声明即注册硬校验不破；chat 剧本零 kg 调用）。
        tools: MainSessionProfile.tools.filter(
          (t) => t !== "kg" && t !== "kg-update" && t !== "task_create" && t !== "task_report" && t !== "codegraph",
        ),
      },
      model: fakeModel,
      apiKeys: fakeApiKeys,
      models: fakeModels,
      streamFnOverride: makeScriptedStreamFn(script.entries, modelLogPath),
      resolveModelById: fakeModelFor,
      resolveTools: (names) => executor.resolveTools(names),
    });

  const daemon = await createTestDaemon({
    home: home!,
    engine: engineFor,
    skipConfig: true,
    port,
    staticDir,
    toolCwd,
    subagentRunner,
    // T4.1 bootstrap e2e：编排会话 FakeLLM（剧本驱动批次循环）+ workspace
    // 预绑 tmp 根（--kg-workspace-root；缺省不注入 = 既有 createTestDaemon 语义）
    ...(orchestratorScriptPath !== undefined
      ? {
          orchestratorLlmOverride: {
            model: () => fakeModel,
            streamFn: makeOrchestratorStreamFn(
              (JSON.parse(readFileSync(orchestratorScriptPath, "utf8")) as OrchestratorScript).entries,
            ),
            // fake provider key 覆盖（与 chat/subagent fake 引擎同源——生产
            // authStore 无 "fake" key，不覆盖时编排首 turn auth fail 卡 pending）
            apiKeys: () => fakeApiKeys,
          },
        }
      : {}),
    ...(kgWorkspaceRoot !== undefined ? { kgWorkspaceRoot } : {}),
    cliInput: new PassThrough(), // 隔离 stdio：事件 publisher 落 PassThrough，stdout 只留控制行
    cliOutput: new PassThrough(),
  });

  console.log(`##HELIX-DAEMON## ready ${JSON.stringify({ port: daemon.ws.port })}`);
  orchestrationRef = daemon.orchestration; // 编排工具回口真调度器（延迟绑定）

  process.on("SIGTERM", () => {
    void (async () => {
      try {
        await daemon.shutdown();
      } finally {
        console.log("##HELIX-DAEMON## stopped");
        process.exit(0);
      }
    })();
  });
  process.on("SIGINT", () => process.emit("SIGTERM" as never)); // Ctrl-C 等价优雅退出

  // 保活：daemon 事件循环由 WS 服务/写队列持有，此处显式兜底
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error(`##HELIX-DAEMON## fatal ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
