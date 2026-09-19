/**
 * 语音播报偏好存取（语音播报批 V2 TTS）：localStorage 持久化（跨会话），
 * 设置页写入 / useVoiceBroadcast 与试听按钮读取——V1 STT provider 偏好
 * （stt-provider-pref.ts）同构存储面。localStorage 不可用（隐私模式等）
 * → 兜底默认值（播报关——不偷偷发音频花钱）。
 */

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
