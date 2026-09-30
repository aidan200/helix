/**
 * LoopAgentEngineAdapter —— AgentEnginePort 的 helix-loop 实现（Phase 5 迁移
 * 收官批；设计 §7.2/§7.4；TR-224：loop 侧引擎位，与 pi-engine 防腐墙平级）。
 *
 * 组合根产物：LoopAgent（runtime 层跨 run 状态机）+ ToolRegistry（工具桥
 * resolveLoopTools 注册面）+ LoopStreamFn（llm 中立层桥/测试 mock）→ port 语义。
 * 消费面（ChatService/AgentRuntime 上层）零改动——经 engine flag 选择 pi 或
 * loop 实现（flag 默认 pi：现役行为零漂移；切换是检查点 5 与用户确认后的
 * 独立动作）。
 *
 * 事件投影（设计 §7.4 单点映射，时序契约锚 = FakeAgentEngine/pi 适配器双实现）：
 * - run/turn/message 族：loop.run.started → agent_start；loop.turn.started →
 *   turn_start；loop.message.started/delta/finished → message_start(assistant)/
 *   message_update/message_end(assistant)（text 由 delta 累积——LoopEvent 无终态
 *   文本载荷，块集在 kernel 内部）；
 * - user 消息事件（prompt/steer-drain/followUp 输入）自 transcript 单写面
 *   （LoopAgentDeps.onNewMessage）合成：首条 prompt 在 run 首个 turn.started 前
 *   入账（kernel 先记输入后起 run）——缓冲至 turn.started 后发射（pi 序：
 *   turn_start → message_start(user)）；E-198 截断标记（LOOP_INTERRUPTED_MARKER_
 *   TEXT）不投影（pi 无对应消息，ChatService 不应把它落成 user entry）；
 * - 工具族：loop.tool.started/finished → tool_execution_start/end（args/result
 *   载荷取 Phase 5 additive 全对象位）；toolResult 消息事件按源序在
 *   loop.turn.finished 收口批发射（pi parallel 形态：完成序 end 全发 → 源序
 *   toolResult message → turn_end——源序取 started 事件序）；
 * - 暂停面（port additive，设计 §7.4）：loop.run.paused → engine_paused +
 *   resume 可选位（pauseToken → resumeWith 续跑链，D5 惰性化由 kernel 承接）；
 * - 不投影：loop.run.interrupted（abort 可见性归调用方生命周期；E-198 善后
 *   消息已在 transcript）、loop.run.resumed（resume 是应用驱动动作）。
 *
 * steer 通道（pi 对齐）：在飞/挂起只入队（G-C/R6.8）；idle 暂存至下一 start
 * 的 P0 投递（pi PendingMessageQueue 同构——防无 listener 的暗跑 run，事件面
 * 不可见）。
 *
 * 已知缺口（Phase 6 翻默认前必修，findings 申报）：LoopStreamResult 无 usage
 * 位 → message_end(assistant) 不携带 usage（ChatService 零 usage.recorded——
 * 账目缺口）；thinking 块流仅段级（thinking_started/end 成对，无 delta 细流
 * ——LoopEvent 无 thinking 流事件）。
 */
import type {
  AgentEngineEvent,
  AgentEngineListener,
  AgentEnginePort,
  EngineResumeDecision,
} from "../../../application/ports/outbound/AgentEnginePort";
import { parseDataUrlImages } from "../../../application/services/images";
import type { LoopContentBlock, LoopEvent, LoopMessage, LoopStreamFn } from "../../../domain/loop/contracts";
import { LOOP_INTERRUPTED_MARKER_TEXT } from "../../../domain/loop/contracts";
import type { LoopResumeDecision } from "../../../domain/loop/contracts";
import { LoopAgent } from "../../../domain/loop/runtime/LoopAgent";
import type { LoopRunOptions } from "../../../domain/loop/runtime/LoopAgent";
import type { ToolRegistry } from "../../../domain/loop/kernel/ToolRegistry";

/** run 级缺省工具轮上限（loop 通道成本护栏——pi 无此面，helix 独有 R7）。 */
export const DEFAULT_LOOP_ENGINE_MAX_ROUNDS = 64;

/** 模型可观测面委托（组合根持 mutable 模型槽——streamFn 每请求重读）。 */
export interface LoopEngineModelRef {
  get(): string;
  set(modelId: string): void;
}

