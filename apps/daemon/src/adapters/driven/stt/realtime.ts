/**
 * DashScope realtime 流式 STT adapter（driven；V3b-1 流式转写批）。
 *
 * 模型 qwen3-asr-flash-realtime（Realtime 事件协议；冒烟实测
 * docs/temp/stt-streaming/DECISION.md——2026-09-19 真实 key 全链验证）：
 * - 握手 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=…` +
 *   `Authorization: Bearer` 头（通用域名，无需 workspace id）；
 * - open 后发 session.update（input_audio_format pcm / sample_rate 16000 /
 *   input_audio_transcription{language?, corpus?{text=hint}} /
 *   turn_detection server_vad 400ms——低延迟断句口径）；session.updated
 *   回执后流就绪（此前 append 缓冲）；
 * - 上行 input_audio_buffer.append（base64 PCM；服务端不逐块回执）；
 * - 下行 conversation.item.input_audio_transcription.text{text,stash}
 *   （interim——显示 = prior+text+stash）、.completed{transcript}（句终，
 *   全文 = 逐句串联）、session.finished（终态）；
 * - corpus 偏置 = VocabularyBuilder hint（词表匹配生效机制，与非流式
 *   qwen-audio-3.0-asr 的上下文通道同族——术语接得住，实测 interim+final
 *   均带偏置）。corpus 在公开 client-events 文档未列（SDK 源码有据）——
 *   未文档化风险由 shell 回落非流式链路兜底（协议 stt.stream.final error）。
 *
 * 生命周期纪律（spike 事实）：
 * - 60s 无音频关流（服务端 FAQ 口径的安全阀；money 纪律——上游 WS 只在
 *   listening 窗口存活，正常链路 shell 的 VAD ~2s 早停，60s 只是兜底）；
 * - 意外断连重连恰一次：新 WS + session.update + 已上行音频重放（重放
 *   缓冲 60s 上限，防内存无界）+ finishRequested 补发；再断 → onError；
 * - finish 后终帧超时（8s）兜底：有已识别文本 → best-effort onFinal；
 *   无 → onError。
 *
 * key：组合根 getter（auth.json provider id "dashscope"，与非流式
 * dashscope.ts 同源）；缺 key fail-fast 抛中文错误（指向设置页录入路径）。
 * WS 工厂与定时器面注入（测试 fake——零真实网络）。
 */
import type {
  SttStreamCallbacks,
  SttStreamOpenOptions,
  SttStreamPort,
  SttStreamSession,
} from "../../../application/ports/outbound/SttStreamPort";

/**
 * 最小 WS 客户端面（Bun global WebSocket 同构；测试 fake 注入）。
 * message 事件 data 载荷经 ev.data 取（文本帧）。
 */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
}

import type { AsrContext } from "../../../application/stt/VocabularyBuilder";
import { DEFAULT_VOICE_MODEL_CONFIG } from "../../../application/voice/voiceModelConfig";

/** V3b-1 主选流式 ASR 模型（Realtime 事件协议族）。
 *  别名 = voiceModelConfig 默认值单源字段（模型配置接入 P0；getModel 可覆盖）。 */
export const DASHSCOPE_ASR_REALTIME_MODEL = DEFAULT_VOICE_MODEL_CONFIG.sttRealtimeModel;

/** realtime WS 端点（通用域名——无需 workspace id，冒烟实测）。 */
const REALTIME_WS_BASE = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

/** 60s 无音频关流（服务端 FAQ 口径安全阀）。 */
export const STT_STREAM_IDLE_MS = 60_000;

/** finish 后终帧等待上限（超时 best-effort 收口）。 */
export const STT_STREAM_FINAL_TIMEOUT_MS = 8_000;

/** 断连重连的音频重放缓冲上限（ms；防内存无界——超限从头部丢弃）。 */
const REPLAY_MAX_MS = 60_000;

/** 100ms/片的标称节奏（重放缓冲条数上限换算）。 */
const CHUNK_MS = 100;

export interface DashScopeRealtimeSttDeps {
  /** 当前 provider key getter（组合根注入 authStore.apiKeyOf；每次调用重读）。 */
  readonly getApiKey: () => string | undefined;
  /** 模型 id getter（可选——模型配置接入 P0；每次调用读现值；空/undefined 回落默认）。 */
  readonly getModel?: () => string | undefined;
  /** WS 工厂（缺省 Bun global WebSocket——headers 透传 Bearer；测试注入 fake）。 */
  readonly wsFactory?: (url: string, headers: Record<string, string>) => RealtimeSocket;
  /** 定时器面（缺省 setTimeout；测试注入手工时钟）。 */
  readonly setTimer?: (cb: () => void, ms: number) => number;
  readonly clearTimer?: (id: number) => void;
}

