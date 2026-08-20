import type {
  AgentEngineEvent,
  AgentEngineListener,
  AgentEnginePort,
  AgentEngineUsage,
} from "../../src/application/ports/outbound/AgentEnginePort";

/**
 * FakeAgentEngine —— AgentEnginePort 的契约等价 mock（M1，test-design §5.1）。
 *
 * 【时序契约依据】T1.3 spike 报告 §5（out-01/out-02 实测机械提炼），
 * 逐条等价实现：
 *
 * §5.1 turn 边界事件序：
 *   无工具轮  agent_start → turn_start → message_start(user) → message_end(user)
 *             → message_start(assistant) → message_update×N → message_end(assistant)
 *             → turn_end{toolResults:0} → agent_end
 *   带工具轮  … message_end(assistant, stop=toolUse) → tool_execution_start
 *             → tool_execution_end{isError, result} → message_start/end(toolResult)
 *             → turn_end{toolResults:1} → turn_start（assistant 续生成）
 *   abort 轮  … message_end(assistant, stop=error, 空内容) → turn_end → agent_end
 *
 * §5.2 beforeToolCall 挂起契约 → 由 hooks 层（真 runtime）承接，本 mock
 *   面向 service/CLI 层测试，工具脚本直发事件。
 *
 * §5.3 steer drain 契约：
 *   1) steer() 即时入队（工具执行中/流式中均可，hasQueued 变 true）；
 *   2) drain 边界 = turn_end 之后、turn_start 之前；
 *   3) 流式/工具不被 steer 打断；
 *   4) one-at-a-time：每条 steer 独占一个 turn（该 turn 首条 user 消息，
 *      source="steer-drain"），按入队顺序消费；
 *   5) abort 后 drain 仍发生，但紧随一轮 stop=error 空消息终止 run。
 *
 * §5.4 状态观测面：isStreaming / errorMessage（abort 后
 *   "The operation was aborted."）；abort 非销毁——实例可继续 start()。
 */

/** 剧本回合：一次 assistant 生成（含可选的前置工具批）。 */
export interface ScriptedTurn {
  /** assistant 回复文本（按 3~5 字符分片流式发出）。 */
  text?: string;
  /** thinking 块全文（先于文本流分片发出：thinking_started/delta×N/end，T3.1）。 */
  thinking?: string;
  /** 本 turn 用量（挂 message_end(assistant).usage；缺省字段零填，T3.1）。 */
  usage?: Partial<AgentEngineUsage>;
  /** 工具批：先于文本发出（模拟 stopReason=toolUse 的工具轮）。 */
  toolCalls?: {
    toolName: string;
    args?: unknown;
    result?: string;
    isError?: boolean;
    /** 工具执行时长 ms（流式/工具中 steer 的时窗，默认 30）。 */
    durationMs?: number;
  }[];
  /** 流式分片间隔 ms（默认 8；调大以便测试在流式中段注入 steer/abort）。 */
  chunkDelayMs?: number;
  /** turn 边界 compaction 产物（turn_end 后、下一 turn 前 emit compaction_completed，T3.1）。 */
  compaction?: {
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
    usage?: Partial<AgentEngineUsage>;
  };
  /** turn 边界 compaction 失败注入（emit engine_error，会话继续，T3.1）。 */
  compactionError?: string;
}

export interface FakeAgentEngineOptions {
  /** 顺序回复剧本（每次 sendMessage 消费一个；耗尽后用 defaultReply）。 */
  replies?: ScriptedTurn[];
  /** steer drain 后的回复剧本（优先）；耗尽后用 defaultReply。 */
  steerReplies?: ScriptedTurn[];
  /** 剧本耗尽时的默认回复生成器。 */
  defaultReply?: (userText: string) => string;
  /** 全局默认流式分片间隔 ms（剧本回合未自带时生效）。 */
  chunkDelayMs?: number;
  /** 初始模型 id（T2.3 currentModel/setModel 契约等价面；缺省 undefined）。 */
  initialModel?: string;
}

