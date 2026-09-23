/**
 * steward-voice-machine —— 管家语音模式纯状态机面（V3a；零 React 零 IO，
 * AG-14 纯函数纪律——逻辑可测面与设备/协议面分离，rms-meter 先例同构）。
 *
 * 职责四件（消费端 = features/steward/model/useStewardVoice 组合钩子）：
 * - deriveStewardVoicePhase：子状态聚合（录音链/ask 在途/朗读）→ 面板唯一
 *   阶段事实源（面板视觉不吃多布尔——互斥态派生单点）；
 * - shouldSpeakReply：TTS money 纪律闸——语音模式 + 设置偏好开 + answer
 *   终态三条件缺一不可（文本模式零发声；error/confirm_required 不合成）；
 * - mdToSpeechText：Markdown 回复 → 语音文本（代码块剥离——读代码无意义；
 *   标记剥离；daemon voice.synthesize 500 字符硬上限对齐截断）；
 * - planTranscript：转写出路——ask 发出即续语音链；发送失败回填草稿
 *   （文本态可重试，零静默丢话——submit 同语义）；
 * - barge-in 门面（B2，V3b-3 全双工触发面）：isBargeInArmed（可打断相位
 *   判定）+ stepBargeInGate（RMS 帧驱动门——阈值 + 持续时长双条件防单帧
 *   尖峰，停播残响静默窗 + fired 闩锁防重复触发）+ openBargeInSilenceWindow
 *   （停播即开窗）——打断序本体在消费端（stopSpeaking → steward.interrupt
 *   → 新转写流），本面只裁决「这一帧算不算人声插话」。
 */
import { VOICE_MIN_DURATION_MS, VOICE_RMS_THRESHOLD, type VoiceState } from "@/shared/lib/useVoiceInput";

/** 面板输入双模（互斥；打开默认语音模式——mic 不可用自动回退文本态）。 */
export type StewardInputMode = "voice" | "text";

/** 语音模式阶段（面板可视化状态机的呈现面）。 */
export type StewardVoicePhase =
  | "unsupported" // mic 环境不可用（getUserMedia/MediaRecorder 缺失）
  | "idle" // 待命（可点 mic 开始说话）
  | "listening" // 录音中（VAD 静音 ~1.8s 自动停）
  | "transcribing" // 音频上传 + 转写在途
  | "asking" // steward.ask 在途（流式 Markdown 回答中）
  | "speaking"; // TTS 朗读回复中

/** 阶段派生输入面（子状态聚合快照）。 */
export interface StewardVoiceSnapshot {
  readonly voiceState: VoiceState;
  readonly askInFlight: boolean;
  readonly speaking: boolean;
}

/**
 * 阶段派生（优先级 = 录音链在途 > ask 在途 > 朗读 > 待命）：
 * 新一轮说话压过上轮残留态（录音/转写期间旧朗读已由消费端停读）。
 */
export function deriveStewardVoicePhase(s: StewardVoiceSnapshot): StewardVoicePhase {
  if (s.voiceState === "unsupported") return "unsupported";
  if (s.voiceState === "recording") return "listening";
  if (s.voiceState === "transcribing") return "transcribing";
  if (s.askInFlight) return "asking";
  if (s.speaking) return "speaking";
  return "idle";
}

/** 朗读闸输入面（ask 终态判别 + 模式 + 偏好）。 */
export interface SpeakReplyGateInput {
  readonly mode: StewardInputMode;
  readonly speakEnabled: boolean;
  readonly askResult: { readonly status: string };
}

/** money 纪律朗读闸：仅「语音模式 × 偏好开 × answer 终态」朗读一次。 */
export function shouldSpeakReply(input: SpeakReplyGateInput): boolean {
  return input.mode === "voice" && input.speakEnabled && input.askResult.status === "answer";
}

/** daemon voice.synthesize 文本硬上限（handlers/voice.ts SYNTHESIZE_TEXT_MAX，
 *  text.length 口径；超限走 commandError 协议面错误——客户端前置截断防打）。 */
export const STEWARD_SPEECH_TEXT_MAX = 500;

/**
 * Markdown → 语音文本：
 * - fenced 代码块整块剥离（` 读代码无意义零花费）；行内 code 剥标记留内容；
 * - 加粗/斜体/删除线/标题/引用/列表标记剥除；链接/图片取可见文本；
 * - 空白折叠；产物超长截断至 daemon 上限（length 口径对齐）。
 * 纯代码块回复 → 空串（消费端据此跳过合成）。
 */
