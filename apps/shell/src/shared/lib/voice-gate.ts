/**
 * voice-gate —— 人声判定共基面（两门共用的单帧判据 + ZCR 带判据 + 底噪校准
 * 纯函数；语音判定钝感批）。
 *
 * 为什么存在：聆听收口门（useVoiceInput VAD）与插话打断门
 *（steward-voice-machine stepBargeInGate）原先各持一套判定（收口=单参低阈
 * 长窗、打断=双参高阈短窗+分档），同一环境两门行为可相反（E-221 P1 基准
 * 分裂）。本文件把「什么算一帧人声」下沉为唯一定义点（isVoiceLikeFrame），
 * 两门消费同一函数——用户调一次灵敏度，两门一起钝/灵。
 *
 * 同时收口 VOICE_RMS_THRESHOLD 与 ZCR 族常量（原分居 useVoiceInput /
 * steward-voice-machine）：voice-pref.ts 原从 useVoiceInput import
 * VOICE_RMS_THRESHOLD，而 useVoiceInput 收口门要消费 voice-pref 读面——
 * 环在本文件落地即断（voice-pref → voice-gate ← useVoiceInput，单向）。
 * 旧导出路径 re-export 保兼容（useVoiceInput / steward-voice-machine）。
 *
 * shared 层禁引 features（AG-15）——本文件是 ZCR 判据唯一定义点；纯常量 +
 * 纯函数零依赖（rms-meter 的 MeterFrame 结构兼容：zcr 可选——meter 无 zcr
 * 帧时 fail-open，行为同旧）。
 */

/** VAD 开口判定阈值（RMS ≥ 此值视为有声帧；mic 增益常态语音 0.05-0.3，取低阈保守）。
 *  历史值 0.012（useVoiceInput 原址迁入，等值不动——灵敏度 50 档锚点）。 */
export const VOICE_RMS_THRESHOLD = 0.012;

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

/**
 * 单帧人声判据（两门共基）：`rms ≥ threshold && (voiceCheck 关 || zcr 缺省
 * 放行 || ZCR 落人声带)`——与 stepBargeInGate 内联判据同口径（machine 侧
 * 已改用本函数，两门判据物理同源）。
 *
 * - threshold 由调用方逐帧注入（灵敏度偏好映射，或底噪校准抬升后的有效阈值）；
 * - zcr 缺省（meter 无 zcr 帧）fail-open——计量缺失不挡判定（行为同旧）；
 * - MeterFrame（rms-meter）结构兼容可直接传入。
 */
export function isVoiceLikeFrame(
  frame: { readonly rms: number; readonly zcr?: number },
  opts: { readonly threshold: number; readonly voiceCheck?: boolean; readonly zcrTolerance?: number },
): boolean {
  if (frame.rms < opts.threshold) return false;
  if (opts.voiceCheck === false) return true;
  if (frame.zcr === undefined) return true; // fail-open
  return zcrInVoiceBand(frame.zcr, opts.zcrTolerance);
}

// ── 底噪校准（两门共基阈值）────────────────────────────────────────
// 双工开启后前 ~2.5s 耳 meter 帧采样窗估计环境底噪（欢迎语 TTS 回灌是偶发
// 尖峰——低百分位鲁棒）；两门阈值抬升为 max(偏好阈值, 底噪 × 2.5)——嘈杂
// 环境不再把底噪当说话。采样帧不足 → 不校准回落纯偏好值（useStewardVoice
// 消费面；本段只放纯函数与常量）。

/** 底噪采样窗（ms）：duplex 开启（markDuplex(true)）起算。 */
export const VOICE_NOISE_CALIB_WINDOW_MS = 2_500;

/** 采样窗内最少帧数（不足 → 不校准回落纯偏好值；~100ms/帧 × 2.5s ≈ 25 帧）。 */
export const VOICE_NOISE_CALIB_MIN_FRAMES = 10;

/** 底噪 → 阈值抬升系数（底噪 × 2.5 = 抬升后门槛）。 */
export const VOICE_NOISE_FLOOR_SCALE = 2.5;

/** 底噪估计百分位（20——低侧最近秩，TTS 尖峰/偶发人声不拉高估计）。 */
const NOISE_FLOOR_PERCENTILE = 20;

/**
 * 底噪估计（P20 最近秩下取）：样本升序取 floor(p/100 × n) 位——低侧取值，
 * 少数尖峰（欢迎语 TTS 回灌 ~0.3 vs 底噪 0.02）不影响估计。空数组 → 0
 *（调用方以帧数门控保证非空；防御面返回 0 = 不抬升方向的保守值）。
 */
export function noiseFloorEstimate(samples: readonly number[]): number {
  const n = samples.length;
  if (n === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(n - 1, Math.floor((NOISE_FLOOR_PERCENTILE / 100) * n));
  return sorted[idx]!;
}

/**
 * 两门有效阈值单点：max(偏好阈值, 底噪 × VOICE_NOISE_FLOOR_SCALE)。
 * noiseFloor = null（未校准/采样不足回落）→ 纯偏好值——校准只抬不降，
 * 用户调钝（偏好更高）不被底噪拉回。
 */
export function effectiveRmsThreshold(prefThreshold: number, noiseFloor: number | null): number {
  if (noiseFloor === null) return prefThreshold;
  return Math.max(prefThreshold, noiseFloor * VOICE_NOISE_FLOOR_SCALE);
}
