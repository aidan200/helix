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
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import type { InstanceRunner, InstanceRunnerCallbacks, InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import type { AgentOrchestrationPort, SpawnOutcome, SendOutcome, KillOutcome, AgentInstanceStatus } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { DaemonScript, DaemonScriptEntry, SubagentScript } from "../../../../e2e/harness/daemon-script";
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

if (!home || !scriptPath || !Number.isFinite(port)) {
  console.error("##HELIX-DAEMON## fatal 用法: launcher.ts --home <dir> --port <n> --script <json> [--subagent-script <json>] [--static-dir <dir>] [--tool-cwd <dir>>");
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

function baseAssistant(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fake",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function textMessage(text: string): AssistantMessage {
  return baseAssistant([{ type: "text", text }], "stop");
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return baseAssistant([{ type: "toolCall", id, name, arguments: args }], "toolUse");
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

function makeScriptedStreamFn(entries: readonly DaemonScriptEntry[]): StreamFn {
  const queue = [...entries];
  let seq = 0;
  return (_model, context, _options) => {
    const entry = queue.shift() ?? { kind: "reply" as const, text: "（剧本耗尽）" };
    const isTool = entry.kind === "tool";
    const message = isTool
      ? toolCallMessage(`call-${++seq}`, entry.toolName, entry.args)
      : textMessage(resolveText(entry, context as Context));
    const chunkSize = entry.kind === "tool" ? 0 : (entry.chunkSize ?? 0);
    const chunkDelayMs = entry.kind === "tool" ? 0 : (entry.chunkDelayMs ?? 0);
    const text = isTool ? "" : resolveText(entry, context as Context);

    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: message });
      if (!isTool && chunkSize > 0 && chunkDelayMs > 0 && text.length > chunkSize) {
        // 逐段流式：制造可观测的 streaming 窗口（chat.stream.delta 逐帧下发）
        for (let i = 0; i < text.length; i += chunkSize) {
          await new Promise((r) => setTimeout(r, chunkDelayMs));
          stream.push({ type: "text_delta", contentIndex: 0, delta: text.slice(i, i + chunkSize), partial: message });
        }
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      }
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
};

// ── 装配与生命周期 ──────────────────────────────────────────

async function main(): Promise<void> {
  const script = JSON.parse(readFileSync(scriptPath!, "utf8")) as DaemonScript;
  const subagentScript: SubagentScript = subagentScriptPath
    ? (JSON.parse(readFileSync(subagentScriptPath, "utf8")) as SubagentScript)
    : [];
  const executor = new CoreToolExecutor({ cwd: toolCwd ?? process.cwd(), orchestration: lazyOrchestration });
  // SubAgent runner（T5.2）：真子进程模式（--subagent-engine-script，K3 剧本
  // 引擎注入真 SubagentLauncher——agent_spawn 真实 spawn detached 子进程，
  // teardown 兜底回收观测面）优先；缺省进程内剧本 runner（R1~R3 无子进程）。
  const subagentRunner: InstanceRunner = subagentEngineScriptPath
    ? new SubagentLauncher({
        profile: SubAgentProfile,
        model: fakeModel,
        apiKeys: { fake: "explicit-key" },
        toolCwd: toolCwd ?? process.cwd(),
        fakeEngineScript: subagentEngineScriptPath,
      })
    : new ScriptedSubagentRunner(subagentScript);
  const engine = new PiAgentEngineAdapter({
    profile: MainSessionProfile,
    model: fakeModel,
    apiKeys: { fake: "explicit-key" },
    models: fakeModels,
    streamFnOverride: makeScriptedStreamFn(script.entries),
    resolveTools: (names) => executor.resolveTools(names),
  });

  const daemon = await createDaemon({
    home: home!,
    engine,
    skipConfig: true,
    port,
    staticDir,
    toolCwd,
    subagentRunner,
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