export interface LoopAgentEngineOptions {
  /** 装配期系统提示（setSystemPrompt 直改，下一 run 生效）。 */
  readonly systemPrompt: string;
  /** LLM 流式契约执行体（llm 中立层桥/测试 mock）。 */
  readonly streamFn: LoopStreamFn;
  /** 工具注册表（工具桥 resolveLoopTools 产物装配期注册）。 */
  readonly registry: ToolRegistry;
  /** 工具轮上限（缺省 DEFAULT_LOOP_ENGINE_MAX_ROUNDS）。 */
  readonly maxRounds?: number;
  /** 批内并发上限（D9；缺省无上限）。 */
  readonly maxConcurrentTools?: number;
  /** steer 队列上限（缺省无上限）。 */
  readonly steerLimit?: number;
  /** followUp 深度上限（D4 缺省 3）。 */
  readonly followUpLimit?: number;
  /** 暂停闸（确认闸接线面；Phase 6 接 permission_request 升级）。 */
  readonly beforeToolCallPause?: LoopRunOptions["beforeToolCallPause"];
  /** 模型可观测面委托（currentModel/setModel 经此转发；缺省不实现）。 */
  readonly modelRef?: LoopEngineModelRef;
  /** 恢复回填初始 transcript（pi initialMessages 同位）。 */
  readonly initialMessages?: readonly LoopMessage[];
}

interface ToolOutcomeCapture {
  readonly toolName: string;
  readonly isError: boolean;
  readonly result: string;
}

export class LoopAgentEngineAdapter implements AgentEnginePort {
  private readonly agent: LoopAgent;
  private readonly registry: ToolRegistry;
  private readonly modelRef?: LoopEngineModelRef;
  private readonly maxRounds: number;
  private readonly beforeToolCallPause?: LoopAgentEngineOptions["beforeToolCallPause"];
  private listener: AgentEngineListener | null = null;

  // ── pi 对齐判别态（steer-drain 源标注；PiAgentEngineAdapter 同构） ──
  /** 已 steer 文本 FIFO：onNewMessage(user) 与队首同文 → steer-drain。 */
  private readonly steeredTexts: string[] = [];
  /** run 首条 user 是否 prompt（start=true/接管输入=false——豁免判别）。 */
  private runInputIsPrompt = true;
  private seenUserInRun = false;
  /** idle 暂存 steer（pi PendingMessageQueue 对齐：下一 start 的 P0 投递）。 */
  private readonly idleSteers: string[] = [];

  // ── 投影累积态（run/turn 作用域） ──
  /** run 首个 turn.started 前入账的 user 消息缓冲（prompt/接管输入）。 */
  private pendingUserMessages: LoopMessage[] = [];
  private seenTurnInRun = false;
  /** 本 turn 文本增量累积（message_end(assistant).text 投影源）。 */
  private deltaText = "";
  /** 本 turn 批 started 源序（toolResult 消息事件源序发射源）。 */
  private batchStartIds: string[] = [];
  private batchOutcomes = new Map<string, ToolOutcomeCapture>();
  /** run 内消息计数（agent_end.messageCount——onNewMessage + 缓冲 prompt）。 */
  private runMessageCount = 0;
  /** 挂闸暂停凭据 → resumeWith 句柄（engine_paused/resume 面）。 */
  private readonly pendingResumes = new Map<string, { resumeWith: (d: LoopResumeDecision) => Promise<{ kind: string }> }>();
  /** 在飞 start() 计数（abort 后台链的 listener 释放判定面）。 */
  private activeStarts = 0;
  /** abort 后台链待收口标记（run.finished 到达且无在飞 start 时释放 listener）。 */
  private clearListenerAfterAbort = false;

  constructor(options: LoopAgentEngineOptions) {
    this.registry = options.registry;
    this.modelRef = options.modelRef;
    this.maxRounds = options.maxRounds ?? DEFAULT_LOOP_ENGINE_MAX_ROUNDS;
    this.beforeToolCallPause = options.beforeToolCallPause;
    this.agent = new LoopAgent({
      streamFn: options.streamFn,
      registry: options.registry,
      emit: (event) => this.onLoopEvent(event),
      systemPrompt: options.systemPrompt,
      maxRounds: this.maxRounds,
      ...(options.maxConcurrentTools !== undefined ? { maxConcurrentTools: options.maxConcurrentTools } : {}),
      ...(options.steerLimit !== undefined ? { steerLimit: options.steerLimit } : {}),
      ...(options.followUpLimit !== undefined ? { followUpLimit: options.followUpLimit } : {}),
      onNewMessage: async (message) => {
        this.onNewMessage(message);
      },
      prepareRun: () => this.prepareRun(),
      onRunSettled: (result) => this.onRunSettled(result),
    });
    if (options.initialMessages !== undefined && options.initialMessages.length > 0) {
      this.agent.reset(options.initialMessages);
    }
  }

