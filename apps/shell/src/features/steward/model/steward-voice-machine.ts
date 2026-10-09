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
 */
import { VOICE_MIN_DURATION_MS, type VoiceState } from "@/shared/lib/useVoiceInput";
// 人声判据共基面（语音判定钝感批）：ZCR 族与单帧判据唯一定义点在 shared/lib/voice-gate
// ——本文件 re-export 保兼容（既有测试/导入零断）；stepBargeInGate 改用
// isVoiceLikeFrame，与聆听收口门（useVoiceInput VAD）物理同源（E-221 P1 基准分裂修复）。
import {
  isVoiceLikeFrame,
  VOICE_RMS_THRESHOLD,
  VOICE_ZCR_MAX_LENIENT,
  VOICE_ZCR_MAX_STRICT,
  VOICE_ZCR_MIN,
  VOICE_ZCR_TOLERANCE_DEFAULT,
  zcrInVoiceBand,
  zcrVoiceBandCeiling,
} from "@/shared/lib/voice-gate";

export {
  VOICE_ZCR_MAX_LENIENT,
  VOICE_ZCR_MAX_STRICT,
  VOICE_ZCR_MIN,
  VOICE_ZCR_TOLERANCE_DEFAULT,
  zcrInVoiceBand,
  zcrVoiceBandCeiling,
};

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
 *  可参数化（设置面 silence-window 偏好）；双条件时长档见 B3 门限分档/双参判定。 */
export const BARGE_IN_SILENCE_WINDOW_MS = 300;

// ── B3 回声防线（双参判定 + 门限分档）────────────────────────
// ZCR 人声带判据族（VOICE_ZCR_* / zcrInVoiceBand / zcrVoiceBandCeiling）已
// 下沉 shared/lib/voice-gate（两门共基唯一定义点）——本文件 re-export 保兼容。

/** 门限分档系数（B3 ②线）：speaking/asking 相位（TTS 自声经空气/机身回灌
 *  窗口）基准阈值抬档防自触发；listening 相位维持基准灵敏度。固定档位
 *  （不暴露强度参数——灵敏度基准已可调，档位系数属内部回声防护逻辑）。
 *  ⑦ 复核（语音闭环批）：×3 → ×2——×3 下正常说话音量难达抬档阈值，真插话
 *  压漏（须吼才能打断）；自声防线已有 ZCR 人声带 + 持续 300ms + 残响静默窗
 *  三层，RMS 单维不需 3 倍保守量。契约本体（门三判据/打断序）零改动仅调
 *  默认值；触发/未触发双态打点（cand/missed）持续采集，后续按数据再校。 */
export const BARGE_IN_ECHO_THRESHOLD_SCALE = 2;

/** 门限分档（B3）：speaking/asking 相位阈值 × 档位系数；他相位/缺省 = 基准。 */
export function bargeInThreshold(phase: StewardVoicePhase | undefined, base: number): number {
  return phase === "speaking" || phase === "asking" ? base * BARGE_IN_ECHO_THRESHOLD_SCALE : base;
}

/** ⑦ 双态打点簿记：基准口径候选人声段（武装期人声爆发段——不管最终被档位
 *  压制/未达持续/真触发，每段终局恰好一条打点数据）。 */
export interface BargeInCandEpisode {
  /** 段起点（ms）。 */
  readonly sinceMs: number;
  /** 段内峰值帧时戳（ms）。 */
  readonly peakAtMs: number;
  /** 段内峰值 RMS（未触发样本的强度面——档位压制复核依据）。 */
  readonly peakRms: number;
  /** 峰值帧 ZCR。 */
  readonly peakZcr: number;
  /** 峰值帧相位（段归属相位——打点条目 phase 字段直接取用）。 */
  readonly peakPhase: string;
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
  /** ⑦ 双态打点簿记：在途候选段（null = 无——段终局随 trigger/missed 收口）。 */
  readonly cand: BargeInCandEpisode | null;
}

/** 门初态。 */
export const INITIAL_BARGE_IN_GATE: BargeInGateState = { loudSinceMs: null, muteUntilMs: 0, fired: false, cand: null };

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

