// @vitest-environment jsdom
/**
 * 语音播报偏好存取测试（语音播报批 V2）：localStorage 持久化 + 默认值兜底
 * （播报默认 off——不偷偷发音频花钱；音色默认 Cherry；音量默认 80、
 * 非法值回落）+ 存储不可用静默兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TTS_VOICE,
  TTS_VOICE_OPTIONS,
  VOICE_BROADCAST_PREF_KEY,
  VOICE_TTS_VOICE_PREF_KEY,
  VOICE_VOLUME_PREF_KEY,
  VOICE_VAD_SENSITIVITY_PREF_KEY,
  VOICE_MIN_DURATION_PREF_KEY,
  VOICE_SILENCE_WINDOW_PREF_KEY,
  VOICE_VOICE_CHECK_PREF_KEY,
  VOICE_ZCR_TOLERANCE_PREF_KEY,
  readTtsVoicePref,
  readVoiceBroadcastPref,
  readVoiceVolumePref,
  writeTtsVoicePref,
  writeVoiceBroadcastPref,
  writeVoiceVolumePref,
  readVoiceVadSensitivityPref,
  writeVoiceVadSensitivityPref,
  readVoiceMinDurationPref,
  writeVoiceMinDurationPref,
  readVoiceSilenceWindowPref,
  writeVoiceSilenceWindowPref,
  readVoiceCheckPref,
  writeVoiceCheckPref,
  readZcrTolerancePref,
  writeZcrTolerancePref,
  voiceRmsThresholdFromSensitivity,
  readWakeHotkeyPref,
  writeWakeHotkeyPref,
  STEWARD_WAKE_HOTKEY_PREF_KEY,
} from "./voice-pref";
import { VOICE_RMS_THRESHOLD } from "./useVoiceInput";

describe("voice-pref（语音播报偏好）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("播报开关默认关；写开=1、写关=移除", () => {
    expect(readVoiceBroadcastPref()).toBe(false);
    writeVoiceBroadcastPref(true);
    expect(localStorage.getItem(VOICE_BROADCAST_PREF_KEY)).toBe("1");
    expect(readVoiceBroadcastPref()).toBe(true);
    writeVoiceBroadcastPref(false);
    expect(localStorage.getItem(VOICE_BROADCAST_PREF_KEY)).toBeNull();
    expect(readVoiceBroadcastPref()).toBe(false);
  });

  it("音色默认 Cherry；写后读回；空串回落默认", () => {
    expect(readTtsVoicePref()).toBe(DEFAULT_TTS_VOICE);
    writeTtsVoicePref("Ethan");
    expect(localStorage.getItem(VOICE_TTS_VOICE_PREF_KEY)).toBe("Ethan");
    expect(readTtsVoicePref()).toBe("Ethan");
    localStorage.setItem(VOICE_TTS_VOICE_PREF_KEY, "");
    expect(readTtsVoicePref()).toBe(DEFAULT_TTS_VOICE);
  });

  it("音量默认 80；写后读回；非法值（NaN/越界/负数）回落默认", () => {
    expect(readVoiceVolumePref()).toBe(80);
    writeVoiceVolumePref(30);
    expect(localStorage.getItem(VOICE_VOLUME_PREF_KEY)).toBe("30");
    expect(readVoiceVolumePref()).toBe(30);
    // 越界写入被钳制
    writeVoiceVolumePref(150);
    expect(readVoiceVolumePref()).toBe(100);
    localStorage.setItem(VOICE_VOLUME_PREF_KEY, "abc");
    expect(readVoiceVolumePref()).toBe(80);
    localStorage.setItem(VOICE_VOLUME_PREF_KEY, "-5");
    expect(readVoiceVolumePref()).toBe(80);
  });

  it("localStorage 不可用：读写静默兜底（播报关/默认音色/默认音量）", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(readVoiceBroadcastPref()).toBe(false);
    expect(readTtsVoicePref()).toBe(DEFAULT_TTS_VOICE);
    expect(readVoiceVolumePref()).toBe(80);
    expect(() => writeVoiceBroadcastPref(true)).not.toThrow();
    expect(() => writeTtsVoicePref("Ethan")).not.toThrow();
    expect(() => writeVoiceVolumePref(50)).not.toThrow();
    spy.mockRestore();
  });

  it("音色清单：默认音色在清单内（设置页下拉初值一致）", () => {
    expect(TTS_VOICE_OPTIONS.includes(DEFAULT_TTS_VOICE as never)).toBe(true);
  });
});

// ── B3 回声防线参数偏好（语音输入区「插话检测」组）──────────────────

describe("voice-pref（B3 barge-in 门参数）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("默认值：灵敏度 50 / 最短发声 300ms / 静默窗 300ms / 双参开 / 容忍带 50", () => {
    expect(readVoiceVadSensitivityPref()).toBe(50);
    expect(readVoiceMinDurationPref()).toBe(300);
    expect(readVoiceSilenceWindowPref()).toBe(300);
    expect(readVoiceCheckPref()).toBe(true);
    expect(readZcrTolerancePref()).toBe(50);
  });

  it("读写回读：写后读回（整数化）", () => {
    writeVoiceVadSensitivityPref(80);
    expect(localStorage.getItem(VOICE_VAD_SENSITIVITY_PREF_KEY)).toBe("80");
    expect(readVoiceVadSensitivityPref()).toBe(80);
    writeVoiceMinDurationPref(500);
    expect(localStorage.getItem(VOICE_MIN_DURATION_PREF_KEY)).toBe("500");
    expect(readVoiceMinDurationPref()).toBe(500);
    writeVoiceSilenceWindowPref(650.4);
    expect(readVoiceSilenceWindowPref()).toBe(650);
    writeZcrTolerancePref(20);
    expect(localStorage.getItem(VOICE_ZCR_TOLERANCE_PREF_KEY)).toBe("20");
    expect(readZcrTolerancePref()).toBe(20);
  });

  it("非法值兜底：NaN/越界/负数回落默认；写越界钳制", () => {
    localStorage.setItem(VOICE_VAD_SENSITIVITY_PREF_KEY, "abc");
    expect(readVoiceVadSensitivityPref()).toBe(50);
    localStorage.setItem(VOICE_MIN_DURATION_PREF_KEY, "-1");
    expect(readVoiceMinDurationPref()).toBe(300);
    localStorage.setItem(VOICE_SILENCE_WINDOW_PREF_KEY, "99999");
    expect(readVoiceSilenceWindowPref()).toBe(300);
    localStorage.setItem(VOICE_ZCR_TOLERANCE_PREF_KEY, "1e9");
    expect(readZcrTolerancePref()).toBe(50);
    // 写越界钳制到区间端点（回读合法）
    writeVoiceVadSensitivityPref(150);
    expect(readVoiceVadSensitivityPref()).toBe(100);
    writeVoiceMinDurationPref(50);
    expect(readVoiceMinDurationPref()).toBe(100);
    writeVoiceSilenceWindowPref(5000);
    expect(readVoiceSilenceWindowPref()).toBe(1000);
  });

  it("双参开关：缺省开；写关落键 \"0\"；写开移除键（缺省即开）", () => {
    writeVoiceCheckPref(false);
    expect(localStorage.getItem(VOICE_VOICE_CHECK_PREF_KEY)).toBe("0");
    expect(readVoiceCheckPref()).toBe(false);
    writeVoiceCheckPref(true);
    expect(localStorage.getItem(VOICE_VOICE_CHECK_PREF_KEY)).toBeNull();
    expect(readVoiceCheckPref()).toBe(true);
  });

  it("localStorage 不可用：新键读写静默兜底（默认值/不抛错）", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(readVoiceVadSensitivityPref()).toBe(50);
    expect(readVoiceMinDurationPref()).toBe(300);
    expect(readVoiceSilenceWindowPref()).toBe(300);
    expect(readVoiceCheckPref()).toBe(true);
    expect(readZcrTolerancePref()).toBe(50);
    spy.mockRestore();
    const spySet = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => writeVoiceVadSensitivityPref(80)).not.toThrow();
    expect(() => writeVoiceMinDurationPref(500)).not.toThrow();
    expect(() => writeVoiceSilenceWindowPref(650)).not.toThrow();
    expect(() => writeVoiceCheckPref(false)).not.toThrow();
    expect(() => writeZcrTolerancePref(20)).not.toThrow();
    spySet.mockRestore();
  });
});

describe("voiceRmsThresholdFromSensitivity（灵敏度 → RMS 阈值映射）", () => {
  it("中档 50 = VOICE_RMS_THRESHOLD（原灵敏度不动）", () => {
    expect(voiceRmsThresholdFromSensitivity(50)).toBe(VOICE_RMS_THRESHOLD);
  });

  it("单调递减：灵敏度越高阈值越低；端点钳制", () => {
    const s = [0, 25, 50, 75, 100].map(voiceRmsThresholdFromSensitivity);
    for (let i = 1; i < s.length; i += 1) expect(s[i]!).toBeLessThan(s[i - 1]!);
    expect(voiceRmsThresholdFromSensitivity(0)).toBeGreaterThan(VOICE_RMS_THRESHOLD);
    expect(voiceRmsThresholdFromSensitivity(100)).toBeLessThan(VOICE_RMS_THRESHOLD);
    // 越界输入钳制到端点同值
    expect(voiceRmsThresholdFromSensitivity(-10)).toBe(voiceRmsThresholdFromSensitivity(0));
    expect(voiceRmsThresholdFromSensitivity(250)).toBe(voiceRmsThresholdFromSensitivity(100));
  });
});

describe("B4 唤醒链偏好（组合键——唤醒词/待命超时已随「热键直通双工」退役）", () => {
  it("组合键偏好：缺省 null（未设置——不偷注册全局快捷键）；读写往返 + 清除", () => {
    expect(STEWARD_WAKE_HOTKEY_PREF_KEY).toBe("helix.steward.wakeHotkey");
    expect(readWakeHotkeyPref()).toBeNull();
    writeWakeHotkeyPref("⌘⇧K");
    expect(readWakeHotkeyPref()).toBe("⌘⇧K");
    writeWakeHotkeyPref(null);
    expect(readWakeHotkeyPref()).toBeNull();
  });
});
