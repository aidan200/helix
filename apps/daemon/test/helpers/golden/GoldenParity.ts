/**
 * GoldenParity —— helix-loop Phase 5 golden transcript 对齐仪器（测试资产，
 * 不引生产依赖；设计 §8「golden transcript 回放是 Phase 3/5 的对齐主仪器」）。
 *
 * 形态：同一输入分别经 pi 引擎（PiAgentEngineAdapter + mock StreamFn）与
 * helix-loop 引擎（LoopAgentEngineAdapter + mock LoopStreamFn）跑同一剧本，
 * 录制两侧 AgentEngineEvent 序列做 D6 分类对齐断言：
 * - 完成序类（tool_execution_end）：**集合等价**（跨枚完成序非确定——D6 裁决；
 *   载荷按 per-tool 声明比较：toolName 恒比，isError/result 可声明跳过）；
 * - 源序类（其余事件）：**严格序列**（骨架串逐位相等）；
 * - 入账类（message_start/end(toolResult)）：按 turn 分组比较条数（文本仅
 *   在全可比时比较——偏差 UC 的合成/真实结果文本属声明偏差面）。
 *
 * 已裁决的有意偏差（D 列表）以 trim/声明显式登记——未声明偏差即断言失败
 * （防漂移）；每条偏差携带理由注释（Phase 6 切换验收复用面）。
 *
 * 已知登记偏差族（语义定稿 §3 裁决记录）：
 * - D8：pi abort 后多打一次 streamFn（补打 drain turn）——trim pi 侧四连帧；
 * - D6：完成序事件集合等价（本仪器分类基础）；
 * - R1.4/TR-227：loop preflight 全批源序 started（pi sequential 逐枚交错）
 *   ——started 入源序类严格序（发射时点差异被分类吸收）；
 * - R5.2/R5.4：loop 防火墙显式 engine_error + terminate 枚 isError=true
 *  （pi terminate 不设 isError）——声明跳过；
 * - D3/R4.4/TR-227「放行即起跑」：abort-during-preflight（UC-09）pi 闭包
 *   起跑查全合成 "Operation aborted"，loop 已在飞枚真实结果照记——声明跳过；
 * - ToolRegistry 异常归一前缀「工具执行异常：」（pi 裸 message）——文本归一；
 * - 合成中断文案差异（pi "Operation aborted" vs loop E-198 常量）——声明跳过。
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
import { LoopAgentEngineAdapter } from "../../../src/adapters/driven/loop/LoopAgentEngineAdapter";
import type { LoopStreamFn, LoopStreamResult, LoopToolOutcome } from "../../../src/domain/loop";
import { ToolRegistry } from "../../../src/domain/loop";
import type { LoopToolRegistration } from "../../../src/domain/loop/kernel/ToolRegistry";

// ── 剧本与工具声明（两侧同源） ──────────────────────────────

/** LLM 剧本轮（公共剧本；pi 侧 abort 场景追加 aborted 尾轮——D8）。 */
export type GoldenRound =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "batch"; readonly calls: readonly { id: string; name: string; args?: Record<string, unknown> }[] };

/** 工具行为声明（pi AgentTool 与 loop ToolRegistry 同源派生）。 */
export interface GoldenToolSpec {
  readonly name: string;
  /** 正常耗时 ms（缺省 1——完成序控制）。 */
  readonly delayMs?: number;
  readonly outcome: "ok" | "terminate" | "throw";
  readonly text: string;
  /** signal 置位后行为（UC-08：A 快收/B 忽略/C 抛错）。 */
  readonly onSignal?: "resolve-early" | "ignore" | "throw";
  /** pi per-tool 批模式（UC-02：批内任一 sequential → 全批 sequential）。 */
  readonly executionMode?: "parallel" | "sequential";
}

/** signal 竞态 promise（注：bun 转译器对 new Promise<T> 泛型参内的 as const
 *  误解析——字面量经显式变量/联合类型注入避坑，勿在泛型参内写 as const）。 */
function abortRacePromise(signal: AbortSignal | undefined): Promise<"done" | "abort"> | undefined {
  if (signal === undefined) return undefined;
  return new Promise<"done" | "abort">((resolve) => {
    signal.addEventListener("abort", () => resolve("abort"), { once: true });
  });
}

/** 事件触发动作（每侧对自己的事件流求 predicate，时点两侧对应）。 */
export interface GoldenAction {
  readonly when: (events: readonly AgentEngineEvent[], firedSoFar: number) => boolean;
  readonly do: { readonly kind: "steer"; readonly text: string } | { readonly kind: "abort" };
}