/** 门输出（新状态 + 本帧是否触发 + ⑦ 未触发候选段收口随出）。 */
export interface BargeInGateOutcome {
  readonly state: BargeInGateState;
  readonly trigger: boolean;
  /** ⑦ 本帧收口了一个未触发候选段（段内峰值帧特征随出——消费面打 fired:false；
   *  null = 无收口）。 */
  readonly missed: BargeInCandEpisode | null;
}

/** 候选段峰值递推（纯簿记——不参与触发判据）。 */
function candFrame(cand: BargeInCandEpisode | null, input: BargeInGateInput): BargeInCandEpisode {
  const zcr = input.zcr ?? 0;
  if (cand === null || input.rms > cand.peakRms) {
    return {
      sinceMs: cand?.sinceMs ?? input.atMs,
      peakAtMs: input.atMs,
      peakRms: input.rms,
      peakZcr: zcr,
      peakPhase: input.phase ?? cand?.peakPhase ?? "",
    };
  }
  return cand;
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
  const base = input.threshold ?? VOICE_RMS_THRESHOLD;
  const threshold = bargeInThreshold(input.phase, base);
  const minDurationMs = input.minDurationMs ?? VOICE_MIN_DURATION_MS;
  const silenceWindowMs = input.silenceWindowMs ?? BARGE_IN_SILENCE_WINDOW_MS;
  const carry = { muteUntilMs: state.muteUntilMs, fired: state.fired, cand: state.cand };
  if (!input.armed) {
    // 解武装置终：闩锁复位 + 在途候选段收口（相位离场即段终局——未触发打点随出）
    return {
      state: { loudSinceMs: null, muteUntilMs: state.muteUntilMs, fired: false, cand: null },
      trigger: false,
      missed: state.cand,
    };
  }
  if (state.fired) return { state, trigger: false, missed: null };
  if (input.atMs < state.muteUntilMs) {
    // 残响窗：窗内声不计人声——在途候选段一并收口（残响不入打点段）
    return { state: { loudSinceMs: null, ...carry, fired: false, cand: null }, trigger: false, missed: state.cand };
  }
  const voiceLike = isVoiceLikeFrame(input, {
    threshold,
    voiceCheck: input.voiceCheck,
    zcrTolerance: input.zcrTolerance,
  });
  if (!voiceLike) {
    const baseVoiceLike = isVoiceLikeFrame(input, {
      threshold: base,
      voiceCheck: input.voiceCheck,
      zcrTolerance: input.zcrTolerance,
    });
    if (!baseVoiceLike) {
      // 基准口径非人声：候选段死 → 未触发终局（⑦ 双态打点面）
      return { state: { loudSinceMs: null, ...carry, cand: null }, trigger: false, missed: state.cand };
    }
    // 档位压制帧（基准口径人声、抬档口径不过）：候选段续/开（打点簿记），
    // 持续累积清零（抬档口径判据不动——门三判据契约）
    return {
      state: { loudSinceMs: null, ...carry, cand: candFrame(state.cand, input) },
      trigger: false,
      missed: null,
    };
  }
  const cand = candFrame(state.cand, input);
  if (state.loudSinceMs === null) {
    return { state: { loudSinceMs: input.atMs, ...carry, cand }, trigger: false, missed: null };
  }
  if (input.atMs - state.loudSinceMs < minDurationMs) return { state: { ...state, cand }, trigger: false, missed: null };
  return {
    state: { loudSinceMs: null, muteUntilMs: input.atMs + silenceWindowMs, fired: true, cand: null },
    trigger: true,
    missed: null,
  };
}

/** 停播即开静默窗（静音钮/打断停播共用——残响防线）；闩锁同帧复位；
 *  在途候选段静默丢弃（停播边沿噪声大——不入打点）。 */
export function openBargeInSilenceWindow(
  state: BargeInGateState,
  atMs: number,
  windowMs = BARGE_IN_SILENCE_WINDOW_MS,
): BargeInGateState {
  return { loudSinceMs: null, muteUntilMs: atMs + windowMs, fired: false, cand: null };
}

