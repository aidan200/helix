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
export interface VoiceUnsubscribeCommand extends CommandFrame<Record<string, never>> {
  type: "voice.unsubscribe";
}
