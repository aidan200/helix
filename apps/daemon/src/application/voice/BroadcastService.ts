/**
 * BroadcastService —— V2 TTS 播报管道 application service（设计 §5.3
 * 播报管道①②③层：规则粗筛 + 极简终态通知（回退面）+ LLM 白话摘要）。
 *
 * 职责分层（任务总结子功能批重构）：**内容生产归管家任务总结子功能**
 * （③层 LLM 摘要——管家开 ∧ 总结开 ∧ 总结模型已配三条件全满足才走；
 * 专用槽位 steward.summary.model，无默认模型），**语音播报只负责播**
 * （粗筛/闸门/队列/合成/广播，不关心内容生产）。
 *
 * 链路：fanout 带名目标 voice-broadcast-bridge（wireEventFanout 装配）→
 * onDomainEvent → ①粗筛（V2 播报集合 = agent.completed/failed/killed 三
 * 终态；开始类默认不播——噪声控制，设计 §7-1）→ 闸门（连接级 voice 订阅
 * 零登记 = 直接丢弃——零 LLM 零合成零花费，播报开关默认 off 的落地面；
 * ③层摘要也花钱，gate 覆盖到 LLM 层：无订阅即不发起摘要调用）→ ③LLM
 * 摘要（closure 摘要 → ≤2 句口语化中文播报稿——closure 原文是给 agent
 * 看的机械结果，播报是给人听的：LLM 做维度转换，摘要自然控长；超时/
 * 失败/面不可用回退②层**极简终态通知**——不念 agentId（UUID 逐字播报
 * 无意义）/closure 摘要（技术黑话截断后听不懂）/error 原文（英文报错念
 * 出来是噪声）——旧「模板直出」回退面已判负价值退役，极简通知只报终态
 * 本身，详情归视觉面 closure 通知行）→ 播放队列（串行合成串行发；上限
 * 5 条溢出丢最旧、下一条合并「另有 N 条已跳过」提示）→ TtsPort 合成 →
 * emit 广播帧（EventStream.broadcastVoice——仅发已订阅连接）。
 *
 * 串行保序：摘要挂在 drained 链上按事件到达序逐条进行（LLM 耗时不均
 * 不乱序——播报序 = 事件序）。
 *
 * 单向播报（无监听/VAD/打断——V3 范畴）；合成失败跳过该条不中断后续
 * （warn 观测，不向用户面发错误帧——播报是旁路增强面）。
 */
import type { DomainEvent, DomainEventType } from "../../domain/events/DomainEvent";
import type { AgentCompletedPayload, AgentFailedPayload, AgentKilledPayload } from "../../domain/events/DomainEvent";
import type { TtsPort } from "../ports/outbound/TtsPort";
import type { VoiceSummarizerPort } from "../ports/outbound/VoiceSummarizerPort";
import type { VoiceBroadcastPayload } from "@helix/protocol";

/** V2 播报集合（①层规则粗筛单源）：三终态；扩集合改此处 + 测试同步。 */
const BROADCAST_EVENT_TYPES: ReadonlySet<string> = new Set(["agent.completed", "agent.failed", "agent.killed"]);

/** 粗筛判定（纯函数，测试单点）。 */
export function isBroadcastEligible(type: DomainEventType | string): boolean {
  return BROADCAST_EVENT_TYPES.has(type);
}

/** LLM 摘要产物截断上限（~80 字符防长播——③层摘要产物防御：prompt 约束
 * ≤60 字但 LLM 可能不听话，超长截断兜底；②层极简通知恒短不触发）。 */
export const SUMMARY_MAX_CHARS = 80;

/** ③层 LLM 摘要超时上限（超时回退②层极简终态通知；测试经 deps.summaryTimeoutMs 注入覆盖）。 */
export const SUMMARY_TIMEOUT_MS = 8000;