const DEFAULT_CHUNK_DELAY_MS = 8;
const DEFAULT_TOOL_DURATION_MS = 30;
const ABORT_MESSAGE = "The operation was aborted.";

/** 剧本用量零填（缺省字段补 0——FakeAgentEngine 只关心挂载，不复制账目语义）。 */
function fullUsage(partial?: Partial<AgentEngineUsage>): AgentEngineUsage {
  return {
    input: partial?.input ?? 0,
    output: partial?.output ?? 0,
    cacheRead: partial?.cacheRead ?? 0,
    cacheWrite: partial?.cacheWrite ?? 0,
    reasoning: partial?.reasoning ?? 0,
    totalTokens: partial?.totalTokens ?? 0,
    cost: partial?.cost ?? 0,
  };
}

export class FakeAgentEngine implements AgentEnginePort {
  private replies: ScriptedTurn[];
  private steerReplies: ScriptedTurn[];
  private readonly defaultReply: (userText: string) => string;

  private streaming = false;
  private abortRequested = false;
  private errorMessage: string | undefined;
  private readonly steerQueue: string[] = [];
  private listener: AgentEngineListener | null = null;
  private toolCallSeq = 0;
  /** 当前模型（T2.3：setModel 直改可观测——与真引擎 AgentState.model 同构）。 */
  private model: string | undefined;

  /** 全量已发事件（时序断言源：tests 直接对 events 做序断言）。 */
  readonly events: AgentEngineEvent[] = [];

  private readonly defaultChunkDelayMs: number;

  constructor(options: FakeAgentEngineOptions = {}) {
    this.replies = [...(options.replies ?? [])];
    this.steerReplies = [...(options.steerReplies ?? [])];
    this.defaultReply =
      options.defaultReply ?? ((userText: string) => `（fake 回复）已收到：${userText.slice(0, 30)}`);
    this.defaultChunkDelayMs = options.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS;
    this.model = options.initialModel;
  }

  // ── 状态观测面（§5.4） ────────────────────────────────────

  isStreaming(): boolean {
    return this.streaming;
  }

  // ── T2.3 模型族（port 域内扩面与真引擎契约等价：setModel 即时改观测值） ──

  currentModel(): string | undefined {
    return this.model;
  }

  setModel(modelId: string): void {
    this.model = modelId;
  }

  // ── M6 T2 state 直改面（port 可选成员的契约等价 mock：记录 last 值） ──

  private toolsState: readonly string[] | undefined;
  private systemPromptState: string | undefined;

  setTools(names: readonly string[]): void {
    this.toolsState = [...names];
  }

  setSystemPrompt(text: string): void {
    this.systemPromptState = text;
  }

  /** 最近一次 setTools 值（未设置 = undefined）。 */
  get lastTools(): readonly string[] | undefined {
    return this.toolsState;
  }

  /** 最近一次 setSystemPrompt 值（未设置 = undefined）。 */
  get lastSystemPrompt(): string | undefined {
    return this.systemPromptState;
  }

  /** 最近一次 abort 的错误信息（abort 非销毁的观测点）。 */
  get lastErrorMessage(): string | undefined {
    return this.errorMessage;
  }
  /** steer 队列观测（§5.3-1：入队即时可见）。 */
  hasQueued(): boolean {
    return this.steerQueue.length > 0;
  }
  get queuedCount(): number {
    return this.steerQueue.length;
  }
  /** 注入测试便利：运行中直接往队列塞消息（模拟引擎侧已入队）。 */
  seedQueue(text: string): void {
    this.steerQueue.push(text);
  }

  // ── AgentEnginePort 实现 ─────────────────────────────────

