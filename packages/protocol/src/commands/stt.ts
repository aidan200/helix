/**
 * 语音转写域命令族（V1 云转写批 + V3b-1 流式转写批，additive；设计：
 * workspace docs/temp/helix-voice-input-design.md §4/§6 + stt-streaming-v3b1
 * DECISION.md）。
 *
 * 链路（V1 一次性）：Composer 按住说话 → getUserMedia/MediaRecorder 录音
 *（webm/opus）→ base64 data URL 上行（对齐图片附件协议先例 chat.send
 * images）→ daemon VocabularyBuilder 组装上下文 → STT provider 转写 →
 * stt.transcribe.result 点对点回执 → 前端草稿回填 Composer（用户确认后
 * 发送——转写结果是草稿而非直接发送，最后一道人工闸）。
 *
 * 链路（V3b-1 流式）：管家语音模式 listening 态 → stt.stream.start（daemon
 * 建 DashScope realtime WS，corpus 偏置 = VocabularyBuilder 产物）→
 * stt.stream.chunk（100ms base64 PCM 16k mono 音频块上行）→ daemon 透传
 * 上游并解析 interim 帧下发 stt.stream.interim → VAD 停 →
 * stt.stream.finish（上游 session.finish）→ stt.stream.final（终帧全文）
 * → shell 直喂 steward.ask；stt.stream.stop = 中止（面板卸载/废弃流，
 * 不期 final）。帧序纪律：interim/final 同连接同流按序下发（streamId 单飞
 * 门控判别位）。
 */
import type { CommandFrame } from "../envelope";
import type { EmptyPayload } from "./session";

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
  /**
   * STT provider 选择（"dashscope" / "siliconflow"；设置页用户偏好随命令
   * 传入）。缺省 = daemon 自动选择：优先序内首个已配 key 的 provider；全部
   * 未配 → error 回执（含设置页录入引导）。
   */
  provider?: string;
}

/**
 * stt.transcribe：一次性音频转写（点对点回执 stt.transcribe.result）。
 * 信封 sessionId 可选携带且**被 daemon 消费**：携带时用于会话词汇表组装
 * （P1 会话源）+ 会话归属自查；省略 = 无会话裸转写（词汇表仅基础词表）。
 * 归类澄清：本命令**不属**「全局命令省略 sessionId」族（E-84 全局族清单
 * 与本条归类冲突时，以 daemon handlers/stt.ts 的消费现实为准——另有
 * stt.stream.start 同口径）。shell 侧 sttTranscribeCommand 已透出该参数。
 */
export interface SttTranscribeCommand extends CommandFrame<SttTranscribePayload> {
  type: "stt.transcribe";
}

/** stt.stream.start 载荷（V3b-1 流式转写批）。 */
export interface SttStreamStartPayload {
  /** 语言提示（ISO 639-1，如 "zh"；缺省 = provider 自动检测）。 */
  language?: string;
  /** STT provider 选择（缺省 = daemon 自动选择首个支持流式且已配 key 的
   *  provider；当前唯一支持 = "dashscope"）。非流式 capable provider
   *（如 siliconflow）→ stt.stream.started error 回执（shell 回落非流式链路）。 */
  provider?: string;
}

/**
 * stt.stream.start：开流（点对点回执 stt.stream.started 两判别；本命令
 * 信封 sessionId 可选——故不按「全局命令省略 sessionId」归类）。
 * 连接级生命周期：每连接同时至多一条活动流；重复 start = 废弃旧流（abort
 * 旧上游）再开新流。信封 sessionId 携带时 daemon 组装会话词汇表进 corpus
 * 偏置（语义同 stt.transcribe，**已被消费**）。
 * ⚠ 能力悬空登记：shell 侧 sttStreamStartCommand 当前**未透出** sessionId
 * ——协议能力已备而 UI 链路不可达（语音模式 corpus 暂无会话词汇表偏置）；
 * 消费方勿假定已偏置，接线需与构造器同动。
 */
export interface SttStreamStartCommand extends CommandFrame<SttStreamStartPayload> {
  type: "stt.stream.start";
}

/** stt.stream.chunk 载荷。 */
export interface SttStreamChunkPayload {
  /**
   * 音频块：base64 编码的裸 PCM（16kHz / 16bit / mono，~100ms ≈ 3200B）。
   * 上游 DashScope realtime 协议 input_audio_buffer.append 透传（服务端
   * 不逐块回执——本命令无 ack，吞吐优先）。无活动流时静默丢弃（防御）。
   */
  audio: string;
}

/** stt.stream.chunk：音频块上行（无回执；高频帧——payload 仅 audio 一字段）。 */
export interface SttStreamChunkCommand extends CommandFrame<SttStreamChunkPayload> {
  type: "stt.stream.chunk";
}

/**
 * stt.stream.finish：正常收口（VAD 停/点击停后发送；上游 session.finish
 * → 尾段识别 → stt.stream.final 终帧。final 后流关闭，连接回到无流态）。
 */
export interface SttStreamFinishCommand extends CommandFrame<EmptyPayload> {
  type: "stt.stream.finish";
}

/**
 * stt.stream.stop：中止（面板卸载/切模式废弃/新 start 顶旧流；关上游不发
 * session.finish、不期 final——已计费音频不退，但停止后续上行）。
 */
export interface SttStreamStopCommand extends CommandFrame<EmptyPayload> {
  type: "stt.stream.stop";
}