/** ③层摘要输入侧保护：closure 摘要喂给 LLM 的长度上限（防 prompt 爆炸；输出长度由 prompt 约束）。 */
const SUMMARY_INPUT_MAX_CHARS = 2000;

/** ③层摘要角色指令（systemPrompt 单点）：closure → 人话的维度转换规则。 */
export const SUMMARY_SYSTEM_PROMPT = [
  "你是 helix 语音播报的摘要员：把 agent 任务的终态信息改写成给人听的播报稿。",
  "要求：",
  "- 口语化中文，不超过 2 句，总长不超过 60 字；",
  "- 只保留对人有用的关键结论：任务做成了什么、为什么失败、因何被终止；",
  "- 技术细节（文件路径、命令、堆栈、英文术语）只留能听懂的关键结论，说大白话；",
  "- 失败信息必须包含失败原因的人话版本；",
  "- 直接输出播报稿本身，不要前缀、引号、列表或任何解释。",
].join("\n");

/** 播放队列上限（溢出丢最旧合并提示）。 */
export const QUEUE_LIMIT = 5;

/** 溢出合并提示模板（下一条播报 text 前缀）。 */
const DROPPED_NOTE = (n: number): string => `（另有 ${n} 条较早播报已跳过）`;

/** 队列条目（占位-激活双态）：事件到达即占位（②层极简通知文本），③层摘要
 * 完成后替换激活（失败/超时回退占位文本）；pump 只消费 ready 前缀。 */
interface QueueItem {
  /** 占位关联键（接受序，单源）。 */
  readonly id: number;
  readonly kind: VoiceBroadcastPayload["kind"];
  readonly agentId: string;
  /** 播报文本（占位 = ②层极简通知；激活时替换为摘要产物）。 */
  text: string;
  /** false = 占位（摘要未完成，pump 停在其后保序）；true = 可消费。 */
  ready: boolean;
}

/** 摘要截断（超长加省略号；空摘要原样——③层 LLM 产物防御：prompt 约束
 * ≤60 字但可能不听话，超长截断兑底；②层极简通知恒短不触发）。 */