  async start(input: string, listener: AgentEngineListener): Promise<void> {
    if (this.streaming) throw new Error("FakeAgentEngine：上一次 run 未结束就再次 start（协议误用）");
    this.streaming = true;
    this.abortRequested = false;
    this.errorMessage = undefined;
    this.listener = listener;

    this.emit({ type: "agent_start" });

    let currentUser: { text: string; source: "prompt" | "steer-drain" } | null = {
      text: input,
      source: "prompt",
    };
    while (currentUser !== null && !this.settled()) {
      const user = currentUser;
      const script = this.pickScript(user);
      await this.runConversationTurn(user, script);
      // T3.1 turn 边界 compaction（prepareNextTurn 挂点镜像：turn_end 后、
      // drain/下一 turn 前；失败 emit engine_error 不中断后续 drain）
      this.emitTurnBoundaryCompaction(script);
      // §5.3-2/4：turn 边界 drain——每条 steer 独占一个 turn，按序消费
      const next = this.steerQueue.shift();
      currentUser = next === undefined ? null : { text: next, source: "steer-drain" };
    }

    // §5.3-5：abort 后 drain 仍发生，但紧随一轮 stop=error 空消息终止 run
    if (this.abortRequested && this.steerQueue.length > 0) {
      const drained = this.steerQueue.shift()!;
      this.emit({ type: "turn_start" });
      this.emitUserMessage(drained, "steer-drain");
      this.emit({ type: "message_start", role: "assistant", source: "steer-drain" });
      this.emit({ type: "message_end", role: "assistant", text: "", stopReason: "error" });
      this.emit({ type: "turn_end", toolResultCount: 0 });
    }

    this.emit({ type: "agent_end", messageCount: 0 });
    this.streaming = false;
    this.listener = null;
  }

  /** §5.3-1：即时入队（流式中/工具执行中均可调用，不打断当前流）。 */
  steer(text: string): void {
    if (!this.streaming) throw new Error("FakeAgentEngine：非运行中 steer（协议误用）");
    this.steerQueue.push(text);
  }

  /** abort：不打断当前分片/工具的发出顺序，但本轮以 stop=error 空消息收尾。 */
  abort(): void {
    if (!this.streaming) return; // 幂等
    this.abortRequested = true;
    this.errorMessage = ABORT_MESSAGE;
  }

  // ── 内部：一轮「用户消息 →（工具批）→ assistant 生成」 ─────────