  // ── AgentEnginePort 实现 ────────────────────────────────

  async start(input: string, listener: AgentEngineListener, images?: readonly string[]): Promise<void> {
    this.beginPortRun(listener, true);
    this.activeStarts += 1;
    let result: Awaited<ReturnType<LoopAgent["start"]>> | undefined;
    try {
      const injection = {
        text: input,
        ...(images !== undefined && images.length > 0
          ? { images: parseDataUrlImages(images).map((i) => ({ data: i.data, mimeType: i.mimeType })) }
          : {}),
      };
      result = await this.agent.start(injection);
      // idle 暂存 steer 在 P0 前入队（agent.start 已同步占写者——steer 只入队）
      while (this.idleSteers.length > 0) {
        const text = this.idleSteers.shift()!;
        this.agent.steer({ text });
      }
      if (result.kind !== "paused") await this.agent.waitForIdle();
    } finally {
      this.activeStarts -= 1;
      if (result?.kind !== "paused" && this.activeStarts === 0 && !this.agent.isPausedPending()) {
        this.listener = null;
      }
      this.steeredTexts.length = 0; // run 边界清理（残留防下一 run 同文误判）
    }
  }

  steer(text: string): void {
    if (this.agent.isStreaming() || this.agent.isPausedPending()) {
      this.agent.steer({ text }); // 在飞/挂起：只入队（G-C/R6.8）
    } else {
      this.idleSteers.push(text); // idle：暂存至下一 start（防暗跑 run）
    }
    this.steeredTexts.push(text);
  }

  abort(): void {
    const wasPausedPending = this.agent.isPausedPending();
    this.agent.abort();
    if (wasPausedPending) {
      this.pendingResumes.clear(); // 惰性化凭据回收（kernel D5 幂等无副作用）
      // 暂停链后台收口（合成配对 + run.finished(aborted) → agent_end）——
      // listener 释放挂到链尾（run.finished 到达且无在飞 start；waitForIdle
      // 早于后台链收口不可作释放点）。
      this.clearListenerAfterAbort = true;
    }
  }

  isStreaming(): boolean {
    return this.agent.isStreaming();
  }

  currentModel(): string | undefined {
    return this.modelRef?.get();
  }

  setModel(modelId: string): void {
    if (this.modelRef === undefined) {
      throw new Error(`loop 通道未装配模型委托面（LoopAgentEngineOptions.modelRef），无法切换到 ${modelId}`);
    }
    this.modelRef.set(modelId);
  }

  setSystemPrompt(text: string): void {
    this.systemPromptState = text;
  }

  setTools(names: readonly string[]): void {
    const available = this.registry.llmTools().map((t) => t.name);
    const unknown = names.filter((n) => !available.includes(n));
    if (unknown.length > 0) {
      throw new Error(`引擎工具集直改失败：以下工具不在 loop 注册表：${unknown.join(", ")}（注册面：${available.join(", ")}）`);
    }
    this.toolNamesState = [...names];
  }

  /** 暂停恢复（port additive 面，设计 §7.4）：凭据 → resumeWith 续跑链。 */
  async resume(pauseToken: string, decision: EngineResumeDecision): Promise<void> {
    const handle = this.pendingResumes.get(pauseToken);
    if (handle === undefined) return; // 未知/已消费凭据幂等无副作用（abort 后凭据已回收）
    this.pendingResumes.delete(pauseToken);
    this.activeStarts += 1;
    try {
      const domainDecision = decision as LoopResumeDecision; // port 镜像四态同构
      await handle.resumeWith(domainDecision);
      await this.agent.waitForIdle();
    } finally {
      this.activeStarts -= 1;
      if (this.activeStarts === 0 && !this.agent.isStreaming() && !this.agent.isPausedPending()) {
        this.listener = null;
      }
    }
  }

  // ── 内部：run/turn 装配与事件投影 ────────────────────────

  private systemPromptState: string | undefined;
  private toolNamesState: readonly string[] | undefined;

  private prepareRun(): Partial<LoopRunOptions> {
    return {
      ...(this.systemPromptState !== undefined ? { systemPrompt: this.systemPromptState } : {}),
      ...(this.toolNamesState !== undefined
        ? { tools: this.registry.llmTools().filter((t) => this.toolNamesState!.includes(t.name)) }
        : {}),
      ...(this.beforeToolCallPause !== undefined ? { beforeToolCallPause: this.beforeToolCallPause } : {}),
    };
  }