export interface GoldenScenario {
  readonly name: string;
  readonly prompt: string;
  readonly rounds: readonly GoldenRound[];
  /** pi 侧剧本尾轮补打 aborted（D8：pi abort 后多走一轮循环）——loop 侧无此轮。 */
  readonly piAbortedTail?: boolean;
  readonly tools: readonly GoldenToolSpec[];
  readonly actions?: readonly GoldenAction[];
  /** pi 侧 preflight 阻塞钩子（最近似对照——pi 无暂停面）。 */
  readonly piBlockTool?: string;
  /** pi 阻塞钩子触点回调（内触发 abort——确定性时点）。 */
  readonly piOnGate?: () => void;
  /** pi 阻塞前置时窗 ms（UC-15：在飞兄弟先完成；缺省 0）。 */
  readonly piGatePreDelayMs?: number;
  /** loop 侧 preflight 观察闸（UC-09：阻塞窗内 abort → 合成配对）。 */
  readonly loopBlockTool?: string;
  readonly loopOnGate?: () => void;
  /** loop 侧挂闸（UC-15：pause → run settle paused）。 */
  readonly loopPauseTool?: string;
  /** 执行体起跑触点 abort（UC-08：指定工具真正执行时两侧各自 abort——pi 闭包
   *  延迟起跑，事件面 started ≠ 执行中的确定性时点）。 */
  readonly abortOnExecute?: string;
  /** 阻塞/观察闸触点即 abort（UC-09：preflight 期 abort——两侧各自引擎）。 */
  readonly piGateAborts?: boolean;
  readonly loopGateAborts?: boolean;
  readonly align: GoldenAlignOptions;
}

// ── 对齐断言（D6 分类） ────────────────────────────────────

/** per-tool 完成序类载荷比较声明（缺省 result/isError 均比较）。 */
export interface ToolEndExpectation {
  readonly result?: boolean;
  readonly isError?: boolean;
  readonly reason: string;
}

export interface GoldenAlignOptions {
  /** D8 有意偏差：trim pi abort 后补打 drain turn（turn_start+assistant aborted 帧+turn_end）。 */
  readonly trimPiAbortDrainTurn?: boolean;
  /** 暂停面 additive（设计 §7.4）：loop engine_paused 事件 pi 侧无对应——drop。 */
  readonly dropLoopEnginePaused?: boolean;
  /** R5.2 有意偏差：loop 防火墙显式 engine_error（pi 无——pi 仅停工具循环）。 */
  readonly dropLoopEngineError?: boolean;
  /** 完成序类 per-tool 载荷声明（未列出的工具全字段比较）。 */
  readonly toolEnd?: Record<string, ToolEndExpectation>;
  /** loop 结果文本归一（异常归一前缀等——documented）。 */
  readonly normalizeLoopResult?: (toolName: string, text: string) => string;
  /** 分类注释（断言失败诊断面 + Phase 6 切换验收复用）。 */
  readonly notes?: readonly string[];
}

/** 源序类骨架（断言可读面）。 */
export function skeleton(e: AgentEngineEvent): string {
  switch (e.type) {
    case "message_start":
      return `message_start:${e.role}:${e.source}`;
    case "message_end":
      return `message_end:${e.role}:${e.text}:${e.stopReason ?? "-"}`;
    case "message_update":
      return `message_update:${e.delta}`;
    case "tool_execution_start":
      return `tool_start:${e.toolCallId}`;
    case "turn_end":
      return `turn_end:${e.toolResultCount}`;
    case "agent_end":
      return `agent_end:${e.messageCount}`;
    default:
      return e.type;
  }
}

