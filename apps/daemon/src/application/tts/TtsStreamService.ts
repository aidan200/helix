/**
 * TtsStreamService —— 连接级单句流式合成登记与协议帧组装（V3b-2）。
 *
 * 职责（hexagonal application service；stt SttStreamService 同构）：
 * - 每（sender × utterId）一句会话；同连接多句并发（句间隔离——管家
 *   回答逐句发起，上一句播放期间下一句已在合成）；
 * - 协议帧组装（帧序 = 上游回调序——chunk/done/error 全部同步串行 emit）：
 *   · openUtterance 抛（key 未配/provider 不可用）→ voice.synthesize.error
 *     帧（shell 回落一次性合成的回退链入口）；
 *   · onAudio → voice.synthesize.chunk（utterId/seq 句内 1 起单调）；
 *   · onDone → voice.synthesize.done（provider/frames=最大 seq）；
 *   · onError → voice.synthesize.error（utterId/reason）；
 * - stop（voice.synthesize.stop）：定向（utterId）/全量（省略）abort 上游；
 *   已取消句的终态回调静默（不再发帧——静音钮语义：停当前句+丢队列，
 *   shell 侧队列丢弃 + daemon 侧任务取消双管齐下）；
 * - closeSender（连接断开）：全量 abort 清位（daemon 不持跨连接流——
 *   voice.subscribe 断连清位同构纪律；money 零孤儿任务）。
 */
import type {
  VoiceSynthesizeChunkEvent,
  VoiceSynthesizeDoneEvent,
  VoiceSynthesizeErrorEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { TtsStreamPort, TtsStreamSession } from "../ports/outbound/TtsStreamPort";

/** 下发帧联合（voice.synthesize 三帧；sessionId 盖章由 utter 参数携带）。 */
export type TtsStreamFrame = VoiceSynthesizeChunkEvent | VoiceSynthesizeDoneEvent | VoiceSynthesizeErrorEvent;

export interface TtsStreamServiceDeps {
  /** 流式 capable adapter 装配清单（当前 dashscope 单选——留扩位）。 */
  readonly adapters: readonly TtsStreamPort[];
  /** key 读面（组合根注入 authStore.apiKeyOf——每次调用重读）。 */
  readonly apiKeyOf: (providerId: string) => string | undefined;
}

/** utter 参数。 */
export interface TtsStreamUtterOptions {
  /** 句标识（shell 生成、连接内唯一）。 */
  readonly utterId: string;
  /** 整句文本（handler 已校验非空 ≤ 上限）。 */
  readonly text: string;
  /** 音色偏好（缺省 = adapter 默认）。 */
  readonly voice?: string;
  /** 协议帧信封 sessionId（命令信封回显）。 */
  readonly sessionId: string;
  /** 帧下发面（sendNow 直发发起连接）。 */
  readonly emit: (frame: TtsStreamFrame) => void;
}

/** 句登记条目。 */
interface Entry {
  readonly session: TtsStreamSession;
  /** 句内单调序号（1 起）。 */
  seq: number;
  /** 终态已收口（取消/完成/失败——此后回调静默）。 */
  closed: boolean;
}

export class TtsStreamService {
  /** 连接 → （utterId → 句会话）。 */
  private readonly bySender = new Map<object, Map<string, Entry>>();
  private readonly adapters: readonly TtsStreamPort[];
  private readonly apiKeyOf: (providerId: string) => string | undefined;

  constructor(deps: TtsStreamServiceDeps) {
    this.adapters = deps.adapters;
    this.apiKeyOf = deps.apiKeyOf;
  }

  /** 开句（重复 utterId = 废旧句再开新句——防御；正常链路 shell 保证唯一）。 */
  utter(sender: object, opts: TtsStreamUtterOptions): void {
    const bucket = this.bucketOf(sender);
    const existing = bucket.get(opts.utterId);
    if (existing !== undefined) {
      existing.closed = true;
      existing.session.abort();
    }
    const adapter = this.select();
    const emitError = (reason: string): void => {
      opts.emit({
        v: PROTOCOL_VERSION,
        sessionId: opts.sessionId,
        channel: "voice",
        type: "voice.synthesize.error",
        payload: { utterId: opts.utterId, reason },
      });
    };
    if (adapter === undefined) {
      emitError("流式 TTS provider 未装配（daemon 组合根未注册）");
      return;
    }
    if (!adapter.configured) {
      emitError(`provider "${adapter.port.providerId}" 未录入 API key（请经设置页语音区 auth.set_key 录入）`);
      return;
    }
    const port = adapter.port;
    let entry: Entry | undefined;
    try {
      const session = port.openUtterance({
        text: opts.text,
        ...(opts.voice !== undefined ? { voice: opts.voice } : {}),
        callbacks: {
          onAudio: (audio) => {
            if (entry === undefined || entry.closed) return;
            entry.seq += 1;
            opts.emit({
              v: PROTOCOL_VERSION,
              sessionId: opts.sessionId,
              channel: "voice",
              type: "voice.synthesize.chunk",
              payload: { utterId: opts.utterId, seq: entry.seq, audio },
            });
          },
          onDone: () => {
            if (entry === undefined || entry.closed) return;
            entry.closed = true;
            const frames = entry.seq;
            bucket.delete(opts.utterId);
            opts.emit({
              v: PROTOCOL_VERSION,
              sessionId: opts.sessionId,
              channel: "voice",
              type: "voice.synthesize.done",
              payload: { utterId: opts.utterId, provider: port.providerId, frames },
            });
          },
          onError: (reason) => {
            if (entry === undefined || entry.closed) return;
            entry.closed = true;
            bucket.delete(opts.utterId);
            emitError(reason);
          },
        },
      });
      entry = { session, seq: 0, closed: false };
      bucket.set(opts.utterId, entry);
    } catch (err) {
      emitError((err as Error).message);
    }
  }

  /** 中止（utterId 定向；省略 = 该连接全部在途句）。 */
  stop(sender: object, utterId?: string): void {
    const bucket = this.bySender.get(sender);
    if (bucket === undefined) return;
    for (const [id, entry] of [...bucket.entries()]) {
      if (utterId !== undefined && id !== utterId) continue;
      entry.closed = true;
      entry.session.abort();
      bucket.delete(id);
    }
  }

  /** 连接断开清理（abort 全部在途句 + 清位）。 */
  closeSender(sender: object): void {
    this.stop(sender);
    this.bySender.delete(sender);
  }

  private bucketOf(sender: object): Map<string, Entry> {
    let bucket = this.bySender.get(sender);
    if (bucket === undefined) {
      bucket = new Map();
      this.bySender.set(sender, bucket);
    }
    return bucket;
  }

  /** provider 选择（缺省 = 首个已配 key 的 adapter；全未配 → error 帧由调用侧发）。 */
  private select(): { port: TtsStreamPort; configured: boolean } | undefined {
    for (const port of this.adapters) {
      const configured = (this.apiKeyOf(port.providerId) ?? "") !== "";
      if (configured) return { port, configured: true };
    }
    const first = this.adapters[0];
    return first === undefined ? undefined : { port: first, configured: false };
  }
}