/** 门武装判定（相位派生扩展）：仅「语音模式 ×（speaking | asking）」可打断
 *  ——text 模式/mic 不可用/idle/listening/transcribing 行为不变。 */
export function isBargeInArmed(input: { mode: StewardInputMode; phase: StewardVoicePhase }): boolean {
  return input.mode === "voice" && (input.phase === "speaking" || input.phase === "asking");
}

// ── B2 光球相位（StewardOrb 呈现面；waking→listening→thinking→speaking→closing）──

/** 光球相位（B2 全局语音批，设计稿 §3.2）：
 *  - waking：待机（热键呼出/欢迎语播报期——欢迎语是伴随声非回复，球待机
 *    驻留不摆说话姿）；
 *  - listening：聆听中（含转写在途；duplex 中 idle 是续听瞬态，视觉同相呼吸）；
 *  - thinking：ask 在途；
 *  - speaking：TTS 朗读回复中；
 *  - closing：关麦淡出窗（duplex 已落 + 淡出动画在途）。 */
export type OrbPhase = "waking" | "listening" | "thinking" | "speaking" | "closing";

/** 光球相位派生输入（duplex = 双工会话活跃；fading = 关麦淡出窗；
 *  welcome = 欢迎语播报期——待机动画驻留标记；userSpeaking = 用户正在
 *  发声（useVoiceInput 保持窗——缺省 true = 旧语义「开麦即倾听」零断兼容）；
 *  notifSpeaking = 通知轨播报占用（speech-floor 镜像——通知语音不驱动
 *  speaking 相位，光球面由此镜像补说话姿，与 barge-in 门武装面同信号源）。 */
export interface OrbPhaseInput {
  readonly phase: StewardVoicePhase;
  readonly duplex: boolean;
  readonly fading: boolean;
  readonly welcome: boolean;
  readonly userSpeaking?: boolean;
  readonly notifSpeaking?: boolean;
}

/**
 * 光球相位派生（纯函数；null = 光球不在场零 DOM）：
 * - 不在场：duplex=false 且无淡出；
 * - closing 压过一切（关麦淡出窗——duplex 已落但动画在途）；
 * - welcome 且开麦前瞬态（idle/unsupported）→ waking（欢迎语播报期待机
 *   驻留——欢迎语是伴随声非回复，不摆说话姿）；
 * - listening 且用户未发声（userSpeaking=false，VAD 保持窗外）→ waking
 *   待机驻留（麦克风开着 ≠ 倾听——duplex 常开麦下没开口就一直待机，
 *   开口瞬间转倾听，说完 ~0.9s 回待机）；
 * - transcribing → listening（刚说完话的收口延续）；idle → waking
 *   （duplex 在场未开麦间隙：静音自动停后续听重开/mute 恢复瞬态）；
 * - asking → thinking；speaking → speaking。
 */
export function deriveOrbPhase(input: OrbPhaseInput): OrbPhase | null {
  if (!input.duplex && !input.fading) return null;
  if (input.fading && !input.duplex) return "closing";
  // 通知占用镜像（光球说话姿修复）：仅覆盖「待机语义」相位（idle / listening
  // 未开口——自动续听开麦 ≠ 用户在说话）；用户开口与对话轨相位原样（通知
  // 播报不覆盖对话在途/倾听姿）。与 barge-in 门武装面（L531 附近镜像）同源。
  if (
    input.notifSpeaking === true &&
    (input.phase === "idle" || (input.phase === "listening" && input.userSpeaking === false))
  ) {
    return "speaking";
  }
  if (input.welcome && (input.phase === "idle" || input.phase === "unsupported")) return "waking";
  switch (input.phase) {
    case "asking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "listening":
      return input.userSpeaking === false ? "waking" : "listening";
    case "transcribing":
      return "listening";
    case "idle":
      return "waking";
    default:
      // unsupported 等：duplex 在场但链路不可用——待机（呈现退化不缺席）
      return "waking";
  }
}
