/**
 * 语音转写域命令族（V1 云转写批，additive；设计：workspace docs/temp/
 * helix-voice-input-design.md §4/§6）。
 *
 * 链路：Composer 按住说话 → getUserMedia/MediaRecorder 录音（webm/opus）
 * → base64 data URL 上行（对齐图片附件协议先例 chat.send images）→ daemon
 * VocabularyBuilder 组装上下文 → STT provider 转写 → stt.transcribe.result
 * 点对点回执 → 前端草稿回填 Composer（用户确认后发送——转写结果是草稿
 * 而非直接发送，最后一道人工闸）。
 */
import type { CommandFrame } from "../envelope";

/** stt.transcribe 载荷。 */
export interface SttTranscribePayload {
  /**
   * 音频载荷：base64 data URL（`data:audio/webm;codecs=opus;base64,…`——
   * 线格式与图片附件先例同构，WS 无压力）。前端 MediaRecorder mime 选择序
   * `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4`（spike 实测支持
   * 面；daemon 侧不校验具体容器，透传 provider）。
   */
  audio: string;
  /** 录音时长毫秒（前端录制元数据；诊断用，daemon 不做硬校验）。 */
  durationMs?: number;
  /** 语言提示（ISO 639-1，如 "zh"/"en"；缺省 = provider 自动检测）。 */
  language?: string;
}

/**
 * stt.transcribe：一次性音频转写（点对点回执 stt.transcribe.result）。
 * 信封 sessionId 可选：携带时 daemon 用于会话词汇表组装（P1 会话源）与
 * 会话归属自查；省略 = 无会话裸转写（词汇表仅基础词表）。
 */
export interface SttTranscribeCommand extends CommandFrame<SttTranscribePayload> {
  type: "stt.transcribe";
}