/** 会话内部状态机。 */
type Phase = "connecting" | "ready" | "closed";

export class DashScopeRealtimeSttAdapter implements SttStreamPort {
  readonly providerId = "dashscope";
  private readonly getApiKey: () => string | undefined;
  private readonly getModel: (() => string | undefined) | undefined;
  private readonly wsFactory: (url: string, headers: Record<string, string>) => RealtimeSocket;
  private readonly setTimer: (cb: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  constructor(deps: DashScopeRealtimeSttDeps) {
    this.getApiKey = deps.getApiKey;
    this.getModel = deps.getModel;
    this.wsFactory = deps.wsFactory ?? defaultWsFactory;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown as number);
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as unknown as Parameters<typeof clearTimeout>[0]));
  }

  /** 生效模型 id（配置值优先；空/未配回落默认常量；SttStreamService 回执 model 随之反映配置）。 */
  get model(): string {
    return this.getModel?.()?.trim() || DASHSCOPE_ASR_REALTIME_MODEL;
  }

  open(options: SttStreamOpenOptions): SttStreamSession {
    const apiKey = this.getApiKey();
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        `auth.json 中没有 provider "dashscope" 的 API key（请经设置页语音输入区 auth.set_key 录入；显式传入，不走环境变量）`,
      );
    }
    return new RealtimeSession(apiKey, this.model, options, this.wsFactory, this.setTimer, this.clearTimer);
  }
}

/** 缺省 WS 工厂：Bun global WebSocket（headers 扩展为 Bun 支持）。 */
function defaultWsFactory(url: string, headers: Record<string, string>): RealtimeSocket {
  return new WebSocket(url, { headers }) as unknown as RealtimeSocket;
}

/** 单流会话（一流一 WS；重连换 WS 不换句柄）。 */
class RealtimeSession implements SttStreamSession {
  private ws: RealtimeSocket;
  private phase: Phase = "connecting";
  private readonly apiKey: string;
  /** open 时点定格的模型 id（配置热改不重连——会话内协议参数不变）。 */
  private readonly model: string;
  private readonly language: string | undefined;
  private readonly hint: string;
  private readonly cb: SttStreamCallbacks;
  private readonly wsFactory: (url: string, headers: Record<string, string>) => RealtimeSocket;
  private readonly setTimer: (cb: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  private eventId = 0;
  private startedSent = false;
  private finishRequested = false;
  private reconnectsUsed = 0;
  private itemFailures = 0;
  private completedText = "";
  /** 就绪前缓冲 + 重连重放清单（同源：append 即入列）。 */
  private readonly replayLog: string[] = [];
  private idleTimer: number | undefined;
  private finalTimer: number | undefined;

  constructor(
    apiKey: string,
    model: string,
    options: SttStreamOpenOptions,
    wsFactory: (url: string, headers: Record<string, string>) => RealtimeSocket,
    setTimer: (cb: () => void, ms: number) => number,
    clearTimer: (id: number) => void,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.language = options.language;
    this.hint = options.context.hint;
    this.cb = options.callbacks;
    this.wsFactory = wsFactory;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.ws = this.connect();
  }

  appendAudio(base64Pcm: string): void {
    if (this.phase === "closed") return;
    this.replayLog.push(base64Pcm);
    // 重放缓冲上限（60s 标称节奏；超限从头部丢弃——best-effort 重连）
    const cap = Math.ceil(REPLAY_MAX_MS / CHUNK_MS);
    if (this.replayLog.length > cap) this.replayLog.splice(0, this.replayLog.length - cap);
    this.armIdleTimer();
    if (this.phase !== "ready") return; // 就绪前缓冲（session.updated 后冲刷）
    this.sendAppend(base64Pcm);
  }

  finish(): void {
    if (this.phase === "closed" || this.finishRequested) return;
    this.finishRequested = true;
    if (this.phase === "ready") {
      this.sendJson({ type: "session.finish", event_id: this.nextEventId() });
      this.armFinalTimer();
    }
  }

  abort(): void {
    if (this.phase === "closed") return;
    this.die();
    try {
      this.ws.close();
    } catch {
      // 已关闭等——幂等静默
    }
  }

  // ── 内部 ────────────────────────────────────────────────

  private connect(): RealtimeSocket {
    const url = `${REALTIME_WS_BASE}?model=${encodeURIComponent(this.model)}`;
    const ws = this.wsFactory(url, { Authorization: `Bearer ${this.apiKey}` });
    ws.addEventListener("open", () => this.onOpen());
    ws.addEventListener("message", (ev) => this.onMessage(String((ev as { data?: unknown }).data)));
    ws.addEventListener("close", () => this.onClose());
    return ws;
  }

  private onOpen(): void {
    if (this.phase === "closed") return;
    // corpus 偏置 = 词汇表 hint（词表匹配生效机制；空 = 裸转写不带 corpus）
    const transcription: Record<string, unknown> = {};
    if (this.language !== undefined) transcription.language = this.language;
    if (this.hint !== "") transcription.corpus = { text: this.hint };
    this.sendJson({
      type: "session.update",
      event_id: this.nextEventId(),
      session: {
        input_audio_format: "pcm",
        sample_rate: 16000,
        input_audio_transcription: transcription,
        // 400ms 静音断句（官方推荐低延迟档；shell 侧 VAD 1.8s 收口不受影响——
        // 多句 completed 串联即全文）
        turn_detection: { type: "server_vad", threshold: 0, silence_duration_ms: 400 },
      },
    });
  }

  private onMessage(raw: string): void {
    if (this.phase === "closed") return;
    let msg: { type?: string; text?: string; stash?: string; transcript?: string; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // 非 JSON 帧防御
    }
    switch (msg.type) {
      case "session.updated":
        // 首连就绪与重连就绪同路径：冲刷重放缓冲 + 补发 finish（竞态）
        if (this.phase === "connecting") {
          this.phase = "ready";
          for (const a of this.replayLog) this.sendAppend(a);
          this.armIdleTimer();
          if (this.finishRequested) {
            this.sendJson({ type: "session.finish", event_id: this.nextEventId() });
            this.armFinalTimer();
          }
          if (!this.startedSent) {
            this.startedSent = true;
            this.cb.onStarted();
          }
        }
        return;
      case "conversation.item.input_audio_transcription.text":
        this.cb.onInterim({ prior: this.completedText, text: msg.text ?? "", stash: msg.stash ?? "" });
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.completedText += msg.transcript ?? "";
        return;
      case "conversation.item.input_audio_transcription.failed":
        this.itemFailures += 1;
        return;
      case "session.finished":
        this.finishUp(this.completedText);
        return;
      case "error":
        this.dieWith(`上游错误：${msg.error?.message ?? "未知"}`);
        return;
      default:
        return; // session.created / speech_started 等观测帧不消费
    }
  }

  private onClose(): void {
    if (this.phase === "closed") return;
    // 意外断连（非 abort/终态路径）：重连恰一次
    if (this.reconnectsUsed < 1) {
      this.reconnectsUsed += 1;
      this.clearTimers();
      this.phase = "connecting";
      try {
        this.ws.close();
      } catch {
        // 已关闭——幂等
      }
      this.ws = this.connect();
      return;
    }
    this.dieWith("上游连接断开（重连额度耗尽）");
  }

  private sendAppend(audio: string): void {
    this.sendJson({ type: "input_audio_buffer.append", event_id: this.nextEventId(), audio });
  }

  private sendJson(obj: Record<string, unknown>): void {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      // 连接已死——close 路径接管
    }
  }

