/**
 * STT（语音转文字）出站端口（outbound，语音输入批 V1 Phase 1）。
 *
 * 实现体 = adapters/driven/stt/（dashscope.ts 主选 / siliconflow.ts 兜底）。
 * 上下文偏置统一经 AsrContext（application/stt/VocabularyBuilder 产物），
 * adapter 各自归一下游形态（设计 §5.6：DashScope 双通道——即时热词
 * parameters.vocabulary + 前置文本消息；SiliconFlow 走 prompt 参数）。
 *
 * key 获取经组合根 getter（auth.json provider id "dashscope"——对齐
 * model-provider.ts 的 AuthStore getter 先例：换 key 后自动跟随，不落副本）。
 */
import type { AsrContext } from "../../stt/VocabularyBuilder";

/** 转写请求（daemon handler 组装；音频 + 偏置上下文）。 */
export interface SttRequest {
  /** 音频载荷：base64 data URL（`data:audio/webm;codecs=opus;base64,…`）。 */
  audio: string;
  /** 语言提示（ISO 639-1；缺省 = provider 自动检测）。 */
  language?: string;
  /** 偏置上下文（词汇表装配产物；terms 空 = 裸转写）。 */
  context: AsrContext;
}

/** 转写结果。 */
export interface SttResult {
  /** 转写文本。 */
  text: string;
  /** 语言回显（provider 检测结果；不可得时缺席）。 */
  language?: string;
}

/** STT provider 出站端口（一次一文件转写，无流式——听写场景 3–10s 短片段）。 */
export interface SttPort {
  /** provider id（协议回执携带，如 "dashscope" / "siliconflow"）。 */
  readonly providerId: string;
  /**
   * 一次性转写。业务失败（key 未配/网络/provider 拒绝）抛 Error（message
   * 含用户可读引导）；协议面 payload 错误不在此层（handler 已前置校验）。
   */
  transcribe(request: SttRequest): Promise<SttResult>;
}