  private beginPortRun(listener: AgentEngineListener, inputIsPrompt: boolean): void {
    this.listener = listener;
    this.runInputIsPrompt = inputIsPrompt;
    this.seenUserInRun = false;
    this.seenTurnInRun = false;
    this.pendingUserMessages = [];
    this.runMessageCount = 0;
  }

  private emit(event: AgentEngineEvent): void {
    this.listener?.(event);
  }

  private onLoopEvent(event: LoopEvent): void {
    switch (event.type) {
      case "loop.run.started":
        this.runMessageCount = 0;
        // 接管链暗窗兕底：steer 曾在 idle 暂存而 followUp 接管 run 已起——补推
        // 入队（本轮 P0/P1 消费，pi 队列语义对齐）。
        if (this.idleSteers.length > 0 && this.agent.isStreaming()) {
          while (this.idleSteers.length > 0) {
            const text = this.idleSteers.shift()!;
            this.agent.steer({ text });
          }
        }
        return this.emit({ type: "agent_start" });
      case "loop.run.finished":
        this.emit({ type: "agent_end", messageCount: this.runMessageCount });
        if (this.clearListenerAfterAbort && this.activeStarts === 0 && !this.agent.isStreaming() && !this.agent.isPausedPending()) {
          this.clearListenerAfterAbort = false;
          this.listener = null; // abort 后台链收口（agent_end 已发）——释放
        }
        return;
      case "loop.turn.started": {
        this.deltaText = "";
        this.batchStartIds = [];
        this.batchOutcomes.clear();
        this.emit({ type: "turn_start" });
        if (!this.seenTurnInRun) {
          // run 首个 turn：冲洗首条 user（prompt/接管输入）——pi 序 turn_start
          // 先于 message_start(user)（kernel 先记输入后起 run）；计数在此刻入账
          // （run.started 归零后——prompt 在 run.started 前入账）。
          this.seenTurnInRun = true;
          for (const message of this.pendingUserMessages) {
            this.runMessageCount += 1;
            this.emitUserMessage(message as LoopMessage & { role: "user" });
          }
          this.pendingUserMessages = [];
        }
        return;
      }
      case "loop.turn.finished": {
        // 批收口：toolResult 消息事件源序批发射（pi parallel 形态——源序取
        // started 事件序；sequential 批的逐枚交错形态是有意偏离，golden 分类注释）
        for (const id of this.batchStartIds) {
          const outcome = this.batchOutcomes.get(id);
          if (outcome === undefined) continue;
          this.emit({ type: "message_start", role: "toolResult", source: "prompt" });
          this.emit({ type: "message_end", role: "toolResult", text: outcome.result });
        }
        return this.emit({ type: "turn_end", toolResultCount: event.tools.length });
      }
      case "loop.message.started":
        return this.emit({ type: "message_start", role: "assistant", source: "prompt" });
      case "loop.message.delta":
        this.deltaText += event.delta;
        return this.emit({ type: "message_update", delta: event.delta });
      case "loop.message.finished": {
        const stopReason = event.stopReason === "toolUse" ? "toolUse" : "stop";
        // 已知缺口（findings 申报）：LoopStreamResult 无 usage 位——不携带 usage。
        return this.emit({ type: "message_end", role: "assistant", text: this.deltaText, stopReason });
      }
      case "loop.tool.started": {
        this.batchStartIds.push(event.toolCallId);
        return this.emit({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? safeParseArgsSummary(event.argsSummary),
        });
      }
      case "loop.tool.finished": {
        const outcome: ToolOutcomeCapture = {
          toolName: event.toolName,
          isError: event.isError,
          result: event.result ?? event.resultSummary,
        };
        this.batchOutcomes.set(event.toolCallId, outcome);
        return this.emit({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          result: outcome.result,
        });
      }
      case "loop.run.error":
        return this.emit({ type: "engine_error", message: event.message });
      case "loop.run.paused":
        return this.emit({
          type: "engine_paused",
          pauseToken: event.pauseToken,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argsSummary: event.argsSummary,
        });
      case "loop.context.compacted":
        if (event.status === "failed") {
          return this.emit({ type: "engine_error", message: event.error ?? "上下文压缩失败" });
        }
        return this.emit({
          type: "compaction_completed",
          tokensBefore: event.tokensBefore,
          tokensAfter: event.tokensAfter ?? 0,
          summary: event.summary ?? "",
        });
      default:
        return; // run.resumed/run.interrupted/duplex.wake/tool.progress 不投影（见件头注释）
    }
  }