  private nextEventId(): string {
    this.eventId += 1;
    return `hx-${this.eventId}`;
  }

  private armIdleTimer(): void {
    if (this.idleTimer !== undefined) this.clearTimer(this.idleTimer);
    this.idleTimer = this.setTimer(() => {
      if (this.phase === "closed" || this.finishRequested) return;
      this.dieWith(`${STT_STREAM_IDLE_MS / 1000} 秒无音频，流已关闭（请检查录音链路）`);
    }, STT_STREAM_IDLE_MS);
  }

  private armFinalTimer(): void {
    this.clearFinalTimer();
    this.finalTimer = this.setTimer(() => {
      if (this.phase === "closed") return;
      // best-effort 收口：有已识别文本给 final，无文本给 error
      if (this.completedText !== "") this.finishUp(this.completedText);
      else this.dieWith("终帧等待超时");
    }, STT_STREAM_FINAL_TIMEOUT_MS);
  }

  private clearFinalTimer(): void {
    if (this.finalTimer !== undefined) {
      this.clearTimer(this.finalTimer);
      this.finalTimer = undefined;
    }
  }

  private finishUp(text: string): void {
    if (this.phase === "closed") return;
    this.die();
    try {
      this.ws.close();
    } catch {
      // 幂等
    }
    if (text === "" && this.itemFailures > 0) {
      this.cb.onError("识别失败（上游逐句失败且无有效文本）");
      return;
    }
    this.cb.onFinal(text);
  }

  private dieWith(reason: string): void {
    if (this.phase === "closed") return;
    this.die();
    try {
      this.ws.close();
    } catch {
      // 幂等
    }
    this.cb.onError(reason);
  }

  /** 终态收口（清计时器；不发回调——调用方决定 final/error）。 */
  private die(): void {
    this.phase = "closed";
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.idleTimer !== undefined) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.clearFinalTimer();
  }
}