  private async runConversationTurn(
    user: { text: string; source: "prompt" | "steer-drain" },
    script: ScriptedTurn,
  ): Promise<void> {
    this.emit({ type: "turn_start" });
    this.emitUserMessage(user.text, user.source);

    // 工具批（§5.1 带工具轮：assistant stop=toolUse → tool 执行 → toolResult）
    const toolCalls = script.toolCalls ?? [];
    if (toolCalls.length > 0) {
      this.emit({ type: "message_start", role: "assistant", source: user.source });
      this.emit({ type: "message_end", role: "assistant", text: "", stopReason: "toolUse" });
      let abortedDuringTool = false;
      for (const call of toolCalls) {
        const toolCallId = `tc-${++this.toolCallSeq}`;
        this.emit({
          type: "tool_execution_start",
          toolCallId,
          toolName: call.toolName,
          args: call.args ?? {},
        });
        // §5.3-3：工具执行不被 steer 打断——完整跑完 duration
        await delay(call.durationMs ?? DEFAULT_TOOL_DURATION_MS);
        if (this.abortRequested && !abortedDuringTool) {
          abortedDuringTool = true;
          this.emit({
            type: "tool_execution_end",
            toolCallId,
            toolName: call.toolName,
            isError: true,
            result: "Operation aborted",
          });
        } else {
          this.emit({
            type: "tool_execution_end",
            toolCallId,
            toolName: call.toolName,
            isError: call.isError ?? false,
            result: call.result ?? "",
          });
        }
        this.emit({ type: "message_start", role: "toolResult", source: user.source });
        this.emit({
          type: "message_end",
          role: "toolResult",
          text: call.result ?? "",
          stopReason: undefined,
        });
        if (abortedDuringTool) break;
      }
      this.emit({ type: "turn_end", toolResultCount: toolCalls.length });
      if (this.settled()) {
        // §5.1 abort 轮：turn_end → turn_start → assistant(stop=error 空消息) → turn_end
        this.emit({ type: "turn_start" });
        this.emit({ type: "message_start", role: "assistant", source: user.source });
        this.emit({ type: "message_end", role: "assistant", text: "", stopReason: "error" });
        this.emit({ type: "turn_end", toolResultCount: 0 });
        return;
      }
      // 工具批完成 → 新 pi turn：assistant 带工具结果续生成
      this.emit({ type: "turn_start" });
    }

    // assistant 流式生成（thinking 块先行 → 分片 message_update；T3.1）
    const text = script.text ?? this.defaultReply(user.text);
    const chunks = splitChunks(text);
    const delayMs = script.chunkDelayMs ?? this.defaultChunkDelayMs;
    this.emit({ type: "message_start", role: "assistant", source: user.source });
    const thinking = script.thinking ?? "";
    if (thinking !== "") {
      this.emit({ type: "thinking_started", contentIndex: 0 });
      for (const chunk of splitChunks(thinking)) {
        await delay(delayMs);
        if (this.settled()) break;
        this.emit({ type: "thinking_delta", contentIndex: 0, delta: chunk });
      }
      if (!this.settled()) {
        this.emit({ type: "thinking_end", contentIndex: 0, content: thinking });
      }
    }
    for (const chunk of chunks) {
      await delay(delayMs);
      if (this.settled()) break; // §5.1 abort 轮：剩余分片丢弃
      this.emit({ type: "message_update", delta: chunk });
    }
    if (this.settled()) {
      this.emit({ type: "message_end", role: "assistant", text: "", stopReason: "error" });
    } else {
      const usage = script.usage !== undefined ? fullUsage(script.usage) : undefined;
      this.emit({ type: "message_end", role: "assistant", text, stopReason: "stop", ...(usage !== undefined ? { usage } : {}) });
    }
    this.emit({ type: "turn_end", toolResultCount: 0 });
  }

  /** T3.1：turn 边界 compaction 剧本（成功 emit compaction_completed / 失败 emit engine_error）。 */
  private emitTurnBoundaryCompaction(script: ScriptedTurn): void {
    if (script.compaction !== undefined) {
      const usage = fullUsage(script.compaction.usage);
      this.emit({
        type: "compaction_completed",
        tokensBefore: script.compaction.tokensBefore,
        tokensAfter: script.compaction.tokensAfter,
        summary: script.compaction.summary,
        usage,
      });
    }
    if (script.compactionError !== undefined) {
      this.emit({ type: "engine_error", message: script.compactionError });
    }
  }

  // ── 内部工具 ─────────────────────────────────────────────

  private pickScript(user: { text: string; source: "prompt" | "steer-drain" }): ScriptedTurn {
    if (user.source === "steer-drain") {
      const s = this.steerReplies.shift();
      if (s) return s;
    }
    return this.replies.shift() ?? { text: this.defaultReply(user.text) };
  }

  private emitUserMessage(text: string, source: "prompt" | "steer-drain"): void {
    this.emit({ type: "message_start", role: "user", source });
    this.emit({ type: "message_end", role: "user", text });
  }

  private emit(e: AgentEngineEvent): void {
    this.events.push(e);
    this.listener?.(e);
  }

  /** abort 已请求且当前生成单元应尽快收尾。 */
  private settled(): boolean {
    return this.abortRequested;
  }

  /** 供下一轮 run 预置剧本（测试间复用同一实例时）。 */
  queueReplies(replies: ScriptedTurn[]): void {
    this.replies.push(...replies);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按 4 字符分片（流式 chunk 效果）。 */
function splitChunks(text: string): string[] {
  if (text === "") return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 4) chunks.push(text.slice(i, i + 4));
  return chunks;
}