  /** transcript 单写面 → 计数（全角色）+ user 消息事件合成。 */
  private onNewMessage(message: LoopMessage): void {
    if (message.role === "user" && message.text === LOOP_INTERRUPTED_MARKER_TEXT) {
      // E-198 截断标记：不投影消息事件（pi 无对应消息）但计入 messageCount
      // ——pi abort 轮的尾消息（aborted assistant）同样进 newMessages 计数
      //（golden parity：agent_end.messageCount 对齐）。
      this.runMessageCount += 1;
      return;
    }
    if (message.role !== "user") {
      this.runMessageCount += 1; // assistant（message.finished 面）/toolResult（turn.finished 面）只计数
      return;
    }
    if (!this.seenTurnInRun) {
      // run 首个 turn.started 前（prompt/接管输入入账先于 kernel 起 run）——缓冲
      this.pendingUserMessages.push(message);
      return;
    }
    this.runMessageCount += 1;
    this.emitUserMessage(message);
  }

  private emitUserMessage(message: LoopMessage & { role: "user" }): void {
    const firstUserInRun = !this.seenUserInRun;
    this.seenUserInRun = true;
    let source: "prompt" | "steer-drain" = "prompt";
    // 首条 user 豁免（start 形态）：run 间隙排队的 steer 与同文 prompt 不互串
    if (!(firstUserInRun && this.runInputIsPrompt) && this.steeredTexts.length > 0 && this.steeredTexts[0] === message.text) {
      source = "steer-drain";
      this.steeredTexts.shift();
    }
    this.emit({ type: "message_start", role: "user", source });
    this.emit({ type: "message_end", role: "user", text: message.text });
  }

  /** run settle：paused 凭据登记（resume 面）。 */
  private onRunSettled(result: Awaited<ReturnType<LoopAgent["start"]>>): void {
    if (result.kind === "paused") {
      this.pendingResumes.set(result.pauseToken, { resumeWith: result.resumeWith });
    }
  }
}

/** argsSummary 展示面防御回解（≤200 字完整 JSON 时可用；超截断回退空对象）。 */
function safeParseArgsSummary(argsSummary: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsSummary);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 截断/非 JSON——回退 */
  }
  return {};
}

/** 恢复回填映射（组合根用）：pi AgentMessage seed → LoopMessage 窗口
 *  （seedMessagesOf 产出的历史回放面——载荷位保留，记账位不回灌）。 */
export function agentMessagesToLoop(seed: readonly import("@earendil-works/pi-agent-core").AgentMessage[]): LoopMessage[] {
  const out: LoopMessage[] = [];
  for (const m of seed) {
    const role = (m as { role: string }).role;
    if (role === "system") continue; // loop 通道 systemPrompt 独立装配——system 帧不进窗口
    if (role === "user") {
      const content = (m as { content: string | readonly unknown[] }).content;
      out.push({ role: "user", text: typeof content === "string" ? content : textOfPiContent(content) });
      continue;
    }
    if (role === "assistant") {
      const blocks = (m as { content: readonly unknown[] }).content
        .map((b) => piBlockToLoop(b))
        .filter((b): b is LoopContentBlock => b !== undefined);
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (role === "toolResult") {
      const tr = m as { toolCallId: string; toolName: string; content: readonly unknown[] };
      out.push({ role: "toolResult", toolCallId: tr.toolCallId, name: tr.toolName, text: textOfPiContent(tr.content) });
    }
  }
  return out;
}

function textOfPiContent(content: readonly unknown[]): string {
  let out = "";
  for (const c of content) {
    const block = c as { type?: string; text?: string };
    if (block?.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

function piBlockToLoop(block: unknown): LoopContentBlock | undefined {
  const b = block as { type?: string; text?: string; thinking?: string; thinkingSignature?: string; id?: string; name?: string; arguments?: unknown };
  if (b?.type === "text" && typeof b.text === "string") return { type: "text", text: b.text };
  if (b?.type === "thinking" && typeof b.thinking === "string") {
    return { type: "thinking", text: b.thinking, ...(typeof b.thinkingSignature === "string" ? { signature: b.thinkingSignature } : {}) };
  }
  if (b?.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
    return { type: "toolCall", id: b.id, name: b.name, args: (b.arguments ?? {}) as Record<string, unknown> };
  }
  return undefined;
}