/** D8 trim：pi abort 补打 drain turn 四连帧（message_end assistant aborted 为锚）。 */
function trimPiAbortDrain(events: readonly AgentEngineEvent[]): AgentEngineEvent[] {
  const keep = events.map(() => true);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== "message_end" || e.role !== "assistant" || e.stopReason !== "aborted") continue;
    // 回溯：紧邻的 message_start(assistant) + 更前的 turn_start
    if (i >= 1 && events[i - 1]!.type === "message_start" && keep[i - 1] === true) {
      keep[i - 1] = false;
      keep[i] = false;
      for (let j = i - 2; j >= 0 && events[j]!.type === "message_start"; j--) keep[j] = false; // user 帧不误伤（aborted 轮无）
      let j = i - 2;
      while (j >= 0 && keep[j] === false) j--;
      if (j >= 0 && events[j]!.type === "turn_start") keep[j] = false;
    }
    // 前望：紧邻的 turn_end
    if (i + 1 < events.length && events[i + 1]!.type === "turn_end") keep[i + 1] = false;
  }
  return events.filter((_, i) => keep[i]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 对齐主断言（D6 分类）。失败时输出两侧分类投影 + 分类注释。 */
export function assertGoldenParity(
  sc: GoldenScenario,
  piEventsRaw: readonly AgentEngineEvent[],
  loopEventsRaw: readonly AgentEngineEvent[],
): void {
  const opts = sc.align;
  const piEvents = opts.trimPiAbortDrainTurn ? trimPiAbortDrain(piEventsRaw) : [...piEventsRaw];
  const loopEvents = loopEventsRaw
    .filter((e) => !(opts.dropLoopEnginePaused === true && e.type === "engine_paused"))
    .filter((e) => !(opts.dropLoopEngineError === true && e.type === "engine_error"));

  // ① 完成序类：tool_execution_end 集合等价 + per-tool 声明载荷
  const ends = (list: readonly AgentEngineEvent[]) =>
    list.filter((e): e is Extract<AgentEngineEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end");
  const piEnds = ends(piEvents);
  const loopEnds = ends(loopEvents);
  const piIds = piEnds.map((e) => e.toolCallId).sort();
  const loopIds = loopEnds.map((e) => e.toolCallId).sort();
  if (JSON.stringify(piIds) !== JSON.stringify(loopIds)) {
    throw new Error(
      `[${sc.name}] 完成序类集合不等价（D6）\n  pi:   ${JSON.stringify(piIds)}\n  loop: ${JSON.stringify(loopIds)}\n${notesOf(opts)}`,
    );
  }
  const piById = new Map(piEnds.map((e) => [e.toolCallId, e]));
  for (const loopEnd of loopEnds) {
    const piEnd = piById.get(loopEnd.toolCallId);
    if (piEnd === undefined) continue;
    const expectTool = opts.toolEnd?.[loopEnd.toolName] ?? opts.toolEnd?.["*"];
    if (piEnd.toolName !== loopEnd.toolName) {
      throw new Error(`[${sc.name}] tool_execution_end(${loopEnd.toolCallId}) toolName 不等：${piEnd.toolName} vs ${loopEnd.toolName}`);
    }
    if (expectTool?.isError !== false && piEnd.isError !== loopEnd.isError) {
      throw new Error(
        `[${sc.name}] tool_execution_end(${loopEnd.toolCallId}) isError 不等：pi=${piEnd.isError} loop=${loopEnd.isError}` +
          (expectTool ? `（声明理由：${expectTool.reason}）` : ""),
      );
    }
    if (expectTool?.result !== false) {
      const normalized = opts.normalizeLoopResult?.(loopEnd.toolName, loopEnd.result) ?? loopEnd.result;
      if (piEnd.result !== normalized) {
        throw new Error(
          `[${sc.name}] tool_execution_end(${loopEnd.toolCallId}) result 不等：\n  pi:   ${JSON.stringify(piEnd.result)}\n  loop: ${JSON.stringify(normalized)}`,
        );
      }
    }
  }

  // ② 入账类：message_start/end(toolResult) 按 turn 分组条数（全可比时比文本）
  const accountPerTurn = (list: readonly AgentEngineEvent[]): number[] => {
    const turns: number[] = [];
    let count = 0;
    let seenAny = false;
    for (const e of list) {
      if (e.type === "message_end" && e.role === "toolResult") {
        count += 1;
        seenAny = true;
      }
      if (e.type === "turn_end") {
        turns.push(seenAny || count > 0 ? count : count);
        count = 0;
      }
    }
    return turns;
  };
  const piAccount = accountPerTurn(piEvents);
  const loopAccount = accountPerTurn(loopEvents);
  if (JSON.stringify(piAccount) !== JSON.stringify(loopAccount)) {
    throw new Error(
      `[${sc.name}] 入账类（toolResult 消息）按 turn 分组不等价\n  pi:   ${JSON.stringify(piAccount)}\n  loop: ${JSON.stringify(loopAccount)}\n${notesOf(opts)}`,
    );
  }

  // ③ 源序类：其余事件严格序列（骨架串逐位）
  const sourceSkeletons = (list: readonly AgentEngineEvent[]) =>
    list
      .filter((e) => e.type !== "tool_execution_end")
      .filter((e) => !(e.type === "message_start" && e.role === "toolResult"))
      .filter((e) => !(e.type === "message_end" && e.role === "toolResult"))
      .map(skeleton);
  const piSource = sourceSkeletons(piEvents);
  const loopSource = sourceSkeletons(loopEvents);
  if (JSON.stringify(piSource) !== JSON.stringify(loopSource)) {
    throw new Error(
      `[${sc.name}] 源序类严格序列不等\n  pi:   ${JSON.stringify(piSource)}\n  loop: ${JSON.stringify(loopSource)}\n${notesOf(opts)}`,
    );
  }
}

function notesOf(opts: GoldenAlignOptions): string {
  return opts.notes !== undefined && opts.notes.length > 0 ? `  分类注释：\n${opts.notes.map((n) => `  - ${n}`).join("\n")}\n` : "";
}

// ── 两侧引擎装配 ──────────────────────────────────────────

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

/** pi 侧剧本 mock StreamFn（start + text_delta + done；aborted 轮无 delta）。 */
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

/** 工具行为单点（两侧同源）：delay × outcome × signal 响应。onExecute =
 *  执行体真正起跑的触点（UC-08 abort 确定性时点——pi 闭包延迟起跑，事件面
 *  started ≠ 执行中）。 */
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

function loopToolOf(spec: GoldenToolSpec, onExecute?: () => void): LoopToolRegistration {
  return {
    name: spec.name,
    description: spec.name,
    parameters: { type: "object", properties: {} },
    ...(spec.executionMode !== undefined ? { executionMode: spec.executionMode } : {}),
    handler: async (_args, ctx): Promise<LoopToolOutcome> => {
      const { text } = await runGoldenBehavior(spec, ctx.signal, onExecute);
      if (spec.outcome === "terminate") return { kind: "terminate", reason: text };
      if (spec.outcome === "throw") throw new Error(text);
      return { kind: "result", text };
    },
  };
}

/** loop 侧剧本 mock LoopStreamFn（text 轮驱 onDelta + onBlockEnd——与 pi mock 同流面）。 */
function loopScriptStream(rounds: readonly GoldenRound[]): LoopStreamFn {
  let call = 0;
  return async (_input, callbacks) => {
    const round = rounds[call++] ?? { kind: "text" as const, text: "（剧本耗尽）" };
    if (round.kind === "text") {
      callbacks?.onDelta?.(round.text);
      callbacks?.onBlockEnd?.({ type: "text", text: round.text });
      return { kind: "blocks", blocks: [{ type: "text", text: round.text }], stopReason: "stop" } satisfies LoopStreamResult;
    }
    for (const c of round.calls) {
      callbacks?.onBlockEnd?.({ type: "toolCall", id: c.id, name: c.name, args: c.args ?? {} });
    }
    return {
      kind: "blocks",
      blocks: round.calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, args: c.args ?? {} })),
      stopReason: "toolUse",
    } satisfies LoopStreamResult;
  };
}

