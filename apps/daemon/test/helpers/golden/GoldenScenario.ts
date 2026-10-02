/**
 * GoldenScenario —— pi 通道剧本回归仪器（测试资产，不引生产依赖）。
 *
 * 历史：helix-loop Phase 5 golden transcript 双引擎对齐仪器（pi × loop
 * 两侧活跑 diff，D6 分类断言）——随主会话 loop 通道退役（loop 通道退役批）
 * 转为 **pi 通道专属行为锚**：同一剧本 mock StreamFn 驱动 PiAgentEngineAdapter
 * 真跑，录制 AgentEngineEvent 序列做确定性断言（批语义/steer 交错/abort
 * 善后/防火墙/阻塞闸）。七景断言值即 golden 基线——pi 升级或 pi-engine
 * 适配层改动后本套红 = 行为漂移。
 *
 * 时点控制三件套：
 * - delayMs（受控完成序——UC-01 B→A→C）；
 * - onExecute 触点（执行体真正起跑——pi 闭包延迟起跑，事件面 started ≠
 *   执行中）；
 * - GoldenBlockHooks 阻塞窗（beforeToolCall preDelay + 6ms 阻塞——UC-09/15
 *   确定性 abort 时窗）。
 */
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentEngineEvent, AgentEngineListener } from "../../../src/application/ports/outbound/AgentEnginePort";
import { PiAgentEngineAdapter } from "../../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import type { AgentProfile } from "../../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import type { HookSet } from "../../../src/adapters/driven/pi-engine/runtime/HookSet";
import { SteerHooks } from "../../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";

// ── 剧本与工具声明 ──────────────────────────────────────────

/** LLM 剧本轮（pi 侧 abort 场景追加 aborted 尾轮——pi abort 后补打一轮由
 *  streamFn 立返 aborted 才硬出口的既知行为面）。 */
export type GoldenRound =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "batch"; readonly calls: readonly { id: string; name: string; args?: Record<string, unknown> }[] };

/** 工具行为声明。 */
export interface GoldenToolSpec {
  readonly name: string;
  /** 正常耗时 ms（缺省 1——完成序控制）。 */
  readonly delayMs?: number;
  readonly outcome: "ok" | "terminate" | "throw";
  readonly text: string;
  /** signal 置位后行为（UC-08：A 快收/B 忽略/C 抛错）。 */
  readonly onSignal?: "resolve-early" | "ignore" | "throw";
  /** per-tool 批模式（UC-02：批内任一 sequential → 全批 sequential——R1.2）。 */
  readonly executionMode?: "parallel" | "sequential";
}

/** signal 竞态 promise（注：bun 转译器对 new Promise<T> 泛型参内的 as const
 *  误解析——字面量经显式变量/联合类型注入避坑，勿在泛型参内写 as const）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function abortRacePromise(signal: AbortSignal | undefined): Promise<"done" | "abort"> | undefined {
  if (signal === undefined) return undefined;
  return new Promise<"done" | "abort">((resolve) => {
    signal.addEventListener("abort", () => resolve("abort"), { once: true });
  });
}

/** 事件触发动作（对自己的事件流求 predicate）。 */
export interface GoldenAction {
  readonly when: (events: readonly AgentEngineEvent[], firedSoFar: number) => boolean;
  readonly do: { readonly kind: "steer"; readonly text: string } | { readonly kind: "abort" };
}

export interface GoldenScenario {
  readonly name: string;
  readonly prompt: string;
  readonly rounds: readonly GoldenRound[];
  /** 剧本尾轮补打 aborted（pi abort 后多走一轮循环——既知行为面）。 */
  readonly piAbortedTail?: boolean;
  readonly tools: readonly GoldenToolSpec[];
  readonly actions?: readonly GoldenAction[];
  /** preflight 阻塞钩子目标工具（UC-09/15：阻塞窗内 abort 的确定性时点）。 */
  readonly piBlockTool?: string;
  /** 阻塞钩子触点回调。 */
  readonly piOnGate?: () => void;
  /** 阻塞前置时窗 ms（UC-15：制造「在飞兄弟名义上已可完成」的时窗；缺省 0）。 */
  readonly piGatePreDelayMs?: number;
  /** 执行体起跑触点 abort（UC-08：指定工具真正执行时 abort——pi 闭包延迟
   *  起跑，事件面 started ≠ 执行中的确定性时点）。 */
  readonly abortOnExecute?: string;
  /** 阻塞闸触点即 abort（UC-09：preflight 期 abort）。 */
  readonly piGateAborts?: boolean;
}

// ── pi 侧引擎装配 ──────────────────────────────────────────

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
  getModel: (provider: string, id: string) => (provider === "fake" && id === "model" ? fakeModel : undefined),
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
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function roundToAssistant(round: GoldenRound | { kind: "aborted" }): AssistantMessage {
  if (round.kind === "text") return baseAssistant([{ type: "text", text: round.text }], "stop");
  if (round.kind === "batch") {
    return baseAssistant(
      round.calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: (c.args ?? {}) as never })),
      "toolUse",
    );
  }
  return baseAssistant([], "aborted");
}

/** 剧本 mock StreamFn（start + text_delta + done；aborted 轮无 delta）。 */
function piScriptStream(rounds: readonly (GoldenRound | { kind: "aborted" })[]): StreamFn {
  let call = 0;
  return (_model, _context) => {
    const round = rounds[call++] ?? { kind: "text" as const, text: "（剧本耗尽）" };
    const message = roundToAssistant(round);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: message });
      if (round.kind === "text") {
        stream.push({ type: "text_delta", contentIndex: 0, delta: round.text, partial: message });
      }
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

