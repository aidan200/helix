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
  readTtsVoicePref,
  readVoiceBroadcastPref,
  readVoiceVolumePref,
  writeTtsVoicePref,
  writeVoiceBroadcastPref,
  writeVoiceVolumePref,
} from "./voice-pref";

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
