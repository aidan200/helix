/**
 * 流式 TTS（单句边合成边回推）出站端口（outbound，V3b-2 流式 TTS 批）。
 *
 * 实现体 = adapters/driven/tts/streaming.ts（DashScope qwen-audio-3.0-tts-flash
 * 任务型 WS 协议，真实 key 冒烟证据 docs/temp/tts-streaming/DECISION.md：
 * 首包 425-552ms / 连接复用 run-task→task-started ~90ms / 帧 19200B=400ms）。
 *
 * 生命周期：openUtterance（同步返回句柄——key 未配等配置错误直接抛）→
 * 音频增量 onAudio（base64 PCM 16bit mono 24kHz）→ onDone（句终态，音频已
 * 全量回调）或 onError（句失败终态）。abort = 中止（finish-task
 * directive=cancel；不期终态回调）。回调同步串行调用（帧序纪律：帧序 =
 * 上游回调序）。
 */

/** 单句回调面（daemon 侧唯一事件源；终态后无任何回调）。 */
export interface TtsStreamCallbacks {
  /** 增量音频帧（高频；base64 PCM 16bit mono 24kHz）。 */
  onAudio(base64Pcm: string): void;
  /** 句正常终态（音频已全量下发）。 */
  onDone(): void;
  /** 句失败（握手失败/上游断开/超时；终态回调）。 */
  onError(reason: string): void;
}

/** 单句会话句柄（终态后全部方法静默）。 */
export interface TtsStreamSession {
  /** 中止本句（上游 cancel；幂等）。 */
  abort(): void;
}

/** 开句参数。 */
export interface TtsStreamOpenOptions {
  /** 整句文本（调用方保证非空且已切句——单次 continue-task 上行）。 */
  readonly text: string;
  /** 音色（provider 音色 id；缺省 = adapter 默认音色）。 */
  readonly voice?: string;
  readonly callbacks: TtsStreamCallbacks;
}

/** 流式 TTS 出站端口（V3b-2）：单句生命周期（TtsStreamService 管辖多句并发）。 */
export interface TtsStreamPort {
  /** provider id（协议回执携带，如 "dashscope"）。 */
  readonly providerId: string;
  /** 上游流式模型名（协议回执 model 字段）。 */
  readonly model: string;
  /**
   * 开句：同步返回会话句柄（配置错误——如 key 未配——直接抛中文引导）；
   * 网络握手异步进行，结果经 callbacks（onDone/onError 终态收口）。
   */
  openUtterance(options: TtsStreamOpenOptions): TtsStreamSession;
}
