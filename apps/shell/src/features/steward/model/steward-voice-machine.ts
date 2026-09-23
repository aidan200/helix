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
 *   判定）+ stepBargeInGate（RMS×ZCR 帧驱动门——阈值 + 持续时长 + 人声带
 *   判据防单帧尖峰/敲键，B3 双参判定 + 门限分档；停播残响静默窗 + fired
 *   闩锁防重复触发）+ openBargeInSilenceWindow（停播即开窗）——打断序本体
 *   在消费端（stopSpeaking → steward.interrupt → 新转写流），本面只裁决
 *   「这一帧算不算人声插话」；
 * - matchWakeWord（B4 唤醒词门槛）：待命态流式转写文本的本地匹配——命中
 *   （大小写不敏感）→ 剥离唤醒词前缀返剩余话语；未命中零产出；空串 = 关
 *   门槛直通（命中判定在 webview 本地，命中前内容不入对话）。
 */
import { VOICE_MIN_DURATION_MS, VOICE_RMS_THRESHOLD, type VoiceState } from "@/shared/lib/useVoiceInput";

/** 面板输入双模（互斥；打开默认语音模式——mic 不可用自动回退文本态）。 */
export type StewardInputMode = "voice" | "text";

/** 语音模式阶段（面板可视化状态机的呈现面）。 */
export type StewardVoicePhase =
  | "unsupported" // mic 环境不可用（getUserMedia/MediaRecorder 缺失）
  | "idle" // 待命（可点 mic 开始说话）
  | "wake_armed" // 唤醒待命（B4：组合键开麦，等唤醒词命中；命中前内容不入对话）
  | "listening" // 录音中（VAD 静音 ~1.8s 自动停）
  | "transcribing" // 音频上传 + 转写在途
  | "asking" // steward.ask 在途（流式 Markdown 回答中）
  | "speaking"; // TTS 朗读回复中

/** 阶段派生输入面（子状态聚合快照）。 */
export interface StewardVoiceSnapshot {
  readonly voiceState: VoiceState;
  readonly askInFlight: boolean;
  readonly speaking: boolean;
  /** B4 唤醒待命位（命中前 true——录音 × wakeStandby → wake_armed；缺省
   *  false 既有派生不变）。 */
  readonly wakeStandby?: boolean;
}

/**
 * 阶段派生（优先级 = 录音链在途 > ask 在途 > 朗读 > 待命）：
 * 新一轮说话压过上轮残留态（录音/转写期间旧朗读已由消费端停读）。
 * B4：录音 × 唤醒待命 → wake_armed（命中后同为 recording 但待命位落下
 * → 转入既有 listening 流——「命中 → listening → transcribing → asking」同链）。
 */
export function deriveStewardVoicePhase(s: StewardVoiceSnapshot): StewardVoicePhase {
  if (s.voiceState === "unsupported") return "unsupported";
  if (s.voiceState === "recording") return s.wakeStandby === true ? "wake_armed" : "listening";
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

// ── B4 唤醒词门槛（本地文本匹配；命中判定在 webview 零后置花费）────────

/** 唤醒匹配结果：hit=false 零产出；hit=true 携剥离唤醒词前缀后的剩余话语。 */
export type WakeMatch =
  | { readonly hit: false; readonly rest: "" }
  | { readonly hit: true; readonly rest: string };

/**
 * 唤醒词本地匹配（纯函数）：
 * - 唤醒词空（trim 后）= 关门槛直通：hit 恒真、全文即剩余话语；
 * - 命中 = 文本内首次出现（大小写不敏感）：剥离唤醒词**及其之前**的全部
 *   内容（命中前的转写内容不入对话），余下为剩余话语；
 * - 未命中 → hit=false（消费端据此零 ask）。
 */
export function matchWakeWord(text: string, wakeWord: string): WakeMatch {
  const word = wakeWord.trim();
  if (word === "") return { hit: true, rest: text };
  const idx = text.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) return { hit: false, rest: "" };
  return { hit: true, rest: text.slice(idx + word.length) };
}

// ── B2 barge-in 门判定（V3b-3 全双工触发面；fake meter 帧驱动可测）──────

/** 停播残响静默窗（ms）：停播/触发后窗口内零再触发（防 TTS 残响自触发）。
 *  可参数化（设置面 silence-window 偏好）；双条件时长档见 B3 门限分档/双参判定。 */
export const BARGE_IN_SILENCE_WINDOW_MS = 300;

// ── B3 回声防线（双参判定 + 门限分档）────────────────────────

