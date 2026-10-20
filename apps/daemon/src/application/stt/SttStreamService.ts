/**
 * SttStreamService —— 连接级流式转写会话登记与协议帧组装（V3b-1）。
 *
 * 职责（hexagonal application service）：
 * - 每连接（sender 身份键）至多一条活动流；重复 start = 废弃旧流（abort）
 *   再开新流（streamId 每流新签——单飞门控判别位）；
 * - start 异步面：buildContext（词汇表装配，handler 注入）在途期间 chunk
 *   缓冲、就绪后依序冲刷（首 100-300ms 语音零丢失）；
 * - 协议帧组装（TR-188/189 帧序纪律：started/interim/final 全部同步串行
 *   emit，final 永不在 interim 之前错位——上游回调序即下发序）：
 *   · 开流前失败（provider 未知/key 未配/open 抛/buildContext 拒）→
 *     stt.stream.started error（无 streamId——shell 直接回落非流式）；
 *   · 就绪 → stt.stream.started ok（streamId/provider/model）；
 *   · onInterim → stt.stream.interim；onFinal/onError → stt.stream.final
 *     ok/error + 会话清理（final 后流关闭）；
 * - closeSender（连接断开）：abort 上游 + 清位（daemon 不持跨连接流——
 *   voice.subscribe 断连清位同构纪律）。
 *
 * provider 选择（selectSttProvider 精简同构）：显式 provider 未知名 →
 * error；缺省 = 装配序内首个已配 key 的流式 adapter；全未配 → error
 * （reason 含设置页录入引导）。
 */
