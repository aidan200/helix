/**
 * 语音播报偏好存取（语音播报批 V2 TTS）：localStorage 持久化（跨会话），
 * 设置页写入 / useVoiceBroadcast 与试听按钮读取——V1 STT provider 偏好
 * （stt-provider-pref.ts）同构存储面。localStorage 不可用（隐私模式等）
 * → 兜底默认值（播报关——不偷偷发音频花钱）。
 */
import { VOICE_RMS_THRESHOLD } from "./useVoiceInput";

/** 播报开关存储键（"1"=开；缺省/其它 = 关——默认 off）。 */
export const VOICE_BROADCAST_PREF_KEY = "helix.voice.broadcast";

/** 音色存储键（qwen3-tts 系音色 id；缺省 = Cherry——冒烟验证音色）。 */
export const VOICE_TTS_VOICE_PREF_KEY = "helix.voice.ttsVoice";

/** 音量存储键（0–100 整数；缺省 80）。 */
export const VOICE_VOLUME_PREF_KEY = "helix.voice.volume";

/** 默认音色（冒烟钉死：Cherry 芊悦，女声，qwen3-tts-flash 支持）。 */
export const DEFAULT_TTS_VOICE = "Cherry";

/** 设置页可选音色 id 清单（qwen3-tts 非实时系官方音色——均支持
 *  qwen3-tts-flash；展示文案归 i18n，AG-16 零硬编码 CJK）。 */
export const TTS_VOICE_OPTIONS = ["Cherry", "Serena", "Ethan", "Chelsie", "Nofish", "Ryan"] as const;
export type TtsVoiceId = (typeof TTS_VOICE_OPTIONS)[number];

