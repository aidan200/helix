/**
 * BroadcastService —— TTS 播报队列 application service。
 *
 * 职责（2026-10-08 用户裁决「白话播报重构」后收口）：**纯队列面**——接收
 * 直供文本（enqueueDiagnosed：任务终态机械短讯 / 会话回复详略轨 / 保底
 * 白话句），串行合成串行广播（闸门 → 队列 → TtsPort → emit 广播帧）。
 *
 * 退役面（裁决原文）：任务终态锚机械化（任务状态是机械事实，零 LLM）；
 * 任务内 agent 状态**完全不播报**（用户只关心任务整体）——原 agent 级
 * 事件播报集合（①层粗筛 + ②层极简终态通知 + 内容源回调链）整体退役，
 * fanout voice-broadcast-bridge 已拆除。文字截断单源归感知服务
 * （present ≤60 / detail ≤600），本层不再二次截断。
 *
 * 队列语义（保留）：串行合成串行发（顺序保证）；上限 5 条溢出丢最旧、
 * 下一条合并「另有 N 条已跳过」提示；闸门（连接级 voice 订阅零登记 =
 * 零入队零合成零花费）；合成失败跳过该条不中断后续（warn 观测——播报
 * 是旁路增强面，不向用户面发错误帧）。
 */
import type { TtsPort } from "../ports/outbound/TtsPort";
import type { VoiceBroadcastPayload } from "@helix/protocol";

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

/** 播放队列上限（溢出丢最旧合并提示）。 */
export const QUEUE_LIMIT = 5;

/** 溢出合并提示模板（下一条播报 text 前缀）。 */
const DROPPED_NOTE = (n: number): string => `（另有 ${n} 条较早播报已跳过）`;

/** 队列条目（直供即 ready——内容生产全在感知服务收口）。 */
interface QueueItem {
  readonly kind: VoiceBroadcastPayload["kind"];
  readonly agentId: string;
  readonly text: string;
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

  constructor(deps: BroadcastServiceDeps) {
    this.tts = deps.tts;
    this.emit = deps.emit;
    this.gate = deps.gate;
    this.logger = deps.logger;
  }

  /**
   * 直供播报面（唯一入口）：StewardPerceptionService 供文本（任务终态
   * 机械短讯 / 会话回复详略轨 / 保底白话句——文本生产与截断单源归感知
   * 服务），入队即播；闸门单点保持（无订阅连接 = 零入队零合成）。
   */
  enqueueDiagnosed(item: { kind: VoiceBroadcastPayload["kind"]; agentId: string; text: string }): void {
    if (!this.gate.hasVoiceSubscribers()) return;
    this.enqueue({ kind: item.kind, agentId: item.agentId, text: item.text });
    void this.pump();
  }

  /** 测试收口面：等待合成队列清空（生产不调用——fire-and-forget）。 */
  async drain(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** 入队（溢出丢最旧；dropped 计入下一条合并提示）。 */
  private enqueue(item: QueueItem): void {
    if (this.queue.length >= QUEUE_LIMIT) {
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push(item);
  }

  /** 串行泵：逐条（合成 → 广播），异常隔离跳过后续。 */
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