import type {
  SttStreamFinalEvent,
  SttStreamInterimEvent,
  SttStreamStartedEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { SttStreamPort, SttStreamSession } from "../ports/outbound/SttStreamPort";
import type { AsrContext } from "./VocabularyBuilder";

/** 下发帧联合（stt.stream 三事件；sessionId 盖章由 start 参数携带）。 */
export type SttStreamFrame = SttStreamStartedEvent | SttStreamInterimEvent | SttStreamFinalEvent;

export interface SttStreamServiceDeps {
  /** 流式 capable adapter 装配清单（优先序）。 */
  readonly adapters: readonly SttStreamPort[];
  /** key 读面（组合根注入 authStore.apiKeyOf——每次调用重读）。 */
  readonly apiKeyOf: (providerId: string) => string | undefined;
  /** 流 id 生成器（缺省 crypto.randomUUID；测试注入固定序）。 */
  readonly newStreamId?: () => string;
}

/** start 参数。 */
export interface SttStreamStartOptions {
  /** 语言提示（透传 adapter）。 */
  readonly language?: string;
  /** provider 显式指定（缺省 = 自动选择）。 */
  readonly provider?: string;
  /** 词汇表装配（异步——P1 会话源读取；期间 chunk 缓冲）。 */
  readonly buildContext: () => Promise<AsrContext>;
  /** 协议帧信封 sessionId（命令信封回显；缺省 SYSTEM_SESSION_ID 由调用方传）。 */
  readonly sessionId: string;
  /** 帧下发面（sendNow 直发发起连接）。 */
  readonly emit: (frame: SttStreamFrame) => void;
}

/** 连接登记条目（pending 缓冲 + 活动会话）。 */
interface Entry {
  streamId: string;
  session: SttStreamSession;
  /** buildContext 在途的 chunk 缓冲（open 后冲刷）。 */
  pending: string[];
  /** buildContext 在途收到的 finish 意图（open 就绪冲刷 chunk 后补发——否则
   *  用户松手事件被占位句柄吞掉，上游永不收尾，只能等超时/dispose）。 */
  pendingFinish: boolean;
  /** started(ok) 已发（后续 onError 归 final error 语义）。 */
  startedSent: boolean;
  /** 终帧已发（流关闭）。 */
  closed: boolean;
}

export class SttStreamService {
  private readonly sessions = new Map<object, Entry>();
  private readonly adapters: readonly SttStreamPort[];
  private readonly apiKeyOf: (providerId: string) => string | undefined;
  private readonly newStreamId: () => string;

  constructor(deps: SttStreamServiceDeps) {
    this.adapters = deps.adapters;
    this.apiKeyOf = deps.apiKeyOf;
    this.newStreamId = deps.newStreamId ?? (() => crypto.randomUUID());
  }

  /** 开流（每连接单流：旧流废弃；异步装配期间 chunk 经 pending 缓冲）。 */
  start(sender: object, opts: SttStreamStartOptions): void {
    this.teardown(sender);
    const streamId = this.newStreamId();
    const entry: Entry = {
      streamId,
      // pending 占位句柄：chunk → pending 缓冲；finish 记意图（open 就绪后补发）；
      // abort 即清位（异步链看到 closed 后立即关上游或不再 open）
      session: {
        appendAudio: (a) => {
          if (!entry.closed) entry.pending.push(a);
        },
        finish: () => {
          if (!entry.closed) entry.pendingFinish = true;
        },
        abort: () => {
          entry.closed = true;
        },
      },
      pending: [],
      pendingFinish: false,
      startedSent: false,
      closed: false,
    };
    this.sessions.set(sender, entry);

    const emitStartedError = (reason: string): void => {
      if (entry.closed) return;
      entry.closed = true;
      this.sessions.delete(sender);
      opts.emit({
        v: PROTOCOL_VERSION,
        sessionId: opts.sessionId,
        channel: "stt",
        type: "stt.stream.started",
        payload: { status: "error", reason },
      });
    };

    void (async () => {
      let context: AsrContext;
      try {
        context = await opts.buildContext();
      } catch (err) {
        emitStartedError(`词汇表装配失败：${(err as Error).message}`);
        return;
      }
      const selection = this.select(opts.provider);
      if (!selection.configured) {
        emitStartedError(selection.reason);
        return;
      }
      const adapter = selection.port;
      let upstream: SttStreamSession;
      try {
        upstream = adapter.open({
          language: opts.language,
          context,
          callbacks: {
            onStarted: () => {
              if (entry.closed) return;
              entry.startedSent = true;
              opts.emit({
                v: PROTOCOL_VERSION,
                sessionId: opts.sessionId,
                channel: "stt",
                type: "stt.stream.started",
                payload: { status: "ok", streamId, provider: adapter.providerId, model: adapter.model },
              });
            },
            onInterim: (frame) => {
              if (entry.closed) return;
              opts.emit({
                v: PROTOCOL_VERSION,
                sessionId: opts.sessionId,
                channel: "stt",
                type: "stt.stream.interim",
                payload: { streamId, prior: frame.prior, text: frame.text, stash: frame.stash },
              });
            },
            onFinal: (text) => {
              if (entry.closed) return;
              entry.closed = true;
              this.sessions.delete(sender);
              opts.emit({
                v: PROTOCOL_VERSION,
                sessionId: opts.sessionId,
                channel: "stt",
                type: "stt.stream.final",
                payload: { status: "ok", streamId, text, provider: adapter.providerId },
              });
            },
            onError: (reason) => {
              if (entry.closed) return;
              entry.closed = true;
              this.sessions.delete(sender);
              if (entry.startedSent) {
                opts.emit({
                  v: PROTOCOL_VERSION,
                  sessionId: opts.sessionId,
                  channel: "stt",
                  type: "stt.stream.final",
                  payload: { status: "error", streamId, reason },
                });
              } else {
                opts.emit({
                  v: PROTOCOL_VERSION,
                  sessionId: opts.sessionId,
                  channel: "stt",
                  type: "stt.stream.started",
                  payload: { status: "error", reason },
                });
              }
            },
          },
        });
      } catch (err) {
        emitStartedError((err as Error).message);
        return;
      }
      if (entry.closed) {
        // 竞态：open 期间已 abort/废弃——立即关上游
        upstream.abort();
        return;
      }
      entry.session = upstream;
      for (const a of entry.pending) upstream.appendAudio(a);
      entry.pending = [];
      // 冲刷后再补发 pending 期 finish（顺序即语义：音频全上行后才收尾）
      if (entry.pendingFinish) {
        entry.pendingFinish = false;
        upstream.finish();
      }
    })();
  }

  /** 音频块上行（无会话静默丢弃——防御）。 */
  chunk(sender: object, audio: string): void {
    this.sessions.get(sender)?.session.appendAudio(audio);
  }

  /** 正常收口（无会话静默——shell 侧超时兜底）。 */
  finish(sender: object): void {
    this.sessions.get(sender)?.session.finish();
  }

  /** 中止（无会话静默；幂等）。 */
  stop(sender: object): void {
    const entry = this.sessions.get(sender);
    if (entry === undefined) return;
    entry.session.abort();
    this.teardown(sender);
  }

  /** 连接断开清理（abort 上游 + 清位）。 */
  closeSender(sender: object): void {
    this.stop(sender);
  }

  /** 旧流废弃（abort + 清登记）。 */
  private teardown(sender: object): void {
    const entry = this.sessions.get(sender);
    if (entry === undefined) return;
    entry.closed = true;
    entry.session.abort();
    this.sessions.delete(sender);
  }

  /** provider 选择（selectSttProvider 精简同构：仅流式 capable 清单）。 */
  private select(
    requested: string | undefined,
  ): { port: SttStreamPort; configured: true } | { port: undefined; configured: false; reason: string } {
    if (requested !== undefined) {
      const found = this.adapters.find((a) => a.providerId === requested);
      if (found === undefined) {
        return {
          port: undefined,
          configured: false,
          reason: `未知流式 STT provider "${requested}"（可用：${this.adapters.map((a) => a.providerId).join(" / ")}）`,
        };
      }
      if ((this.apiKeyOf(found.providerId) ?? "") === "") {
        return {
          port: undefined,
          configured: false,
          reason: `provider "${found.providerId}" 未录入 API key（请经设置页语音输入区 auth.set_key 录入）`,
        };
      }
      return { port: found, configured: true };
    }
    const withKey = this.adapters.find((a) => (this.apiKeyOf(a.providerId) ?? "") !== "");
    if (withKey === undefined) {
      return {
        port: undefined,
        configured: false,
        reason: `全部流式 STT provider 未录入 API key（${this.adapters.map((a) => `"${a.providerId}"`).join(" / ")}——请经设置页语音输入区 auth.set_key 录入）`,
      };
    }
    return { port: withKey, configured: true };
  }
}