/** 工具行为单点：delay × outcome × signal 响应。onExecute = 执行体真正起跑
 *  的触点（abort 确定性时点——pi 闭包延迟起跑，事件面 started ≠ 执行中）。 */
async function runGoldenBehavior(
  spec: GoldenToolSpec,
  signal: AbortSignal | undefined,
  onExecute?: () => void,
): Promise<{ text: string }> {
  onExecute?.();
  const delay = spec.delayMs ?? 1;
  if (spec.onSignal !== undefined && signal !== undefined) {
    const won = await Promise.race([
      sleep(delay).then(() => "done" as "done" | "abort"),
      abortRacePromise(signal) ?? Promise.resolve("done" as "done" | "abort"),
    ]);
    if (won === "abort" && spec.onSignal === "throw") throw new Error(spec.text);
    return { text: spec.text }; // resolve-early：正常返回（结果照记——R4.4）
  }
  await sleep(delay); // ignore / 缺省：signal 不影响
  return { text: spec.text };
}

function piToolOf(spec: GoldenToolSpec, onExecute?: () => void): AgentTool<any> {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.name,
    parameters: { type: "object", properties: {}, additionalProperties: true } as never,
    ...(spec.executionMode !== undefined ? { executionMode: spec.executionMode } : {}),
    execute: async (_toolCallId: string, _params: unknown, signal: AbortSignal | undefined) => {
      const { text } = await runGoldenBehavior(spec, signal, onExecute);
      if (spec.outcome === "terminate") {
        return { content: [{ type: "text" as const, text }], details: {}, terminate: true };
      }
      if (spec.outcome === "throw") throw new Error(text);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  } as unknown as AgentTool<any>;
}

/** preflight 阻塞钩子（preDelay 后触点回调 + 6ms 阻塞窗——abort 后 resolve；
 *  preDelay 制造「在飞兄弟名义完成时窗后再 abort」的确定性时点（UC-15），
 *  缺省 0（UC-09）。 */
class GoldenBlockHooks implements HookSet {
  readonly name = "golden-block";
  constructor(
    private readonly opts: { blockTool: string; onGate: () => void; preDelayMs?: number },
  ) {}
  async beforeToolCall(context: { toolCall: { name: string } }): Promise<undefined> {
    if (context.toolCall.name === this.opts.blockTool) {
      await sleep(this.opts.preDelayMs ?? 0);
      this.opts.onGate();
      await sleep(6);
    }
    return undefined;
  }
}

export interface GoldenSide {
  readonly events: AgentEngineEvent[];
  readonly listener: AgentEngineListener;
  /** 触发动作执行面。 */
  readonly fireAction: (action: GoldenAction) => void;
  readonly engine: PiAgentEngineAdapter;
}

/** pi 侧装配（剧本含 aborted 尾轮由 sc.piAbortedTail 控制）。 */
export function buildPiSide(sc: GoldenScenario): GoldenSide {
  const events: AgentEngineEvent[] = [];
  const engineRef: { current?: PiAgentEngineAdapter } = {};
  const piTools = sc.tools.map((t) =>
    piToolOf(t, sc.abortOnExecute === t.name ? () => engineRef.current?.abort() : undefined),
  );
  const rounds: (GoldenRound | { kind: "aborted" })[] = [...sc.rounds, ...(sc.piAbortedTail ? [{ kind: "aborted" as const }] : [])];
  const engine = new PiAgentEngineAdapter({
    profile: {
      kind: "golden",
      systemPrompt: "golden parity",
      tools: sc.tools.map((t) => t.name),
      lifecycle: { mode: "persistent" },
      hooks: [SteerHooks],
    } satisfies AgentProfile,
    model: fakeModel,
    apiKeys: { fake: "golden-key" },
    models: fakeModels,
    streamFnOverride: piScriptStream(rounds),
    resolveTools: () => piTools,
    ...(sc.piBlockTool !== undefined && sc.piOnGate !== undefined
      ? {
          extraHooks: [
            new GoldenBlockHooks({
              blockTool: sc.piBlockTool,
              onGate: () => {
                sc.piOnGate?.();
                if (sc.piGateAborts === true) engineRef.current?.abort();
              },
              ...(sc.piGatePreDelayMs !== undefined ? { preDelayMs: sc.piGatePreDelayMs } : {}),
            }),
          ],
        }
      : {}),
  });
  engineRef.current = engine;
  return {
    events,
    listener: (e) => events.push(e),
    fireAction: (action) => {
      if (action.do.kind === "steer") engine.steer(action.do.text);
      else engine.abort();
    },
    engine,
  };
}

/** 标准驱动：prompt 起跑 + 事件触发动作 + 等收口。 */
export async function runGoldenScenario(sc: GoldenScenario): Promise<{ pi: GoldenSide }> {
  const pi = buildPiSide(sc);
  const piFired: GoldenAction[] = [];
  const actions = sc.actions ?? [];
  const watch = (side: GoldenSide, fired: GoldenAction[], raw: (e: AgentEngineEvent) => void): AgentEngineListener => {
    return (e: AgentEngineEvent) => {
      raw(e);
      const next = actions[fired.length];
      if (next !== undefined && next.when(side.events, fired.length)) {
        fired.push(next);
        side.fireAction(next);
      }
    };
  };
  await pi.engine.start(sc.prompt, watch(pi, piFired, pi.listener));
  return { pi };
}

/** 工具 started 计数谓词（动作触发常用面）。 */
export function startedCountAtLeast(n: number): (events: readonly AgentEngineEvent[]) => boolean {
  return (events) => events.filter((e) => e.type === "tool_execution_start").length >= n;
}