/** pi 侧 preflight 阻塞钩子（preDelay 后触点回调 + 6ms 阻塞窗——abort 后 resolve；
 *  preDelay 制造「在飞兄弟完成后再 abort」的确定性时窗（UC-15），缺省 0（UC-09）。 */
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
  /** 触发动作执行面（每侧闭包自己的引擎）。 */
  readonly fireAction: (action: GoldenAction) => void;
  readonly engine: PiAgentEngineAdapter | LoopAgentEngineAdapter;
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

/** loop 侧装配（挂闸/观察闸经 beforeToolCallPause 注入）。 */
export function buildLoopSide(sc: GoldenScenario): GoldenSide {
  const events: AgentEngineEvent[] = [];
  const engineRef: { current?: LoopAgentEngineAdapter } = {};
  const registry = new ToolRegistry();
  for (const spec of sc.tools) {
    registry.register(loopToolOf(spec, sc.abortOnExecute === spec.name ? () => engineRef.current?.abort() : undefined));
  }
  const engine = new LoopAgentEngineAdapter({
    systemPrompt: "golden parity",
    streamFn: loopScriptStream(sc.rounds),
    registry,
    ...(sc.loopBlockTool !== undefined || sc.loopPauseTool !== undefined
      ? {
          beforeToolCallPause: async (ctx, signal) => {
            if (sc.loopBlockTool !== undefined && ctx.toolName === sc.loopBlockTool) {
              sc.loopOnGate?.();
              if (sc.loopGateAborts === true) engineRef.current?.abort();
              await sleep(6); // 阻塞窗（abort 置位后返回——ToolPhase 后置检查收合成配对）
              return { pause: false };
            }
            if (sc.loopPauseTool !== undefined && ctx.toolName === sc.loopPauseTool) {
              return { pause: true };
            }
            return { pause: false };
          },
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

/** 标准驱动：两侧同 prompt 起跑 + 事件触发动作（各自事件流求时点）+ 等收口。 */
export async function runGoldenScenario(sc: GoldenScenario): Promise<{ pi: GoldenSide; loop: GoldenSide }> {
  const pi = buildPiSide(sc);
  const loop = buildLoopSide(sc);
  const piFired: GoldenAction[] = [];
  const loopFired: GoldenAction[] = [];
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
  const piRun = pi.engine.start(sc.prompt, watch(pi, piFired, pi.listener));
  const loopRun = loop.engine.start(sc.prompt, watch(loop, loopFired, loop.listener));
  await Promise.all([piRun, loopRun]);
  return { pi, loop };
}

/** 工具 started 计数谓词（动作触发常用面）。 */
export function startedCountAtLeast(n: number): (events: readonly AgentEngineEvent[]) => boolean {
  return (events) => events.filter((e) => e.type === "tool_execution_start").length >= n;
}