/** 门限分档系数（B3 ②线）：speaking/asking 相位（TTS 自声经空气/机身回灌
 *  窗口）基准阈值抬档防自触发；listening 相位维持基准灵敏度。固定档位
 *  （不暴露强度参数——灵敏度基准已可调，档位系数属内部回声防护逻辑）。 */
export const BARGE_IN_ECHO_THRESHOLD_SCALE = 3;

/** 人声带下界（ZCR 每样本过零率）：低于此 = 直流/低频隆隆，非浊音带。 */
export const VOICE_ZCR_MIN = 0.01;

/** 容忍带强度 0（严格档）人声带上界：宽带脉冲/键盘声主要落此上。 */
export const VOICE_ZCR_MAX_STRICT = 0.25;

/** 容忍带强度 100（宽容档）人声带上界：清音/齿音 ZCR 偏高不误杀。 */
export const VOICE_ZCR_MAX_LENIENT = 0.45;

/** ZCR 判定缺省容忍带强度（0-100；严格/宽容中档）。 */
export const VOICE_ZCR_TOLERANCE_DEFAULT = 50;

/** 容忍带强度 → 人声带上界（线性映射；越界强度钳制）。 */
export function zcrVoiceBandCeiling(tolerance: number = VOICE_ZCR_TOLERANCE_DEFAULT): number {
  const t = Math.max(0, Math.min(100, tolerance)) / 100;
  return VOICE_ZCR_MAX_STRICT + t * (VOICE_ZCR_MAX_LENIENT - VOICE_ZCR_MAX_STRICT);
}

/** 双参判定人声带判据：ZCR 落 [VOICE_ZCR_MIN, 上界（容忍带强度驱动）]。 */
export function zcrInVoiceBand(zcr: number, tolerance: number = VOICE_ZCR_TOLERANCE_DEFAULT): boolean {
  return zcr >= VOICE_ZCR_MIN && zcr <= zcrVoiceBandCeiling(tolerance);
}

/** 门限分档（B3）：speaking/asking 相位阈值 × 档位系数；他相位/缺省 = 基准。 */
export function bargeInThreshold(phase: StewardVoicePhase | undefined, base: number): number {
  return phase === "speaking" || phase === "asking" ? base * BARGE_IN_ECHO_THRESHOLD_SCALE : base;
}

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
  /** 本帧过零率 ZCR（0..1；B3 双参判定用；缺省 = 判定放行——
   *  计量缺 ZCR 不挡打断，fail-open）。 */
  readonly zcr?: number;
  /** 本帧时戳（ms）。 */
  readonly atMs: number;
  /** 门已武装（speaking/asking 相位 × 语音模式——isBargeInArmed）。 */
  readonly armed: boolean;
  /** 门限分档相位（B3：speaking/asking 抬档；缺省 = 基准灵敏度）。 */
  readonly phase?: StewardVoicePhase;
  /** 有声阈值基准（缺省 VOICE_RMS_THRESHOLD；实际阈值 = bargeInThreshold 分档）。 */
  readonly threshold?: number;
  /** 最短持续（ms；缺省 VOICE_MIN_DURATION_MS）。 */
  readonly minDurationMs?: number;
  /** 触发/停播静默窗（ms；缺省 BARGE_IN_SILENCE_WINDOW_MS）。 */
  readonly silenceWindowMs?: number;
  /** 双参判定开关（人声防误触：ZCR 人声带判据参与；缺省开）。 */
  readonly voiceCheck?: boolean;
  /** ZCR 容忍带强度 0-100（缺省 VOICE_ZCR_TOLERANCE_DEFAULT）。 */
  readonly zcrTolerance?: number;
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
 * - 人声判据（B3 双参）：rms ≥ 分档阈值（bargeInThreshold——speaking/asking
 *   抬档防自声回灌）× ZCR 落人声带（voiceCheck 开时；zcr 缺省放行）；
 * - 持续 ≥ minDurationMs 的人声判据帧才触发（单帧尖峰/敲键不触发）；
 *   非人声判据帧（高 ZCR 宽带脉冲/RMS 不足）不计持续；触发帧自带静默窗。
 */
export function stepBargeInGate(state: BargeInGateState, input: BargeInGateInput): BargeInGateOutcome {
  const threshold = bargeInThreshold(input.phase, input.threshold ?? VOICE_RMS_THRESHOLD);
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
  const voiceLike =
    input.rms >= threshold &&
    (input.voiceCheck === false || input.zcr === undefined || zcrInVoiceBand(input.zcr, input.zcrTolerance ?? VOICE_ZCR_TOLERANCE_DEFAULT));
  if (!voiceLike) {
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