export function mdToSpeechText(md: string, max = STEWARD_SPEECH_TEXT_MAX): string {
  const stripped = md
    // fenced 代码块（```lang … ```，容忍未闭合尾块）
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    // 图片 ![alt](url) → alt（朗读可读面）；链接 [text](url) → text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 行内 code 剥反引号留内容
    .replace(/`([^`]*)`/g, "$1")
    // 标题井号 / 引用符 / 列表标记（行首 - * + 或数字点）
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    // 强调标记（**bold** / *em* / __bold__ / _em_ / ~~del~~）
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    // 水平线
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    // 空白折叠
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** 转写出路（ask 发送结果 → 面板动作面）。 */
export type TranscriptOutcome =
  | { readonly kind: "asked" }
  | { readonly kind: "fallback"; readonly draft: string };

/** 转写文本出路裁决：发出 → 语音链续（等回答）；未发出 → 草稿回填可重试。 */
export function planTranscript(text: string, askSent: boolean): TranscriptOutcome {
  if (askSent) return { kind: "asked" };
  return { kind: "fallback", draft: text };
}

// ── B2 barge-in 门判定（V3b-3 全双工触发面；fake meter 帧驱动可测）──────

/** 停播残响静默窗（ms）：停播/触发后窗口内零再触发（防 TTS 残响自触发）。
 *  双条件时长档（B3 门限分档/双参判定另批）。 */
export const BARGE_IN_SILENCE_WINDOW_MS = 300;

/** barge-in 门状态（纯数据；帧间递推）。 */
export interface BargeInGateState {
  /** 连续超阈段起点（ms；null = 当前静音/未起算）。 */
  readonly loudSinceMs: number | null;
  /** 静默窗截止（ms；此前零触发——残响防线）。 */
  readonly muteUntilMs: number;
  /** fired 闩锁：本轮已触发（武装续帧零二次触发——重复触发幂等）；
   *  解除武装帧复位（下一轮可再触发）。 */
  readonly fired: boolean;
}

/** 门初态。 */
export const INITIAL_BARGE_IN_GATE: BargeInGateState = { loudSinceMs: null, muteUntilMs: 0, fired: false };

/** 门输入（单帧；阈值/时长缺省 = useVoiceInput 现成常量同源）。 */
export interface BargeInGateInput {
  /** 本帧 RMS（0..1，rms-meter 节流 ~100ms/帧）。 */
  readonly rms: number;
  /** 本帧时戳（ms）。 */
  readonly atMs: number;
  /** 门已武装（speaking/asking 相位 × 语音模式——isBargeInArmed）。 */
  readonly armed: boolean;
  /** 有声阈值（缺省 VOICE_RMS_THRESHOLD）。 */
  readonly threshold?: number;
  /** 最短持续（ms；缺省 VOICE_MIN_DURATION_MS）。 */
  readonly minDurationMs?: number;
  /** 触发/停播静默窗（ms；缺省 BARGE_IN_SILENCE_WINDOW_MS）。 */
  readonly silenceWindowMs?: number;
}

/** 门输出（新状态 + 本帧是否触发）。 */
export interface BargeInGateOutcome {
  readonly state: BargeInGateState;
  readonly trigger: boolean;
}

/**
 * barge-in 门单帧递推（纯函数）：
 * - 解除武装帧：闩锁复位（下一轮可再触发）；静默窗保留（残响防线跨轮）；
 * - fired 闩锁置位：武装续帧零二次触发（幂等），直到解除武装复位；
 * - 静默窗内：零触发且累积清零（窗内声不计持续——残响不计人声）；
 * - 双条件：rms ≥ 阈值且持续 ≥ minDurationMs 的帧才触发（单帧尖峰不触发
 *   ——敲键/瞬时噪声）；触发帧自带静默窗（触发即停播）。
 */
export function stepBargeInGate(state: BargeInGateState, input: BargeInGateInput): BargeInGateOutcome {
  const threshold = input.threshold ?? VOICE_RMS_THRESHOLD;
  const minDurationMs = input.minDurationMs ?? VOICE_MIN_DURATION_MS;
  const silenceWindowMs = input.silenceWindowMs ?? BARGE_IN_SILENCE_WINDOW_MS;
  const carry = { muteUntilMs: state.muteUntilMs, fired: state.fired };
  if (!input.armed) {
    return { state: { loudSinceMs: null, muteUntilMs: state.muteUntilMs, fired: false }, trigger: false };
  }
  if (state.fired) return { state, trigger: false };
  if (input.atMs < state.muteUntilMs) {
    return { state: { loudSinceMs: null, ...carry, fired: false }, trigger: false };
  }
  if (input.rms < threshold) {
    return { state: { loudSinceMs: null, ...carry }, trigger: false };
  }
  if (state.loudSinceMs === null) {
    return { state: { loudSinceMs: input.atMs, ...carry }, trigger: false };
  }
  if (input.atMs - state.loudSinceMs < minDurationMs) return { state, trigger: false };
  return {
    state: { loudSinceMs: null, muteUntilMs: input.atMs + silenceWindowMs, fired: true },
    trigger: true,
  };
}

/** 停播即开静默窗（静音钮/打断停播共用——残响防线）；闩锁同帧复位。 */
export function openBargeInSilenceWindow(
  state: BargeInGateState,
  atMs: number,
  windowMs = BARGE_IN_SILENCE_WINDOW_MS,
): BargeInGateState {
  return { loudSinceMs: null, muteUntilMs: atMs + windowMs, fired: false };
}

/** 门武装判定（相位派生扩展）：仅「语音模式 ×（speaking | asking）」可打断
 *  ——text 模式/mic 不可用/idle/listening/transcribing 行为不变。 */
export function isBargeInArmed(input: { mode: StewardInputMode; phase: StewardVoicePhase }): boolean {
  return input.mode === "voice" && (input.phase === "speaking" || input.phase === "asking");
}
