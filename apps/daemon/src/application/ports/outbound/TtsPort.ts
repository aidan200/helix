/**
 * TTS（文字转语音）出站端口（outbound，语音播报批 V2）。
 *
 * 实现体 = adapters/driven/tts/（dashscope.ts 主选）。端口形态面向
 * 「一次一句」的短播报场景（设计 §5.3 ①②层产物），但接口不绑死传输：
 * HTTP 一次性（V2 dashscope）与 WS 流式（V3 全双工 cosyvoice 复用本端口
 * 的 providerId/请求载荷语义——流式 adapter 聚合为整段 data URL 返回即可）。
 *
 * key 获取经组合根 getter（auth.json provider id "dashscope"——与 STT 共用
 * 同一条目；对齐 model-provider.ts 的 AuthStore getter 先例：换 key 后自动
 * 跟随，不落副本）。
 */

/** 合成请求（BroadcastService 模板直出 / 设置页试听两入口共用）。 */
export interface TtsRequest {
  /** 待合成文本（调用方负责长度治理——V2 播报模板已截断 ~80 字符）。 */
  text: string;
  /** 音色（provider 音色 id；缺省 = adapter 默认音色）。 */
  voice?: string;
  /** 语言提示（ISO 639-1；缺省 = adapter 默认中文）。 */
  language?: string;
}

/** 合成结果。 */
export interface TtsResult {
  /** 合成音频：base64 data URL（`data:audio/wav;base64,…`——与图片附件/
   * STT 上行同构线格式；shell Audio 直播）。 */
  audio: string;
}

/** TTS provider 出站端口（一次一短句；无流式回调面——V3 流式聚合后返回）。 */
export interface TtsPort {
  /** provider id（协议回执/广播帧携带，如 "dashscope"）。 */
  readonly providerId: string;
  /**
   * 一次性合成。业务失败（key 未配/网络/provider 拒绝）抛 Error（message
   * 含用户可读引导）；协议面 payload 错误不在此层（handler 已前置校验）。
   */
  synthesize(request: TtsRequest): Promise<TtsResult>;
}
