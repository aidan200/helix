/**
 * BroadcastService —— V2 TTS 播报管道 application service（设计 §5.3
 * 播报管道①②层：规则粗筛 + 模板直出；③LLM 归纳留 V2.5 管家）。
 *
 * 链路：fanout 带名目标 voice-broadcast-bridge（wireEventFanout 装配）→
 * onDomainEvent → ①粗筛（V2 播报集合 = agent.completed/failed/killed 三
 * 终态；开始类默认不播——噪声控制，设计 §7-1）→ 闸门（连接级 voice 订阅
 * 零登记 = 直接丢弃——零合成零花费，播报开关默认 off 的落地面）→ ②模板
 * 直出（中文模板不进 LLM；closure 摘要截断 ~80 字符防长播）→ 播放队列
 * （串行合成串行发；上限 5 条溢出丢最旧、下一条合并「另有 N 条已跳过」
 * 提示）→ TtsPort 合成 → emit 广播帧（EventStream.broadcastVoice——仅发
 * 已订阅连接）。
 *
 * 单向播报（无监听/VAD/打断——V3 范畴）；合成失败跳过该条不中断后续
 * （warn 观测，不向用户面发错误帧——播报是旁路增强面）。
 */
import type { DomainEvent, DomainEventType } from "../../domain/events/DomainEvent";
import type { AgentCompletedPayload, AgentFailedPayload, AgentKilledPayload } from "../../domain/events/DomainEvent";
import type { TtsPort } from "../ports/outbound/TtsPort";
import type { VoiceBroadcastPayload } from "@helix/protocol";

/** V2 播报集合（①层规则粗筛单源）：三终态；扩集合改此处 + 测试同步。 */
const BROADCAST_EVENT_TYPES: ReadonlySet<string> = new Set(["agent.completed", "agent.failed", "agent.killed"]);

/** 粗筛判定（纯函数，测试单点）。 */
export function isBroadcastEligible(type: DomainEventType | string): boolean {
  return BROADCAST_EVENT_TYPES.has(type);
}

/** closure 摘要播报截断上限（~80 字符防长播——设计 §5.3 ②层口径）。 */
export const SUMMARY_MAX_CHARS = 80;

/** 播放队列上限（溢出丢最旧合并提示）。 */
export const QUEUE_LIMIT = 5;

/** 溢出合并提示模板（下一条播报 text 前缀）。 */
const DROPPED_NOTE = (n: number): string => `（另有 ${n} 条较早播报已跳过）`;

/** 队列条目（粗筛+模板产物；合成时消费）。 */
interface QueueItem {
  readonly kind: VoiceBroadcastPayload["kind"];
  readonly agentId: string;
  readonly text: string;
}

/** 摘要截断（超长加省略号；空摘要原样）。 */
function truncateSummary(summary: string): string {
  if (summary.length <= SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, SUMMARY_MAX_CHARS)}…`;
}

/**
 * 模板直出（②层，纯函数）：终态三事件 → 中文播报文本。
 * 非播报集合事件返回 undefined（粗筛负例）。
 */
export function buildBroadcastText(event: DomainEvent): string | undefined {
  switch (event.type) {
    case "agent.completed": {
      const p = event.payload as AgentCompletedPayload;
      return `${p.agentId} 已完成：${truncateSummary(p.closure.summary ?? "")}`;
    }
    case "agent.failed": {
      const p = event.payload as AgentFailedPayload;
      const reason = p.error !== undefined && p.error !== "" ? p.error : (p.closure.summary ?? "");
      return `${p.agentId} 失败：${truncateSummary(reason)}`;
    }
    case "agent.killed": {
      const p = event.payload as AgentKilledPayload;
      return `${p.agentId} 已终止：${truncateSummary(p.closure.summary ?? "")}`;
    }
    default:
      return undefined;
  }
}

/** 播报闸门读面（EventStream 连接级 voice 订阅表的窄接口注入——方法名与 EventStream 同构）。 */
export interface BroadcastGate {
  /** 是否存在已订阅连接（零连接 = 零合成零花费）。 */
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
  readonly logger?: { warn(message: string): void };
}

export class BroadcastService {
  private readonly tts: TtsPort;
  private readonly emit: (payload: VoiceBroadcastPayload) => void;
  private readonly gate: BroadcastGate;
  private readonly logger?: { warn(message: string): void };

  private queue: QueueItem[] = [];
  private droppedCount = 0;
  private processing = false;
  private seq = 0;
  private drained: Promise<void> = Promise.resolve();

  constructor(deps: BroadcastServiceDeps) {
    this.tts = deps.tts;
    this.emit = deps.emit;
    this.gate = deps.gate;
    this.logger = deps.logger;
  }

  /** fanout 目标入口（wireEventFanout voice-broadcast-bridge 装配）。 */
  onDomainEvent(event: DomainEvent): void {
    if (!isBroadcastEligible(event.type)) return;
    // 闸门（money gate）：无订阅连接直接丢弃——不合成不排队
    if (!this.gate.hasVoiceSubscribers()) return;
    const text = buildBroadcastText(event);
    if (text === undefined) return;
    const kind = event.type as VoiceBroadcastPayload["kind"];
    const agentId = (event.payload as { agentId: string }).agentId;
    if (this.queue.length >= QUEUE_LIMIT) {
      // 溢出丢最旧（合成尚未发生的条目；dropped 计入下一条合并提示）
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push({ kind, agentId, text });
    this.drained = this.drained.then(() => this.pump());
  }

  /**
   * 测试收口面：等待在途合成队列清空（生产不调用——fire-and-forget）。
   * 串行保证：pump 全程持 processing 序（drain 链逐条 await）。
   */
  async drain(): Promise<void> {
    await this.drained;
    while (this.processing || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** 串行泵：一次一条（合成 → 广播），异常隔离跳过后续。 */
  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
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
