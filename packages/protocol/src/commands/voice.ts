/**
 * 语音播报域命令族（V2 TTS 批，additive；设计：workspace docs/temp/
 * helix-voice-agent-design.md §5.3/§6 V2 行）。
 *
 * 链路：BroadcastService 订阅 agent 生命周期事件 → 规则粗筛（完成/失败/
 * 被杀）→ 模板直出（不进 LLM）→ TtsPort 合成音频 → voice.broadcast 广播
 * 帧 → shell Audio 播放。单向播报（无监听/VAD/打断——V3 范畴）。
 *
 * - voice.synthesize：一次性合成（设置页「试听」面；点对点回执
 *   voice.synthesize.result——stt.transcribe 同构先例）；
 * - voice.subscribe / voice.unsubscribe：播报连接级订阅闸门（task.subscribe
 *   同构）——daemon 仅在存在已订阅连接时合成（默认零连接 = 零花费，开关
 *   默认 off）；voice 偏好随订阅携带（shell localStorage，V1 STT provider
 *   偏好同构存储面）。
 */
import type { CommandFrame } from "../envelope";
import type { EmptyPayload } from "./session";

/** voice.synthesize 载荷。 */
export interface VoiceSynthesizePayload {
  /** 待合成文本（空串/超长由 daemon 校验回 error）。 */
  text: string;
  /** 音色（如 "Cherry"；缺省 = daemon 默认音色）。 */
  voice?: string;
  /** 语言提示（ISO 639-1，如 "zh"；缺省 = daemon 默认中文）。 */
  language?: string;
}

/** voice.synthesize：一次性 TTS 合成（点对点回执 voice.synthesize.result）。 */
export interface VoiceSynthesizeCommand extends CommandFrame<VoiceSynthesizePayload> {
  type: "voice.synthesize";
}

/** voice.subscribe 载荷。 */
export interface VoiceSubscribePayload {
  /** 播报音色偏好（缺省 = daemon 默认音色）。 */
  voice?: string;
}

/** voice.subscribe：播报订阅（连接级闸门登记 + 音色偏好上报）。 */
export interface VoiceSubscribeCommand extends CommandFrame<VoiceSubscribePayload> {
  type: "voice.subscribe";
}

/** voice.unsubscribe：播报退订（断连自动等效——连接级状态随连接销毁）。 */
export interface VoiceUnsubscribeCommand extends CommandFrame<EmptyPayload> {
  type: "voice.unsubscribe";
}

// ── 流式 TTS 批（V3b-2：管家回答边出边合成边播）────────────────
/**
 * voice.synthesize.stream 载荷：单句流式合成（点对点；音频经
 * voice.synthesize.chunk 帧增量回推 + done/error 终态收口——无命令回执帧）。
 *
 * 句为最小单位（shell 侧 SentenceBuffer 切句后逐句发起）：daemon 对每句
 * 开一个上游 WS 任务（连接池复用），文本整句单次上行（上游自动分句），
 * finish-task 后音频帧全量下发即 done。失败回 error 判别（shell 回落
 * 一次性合成——回退链第一级）。
 */
export interface VoiceSynthesizeStreamPayload {
  /** 句标识（shell 生成、连接内唯一；chunk/done/error 帧回携带对账）。 */
  utterId: string;
  /** 待合成句文本（非空；防御上限 600 字符——句级切分产物恒短于旧一次性 500 上限 + 余量）。 */
  text: string;
  /** 音色（流式 provider 音色 id；缺省 = adapter 默认音色 longanlingxi）。 */
  voice?: string;
}

/** voice.synthesize.stream：单句流式合成（全局命令；帧回推无回执）。 */
export interface VoiceSynthesizeStreamCommand extends CommandFrame<VoiceSynthesizeStreamPayload> {
  type: "voice.synthesize.stream";
}

/**
 * voice.synthesize.stop 载荷：中正在途流式合成（静音钮/面板卸载消费）。
 * utterId 携带 = 定向取消该句；省略 = 取消该连接全部在途句。无回执
 * （已发出的 chunk 帧照旧消费，被取消句以 error 判别收口或不再发帧）。
 */
export interface VoiceSynthesizeStopPayload {
  /** 定向取消的句标识（省略 = 全部在途句）。 */
  utterId?: string;
}

/** voice.synthesize.stop：流式合成中止（全局命令；money 纪律零孤儿任务）。 */
export interface VoiceSynthesizeStopCommand extends CommandFrame<VoiceSynthesizeStopPayload> {
  type: "voice.synthesize.stop";
}