/** 读播报开关（默认关）。 */
export function readVoiceBroadcastPref(): boolean {
  try {
    return localStorage.getItem(VOICE_BROADCAST_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

/** 写播报开关。 */
export function writeVoiceBroadcastPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(VOICE_BROADCAST_PREF_KEY, "1");
    else localStorage.removeItem(VOICE_BROADCAST_PREF_KEY);
  } catch {
    // 隐私模式等存储不可用：静默兜底（等价关，不阻塞 UI）
  }
}

/** 读音色偏好（非法值/缺省回落 Cherry）。 */
export function readTtsVoicePref(): string {
  try {
    const v = localStorage.getItem(VOICE_TTS_VOICE_PREF_KEY);
    return v !== null && v !== "" ? v : DEFAULT_TTS_VOICE;
  } catch {
    return DEFAULT_TTS_VOICE;
  }
}

/** 写音色偏好。 */
export function writeTtsVoicePref(voice: string): void {
  try {
    localStorage.setItem(VOICE_TTS_VOICE_PREF_KEY, voice);
  } catch {
    // 静默兜底（等价默认音色）
  }
}

/** 读音量（0–100；缺省 80，非法值回落）。 */
export function readVoiceVolumePref(): number {
  try {
    const raw = localStorage.getItem(VOICE_VOLUME_PREF_KEY);
    if (raw === null) return 80; // Number(null)===0 陷阱——缺省先于数值化判定
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 80;
  } catch {
    return 80;
  }
}

/** 写音量。 */
export function writeVoiceVolumePref(volume: number): void {
  try {
    localStorage.setItem(VOICE_VOLUME_PREF_KEY, String(Math.max(0, Math.min(100, Math.round(volume)))));
  } catch {
    // 静默兜底
  }
}

// ── 管家语音模式朗读偏好（V3a 管家语音模式；设置页管家分区写入 /
// useStewardVoice 朗读闸读取）──────────────────────

/** 管家朗读开关存储键（"0"=关；缺省/其它 = 开——用户视角默认「管家会读出来」，
 *  与全局播报默认关不同向：本开关只作用于管家面板语音模式内，且仅 answer
 *  终态合成一次——设置页可随时关）。 */
export const STEWARD_SPEAK_REPLY_PREF_KEY = "helix.steward.speakReply";

/** 读管家朗读开关（默认开；仅语音模式生效——文本模式零发声是硬约束）。 */
export function readStewardSpeakReplyPref(): boolean {
  try {
    return localStorage.getItem(STEWARD_SPEAK_REPLY_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

/** 写管家朗读开关。 */
export function writeStewardSpeakReplyPref(on: boolean): void {
  try {
    if (on) localStorage.removeItem(STEWARD_SPEAK_REPLY_PREF_KEY); // 缺省即开：写关才落键
    else localStorage.setItem(STEWARD_SPEAK_REPLY_PREF_KEY, "0");
  } catch {
    // 静默兜底（等价默认开）
  }
}

// ── B3 回声防线门参数偏好（设置页「语音输入」插话检测组写入 /
// useStewardVoice barge-in 门参数消费——逐帧读偏好，面板期改参即时生效）──

/** VAD 灵敏度存储键（0-100 整数；缺省 50 = VOICE_RMS_THRESHOLD 原灵敏度）。 */
export const VOICE_VAD_SENSITIVITY_PREF_KEY = "helix.voice.vadSensitivity";

/** 最短发声时长存储键（ms 整数，100-1000；缺省 300）。 */
export const VOICE_MIN_DURATION_PREF_KEY = "helix.voice.minDuration";

/** 停播静默窗存储键（ms 整数，0-1000；缺省 300）。 */
export const VOICE_SILENCE_WINDOW_PREF_KEY = "helix.voice.silenceWindow";

/** 人声防误触（双参判定）开关存储键（"0"=关；缺省/其它 = 开）。 */
export const VOICE_VOICE_CHECK_PREF_KEY = "helix.voice.voiceCheck";

/** 容忍带强度存储键（0-100 整数；缺省 50）。 */
export const VOICE_ZCR_TOLERANCE_PREF_KEY = "helix.voice.zcrTolerance";

/** 参数区间（写入钳制 / 读取合法性判定共用）。 */
export const VAD_SENSITIVITY_RANGE = { min: 0, max: 100, default: 50 } as const;
export const MIN_DURATION_RANGE = { min: 100, max: 1000, default: 300 } as const;
export const SILENCE_WINDOW_RANGE = { min: 0, max: 1000, default: 300 } as const;
export const ZCR_TOLERANCE_RANGE = { min: 0, max: 100, default: 50 } as const;

/** 灵敏度映射端点（s=0 钝档 / s=100 灵档；s=50 恰为 VOICE_RMS_THRESHOLD）。 */
export const VOICE_RMS_THRESHOLD_MAX = 0.036;
export const VOICE_RMS_THRESHOLD_MIN = 0.004;

/** 灵敏度（0-100）→ RMS 阈值映射（分段线性；50 = 原灵敏度不动；越界钳制）。 */
export function voiceRmsThresholdFromSensitivity(sensitivity: number): number {
  const s = Number.isFinite(sensitivity) ? Math.max(0, Math.min(100, sensitivity)) : VAD_SENSITIVITY_RANGE.default;
  if (s === 50) return VOICE_RMS_THRESHOLD;
  if (s < 50) return VOICE_RMS_THRESHOLD + ((50 - s) / 50) * (VOICE_RMS_THRESHOLD_MAX - VOICE_RMS_THRESHOLD);
  return VOICE_RMS_THRESHOLD - ((s - 50) / 50) * (VOICE_RMS_THRESHOLD - VOICE_RMS_THRESHOLD_MIN);
}

/** 读数值偏好（非法/越界/存储不可用回落区间默认；写入端钳制保证回读合法）。 */
function readNumericPref(key: string, range: { min: number; max: number; default: number }): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return range.default; // Number(null)===0 陷阱同构
    const v = Number(raw);
    return Number.isFinite(v) && v >= range.min && v <= range.max ? v : range.default;
  } catch {
    return range.default;
  }
}

/** 写数值偏好（round + 区间钳制；存储不可用静默兜底）。 */
function writeNumericPref(key: string, value: number, range: { min: number; max: number }): void {
  try {
    const v = Math.max(range.min, Math.min(range.max, Math.round(value)));
    localStorage.setItem(key, String(v));
  } catch {
    // 静默兜底（等价默认值）
  }
}

/** 读 VAD 灵敏度（0-100；缺省 50）。 */
export function readVoiceVadSensitivityPref(): number {
  return readNumericPref(VOICE_VAD_SENSITIVITY_PREF_KEY, VAD_SENSITIVITY_RANGE);
}

/** 写 VAD 灵敏度。 */
export function writeVoiceVadSensitivityPref(sensitivity: number): void {
  writeNumericPref(VOICE_VAD_SENSITIVITY_PREF_KEY, sensitivity, VAD_SENSITIVITY_RANGE);
}

/** 读最短发声时长（ms；缺省 300）。 */
export function readVoiceMinDurationPref(): number {
  return readNumericPref(VOICE_MIN_DURATION_PREF_KEY, MIN_DURATION_RANGE);
}

/** 写最短发声时长。 */
export function writeVoiceMinDurationPref(ms: number): void {
  writeNumericPref(VOICE_MIN_DURATION_PREF_KEY, ms, MIN_DURATION_RANGE);
}

/** 读停播静默窗（ms；缺省 300）。 */
export function readVoiceSilenceWindowPref(): number {
  return readNumericPref(VOICE_SILENCE_WINDOW_PREF_KEY, SILENCE_WINDOW_RANGE);
}

/** 写停播静默窗。 */
export function writeVoiceSilenceWindowPref(ms: number): void {
  writeNumericPref(VOICE_SILENCE_WINDOW_PREF_KEY, ms, SILENCE_WINDOW_RANGE);
}

/** 读人声防误触（双参判定）开关（默认开；仅影响 barge-in 门判定）。 */
export function readVoiceCheckPref(): boolean {
  try {
    return localStorage.getItem(VOICE_VOICE_CHECK_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

/** 写人声防误触开关（缺省即开：写关才落键）。 */
export function writeVoiceCheckPref(on: boolean): void {
  try {
    if (on) localStorage.removeItem(VOICE_VOICE_CHECK_PREF_KEY);
    else localStorage.setItem(VOICE_VOICE_CHECK_PREF_KEY, "0");
  } catch {
    // 静默兜底（等价默认开）
  }
}

/** 读容忍带强度（0-100；缺省 50）。 */
export function readZcrTolerancePref(): number {
  return readNumericPref(VOICE_ZCR_TOLERANCE_PREF_KEY, ZCR_TOLERANCE_RANGE);
}

/** 写容忍带强度。 */
export function writeZcrTolerancePref(tolerance: number): void {
  writeNumericPref(VOICE_ZCR_TOLERANCE_PREF_KEY, tolerance, ZCR_TOLERANCE_RANGE);
}
