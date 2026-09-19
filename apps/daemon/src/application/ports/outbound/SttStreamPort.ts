/**
 * 流式 STT（边说边转写）出站端口（outbound，V3b-1 流式转写批）。
 *
 * 实现体 = adapters/driven/stt/realtime.ts（DashScope
 * qwen3-asr-flash-realtime，冒烟证据 docs/temp/stt-streaming/DECISION.md：
 * corpus 偏置实测生效 → 单转写架构）。
 *
 * 生命周期：open（同步返回句柄——配置错误直接抛）→ 上游就绪 onStarted
 * → appendAudio 流式上行 / onInterim 实时中间帧 → finish（正常收口，
 * onFinal 终帧全文）或 abort（中止不期终帧）。回调全部同步串行调用
 * （TR-188/189 帧序纪律：final 永不在最后 interim 之前）。
 */
import type { AsrContext } from "../../stt/VocabularyBuilder";

/** 流式转写中间帧（上游 interim 透传形态；显示 = prior+text+stash）。 */
export interface SttStreamInterimFrame {
  /** 已完结句串联（首句前为空串）。 */
  readonly prior: string;
  /** 当前句已确认前缀（不会再变更）。 */
  readonly text: string;
  /** 当前句易变后缀（可能被后续帧修正）。 */
  readonly stash: string;
}

/** 流会话回调面（daemon 侧唯一事件源；同步串行——帧序纪律）。 */
export interface SttStreamCallbacks {
  /** 上游会话就绪（此后 appendAudio 即刻透传；恰一次）。 */
  onStarted(): void;
  /** 实时中间帧（高频）。 */
  onInterim(frame: SttStreamInterimFrame): void;
  /** 终帧（全部 completed 句串联；空串 = 无有效语音。终态回调）。 */
  onFinal(fullText: string): void;
  /** 流失败（握手失败/断开重连耗尽/超时；终态回调，此后无任何回调）。 */
  onError(reason: string): void;
}

/** 流会话句柄（daemon 侧命令面；终态后全部方法静默）。 */
export interface SttStreamSession {
  /** 上行音频块（base64 PCM 16k mono ~100ms；上游就绪前内部缓冲）。 */
  appendAudio(base64Pcm: string): void;
  /** 正常收口（上游 session.finish；终帧经 onFinal/onError 到达）。 */
  finish(): void;
  /** 中止（关上游不期终帧；幂等）。 */
  abort(): void;
}

/** 开流参数。 */
export interface SttStreamOpenOptions {
  /** 语言提示（ISO 639-1；缺省 = 上游自动检测）。 */
  readonly language?: string;
  /** 偏置上下文（VocabularyBuilder 产物；hint 空 = 裸转写不带 corpus）。 */
  readonly context: AsrContext;
  readonly callbacks: SttStreamCallbacks;
}

/** 流式 STT 出站端口（V3b-1）：连接级单流生命周期（SttStreamService 管辖）。 */
export interface SttStreamPort {
  /** provider id（协议回执携带，如 "dashscope"）。 */
  readonly providerId: string;
  /** 上游流式模型名（协议回执 model 字段）。 */
  readonly model: string;
  /**
   * 开流：同步返回会话句柄（配置错误——如 key 未配——直接抛中文引导）；
   * 网络握手异步进行，结果经 callbacks（onStarted 或 onError）。
   */
  open(options: SttStreamOpenOptions): SttStreamSession;
}