function truncateSummary(summary: string): string {
  if (summary.length <= SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, SUMMARY_MAX_CHARS)}…`;
}

/** 摘要输入侧截断（③层喂 LLM 的保护面；超长加省略号）。 */
function truncateInput(summary: string): string {
  if (summary.length <= SUMMARY_INPUT_MAX_CHARS) return summary;
  return `${summary.slice(0, SUMMARY_INPUT_MAX_CHARS)}…`;
}

/**
 * 极简终态通知（②层，纯函数；③层的回退面）：终态三事件 → 可听懂的最小
 * 信息量播报——只报终态本身，不念 agentId（UUID 逐字念无意义）/closure
 * 摘要（技术黑话 80 截断后听不懂）/error 原文（英文报错是噪声）；详情归
 * 视觉面（closure 通知行/会话卡片）。非播报集合事件返回 undefined（粗筛
 * 负例）。
 */
export function buildBroadcastText(event: DomainEvent): string | undefined {
  switch (event.type) {
    case "agent.completed":
      return "后台任务已完成";
    case "agent.failed":
      return "后台任务失败";
    case "agent.killed":
      return "后台任务已终止";
    default:
      return undefined;
  }
}

/**
 * 摘要 userPrompt（③层，纯函数）：终态事件事实全文（closure 摘要原文不
 * 截断至 80——LLM 看全貌才能摘要；输入侧另有 2000 字符保护）。非播报
 * 集合事件返回 undefined。
 */
export function buildSummaryUserPrompt(event: DomainEvent): string | undefined {
  switch (event.type) {
    case "agent.completed": {
      const p = event.payload as AgentCompletedPayload;
      return `事件：任务完成\nagent：${p.agentId}\nclosure 摘要：${truncateInput(p.closure.summary ?? "")}`;
    }
    case "agent.failed": {
      const p = event.payload as AgentFailedPayload;
      const error = p.error !== undefined && p.error !== "" ? p.error : (p.closure.summary ?? "");
      return `事件：任务失败\nagent：${p.agentId}\n错误信息：${truncateInput(error)}\nclosure 摘要：${truncateInput(p.closure.summary ?? "")}`;
    }
    case "agent.killed": {
      const p = event.payload as AgentKilledPayload;
      return `事件：任务被终止\nagent：${p.agentId}\nclosure 摘要：${truncateInput(p.closure.summary ?? "")}`;
    }
    default:
      return undefined;
  }
}

/** 播报闸门读面（EventStream 连接级 voice 订阅表的窄接口注入——方法名与 EventStream 同构）。 */
export interface BroadcastGate {
  /** 是否存在已订阅连接（零连接 = 零 LLM 零合成零花费）。 */
  hasVoiceSubscribers(): boolean;
  /** 当前音色偏好（最近一次订阅携带；无偏好 = undefined → adapter 默认）。 */
  voicePreference(): string | undefined;
}

export interface BroadcastServiceDeps {
  readonly tts: TtsPort;
  /** 广播帧出口（组合根接 EventStream.broadcastVoice 的载荷面）。 */
  readonly emit: (payload: VoiceBroadcastPayload) => void;
  /** 连接级订阅闸门读面。 */
  readonly gate: BroadcastGate;
  /** ③层 LLM 摘要面（可选：undefined = ②层极简通知——纯测试/降级形态）。 */
  readonly summarizer?: VoiceSummarizerPort;
  /** 摘要超时上限 ms（可选，缺省 SUMMARY_TIMEOUT_MS；测试注入面）。 */
  readonly summaryTimeoutMs?: number;
  readonly logger?: { warn(message: string): void };
}

export class BroadcastService {
  private readonly tts: TtsPort;
  private readonly emit: (payload: VoiceBroadcastPayload) => void;
  private readonly gate: BroadcastGate;
  private readonly summarizer?: VoiceSummarizerPort;
  private readonly summaryTimeoutMs: number;
  private readonly logger?: { warn(message: string): void };

  private queue: QueueItem[] = [];
  private droppedCount = 0;
  private processing = false;
  private seq = 0;
  private acceptSeq = 0;
  private drained: Promise<void> = Promise.resolve();

  constructor(deps: BroadcastServiceDeps) {
    this.tts = deps.tts;
    this.emit = deps.emit;
    this.gate = deps.gate;
    this.summarizer = deps.summarizer;
    this.summaryTimeoutMs = deps.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS;
    this.logger = deps.logger;
  }

  /** fanout 目标入口（wireEventFanout voice-broadcast-bridge 装配）。 */
  onDomainEvent(event: DomainEvent): void {
    if (!isBroadcastEligible(event.type)) return;
    // 闸门（money gate）：无订阅连接直接丢弃——不摘要（LLM 花钱）不合成不排队
    if (!this.gate.hasVoiceSubscribers()) return;
    const fallback = buildBroadcastText(event);
    if (fallback === undefined) return;
    const kind = event.type as VoiceBroadcastPayload["kind"];
    const agentId = (event.payload as { agentId: string }).agentId;
    // 同步占位（②层极简通知文本）：溢出丢弃判定在事件到达面（同旧语义——burst
    // 连发即限流，不等摘要完成）；③层摘要完成后替换激活，挂 drained 链按
    // 到达序串行（耗时不均不乱序）。
    this.acceptSeq += 1;
    const id = this.acceptSeq;
    this.enqueuePlaceholder({ id, kind, agentId, text: fallback, ready: false });
    this.drained = this.drained.then(() => this.summarizeAndActivate(event, id, fallback));
  }

  /**
   * 测试收口面：等待在途摘要/合成队列清空（生产不调用——fire-and-forget）。
   * 串行保证：drained 链逐条 await（摘要+合成），processing 序防 pump 重入。
   */
  async drain(): Promise<void> {
    await this.drained;
    while (this.processing || this.queue.some((item) => item.ready)) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** 摘要 + 激活 + 泵（drained 链上单步；任何异常吞掉防断链——回退面在 summarize 内收口）。 */
  private async summarizeAndActivate(event: DomainEvent, id: number, fallback: string): Promise<void> {
    try {
      const text = await this.summarize(event, fallback);
      const item = this.queue.find((q) => q.id === id);
      if (item === undefined) {
        // 占位已被溢出丢弃（在途条目被更早事件挤出——链上摘要已花费，观测后放行）
        this.logger?.warn(`语音播报摘要完成但条目已被溢出丢弃（id=${id}）：跳过播报`);
        return;
      }
      item.text = text;
      item.ready = true;
      await this.pump();
    } catch (err) {
      // 兜底（summarize/pump 内部已各自捕获；此处保 drained 链不断——断链即后续事件全哑）
      this.logger?.warn(`语音播报处理异常（跳过 id=${id}）：${(err as Error).message}`);
    }
  }

  /** ③层摘要：面可用 → LLM 白话摘要（超时/抛错/空文本回退②层极简通知）。 */
  private async summarize(event: DomainEvent, fallback: string): Promise<string> {
    const summarizer = this.summarizer;
    if (summarizer === undefined || !summarizer.isAvailable()) return fallback;
    const userPrompt = buildSummaryUserPrompt(event);
    if (userPrompt === undefined) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = summarizer.complete({ systemPrompt: SUMMARY_SYSTEM_PROMPT, userPrompt });
      call.catch(() => undefined); // 超时后迟到 rejection 兜底（防 unhandled rejection）
      const text = await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`LLM 摘要超时（>${this.summaryTimeoutMs}ms，回退极简通知）`)),
            this.summaryTimeoutMs,
          );
        }),
      ]);
      const trimmed = text.trim();
      if (trimmed === "") return fallback; // 空摘要回退（极简通知）
      return truncateSummary(trimmed); // LLM 产物超长防御（prompt 约束外兑底）
      return trimmed;
    } catch (err) {
      this.logger?.warn(`LLM 播报摘要失败（回退②层极简通知）：${(err as Error).message}`);
      return fallback;
    } finally {
      if (timer !== undefined) clearTimeout(timer); // 快速路径清 timer（防泄漏）
    }
  }

  /** 入队占位（溢出丢最旧——含在途占位；dropped 计入下一条合并提示）。 */
  private enqueuePlaceholder(item: QueueItem): void {
    if (this.queue.length >= QUEUE_LIMIT) {
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push(item);
  }

  /** 串行泵：ready 前缀逐条（合成 → 广播），异常隔离跳过后续；队头占位
   * （摘要未完成）即停——保序，等对应链步激活后再泵。 */
  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && this.queue[0]!.ready) {
        const item = this.queue.shift()!;
        let text = item.text;
        let dropped: number | undefined;
        if (this.droppedCount > 0) {
          dropped = this.droppedCount;
          text = `${DROPPED_NOTE(dropped)}${text}`;
          this.droppedCount = 0;
        }
        const voice = this.gate.voicePreference();
        try {
          const result = await this.tts.synthesize({
            text,
            ...(voice !== undefined ? { voice } : {}),
          });
          this.seq += 1;
          this.emit({
            kind: item.kind,
            agentId: item.agentId,
            text,
            audio: result.audio,
            provider: this.tts.providerId,
            ...(voice !== undefined ? { voice } : {}),
            seq: this.seq,
            ...(dropped !== undefined ? { droppedCount: dropped } : {}),
          });
        } catch (err) {
          // 合成失败跳过该条不中断后续（旁路增强面——warn 观测即可）
          this.logger?.warn(`语音播报合成失败（跳过 ${item.agentId}）：${(err as Error).message}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
