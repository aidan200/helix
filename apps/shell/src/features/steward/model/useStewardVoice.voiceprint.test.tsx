// @vitest-environment jsdom
/**
 * useStewardVoice 声纹面测试（M3-c 声纹批）——授权点音频环暴露。
 *
 * 契约：duplex 会话期间 PCM 帧无条件入环（不受流 armed/发言租约门——
 * 那些是 STT 上行门）；lastUtterancePcm() = 尾部语音段（selectUtterance
 * 语义）；cancelWake（duplex 收口）清环——跨会话旧音频不得泄入新会话
 * 第一句。
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";

const sendStewardUnsubscribe = vi.fn(() => true);
const sendSttTranscribe = vi.fn(() => true);
const sendVoiceSynthesize = vi.fn(() => true);
const sendVoiceSynthesizeStream = vi.fn(() => true);
const sendVoiceSynthesizeStop = vi.fn(() => true);
const sendSttStreamStart = vi.fn(() => true);
const sendSttStreamChunk = vi.fn(() => true);
const sendSttStreamFinish = vi.fn(() => true);
const sendSttStreamStop = vi.fn(() => true);

const listeners: Record<string, Set<(e: EventEnvelope) => void>> = {
  steward: new Set(),
  stt: new Set(),
  voice: new Set(),
};
function emit(domain: "steward" | "stt" | "voice", e: EventEnvelope): void {
  for (const l of listeners[domain]!) l(e);
}
function makeSubscribe(domain: "steward" | "stt" | "voice") {
  return vi.fn((cb: (e: EventEnvelope) => void) => {
    listeners[domain]!.add(cb);
    return () => {
      listeners[domain]!.delete(cb);
    };
  });
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk: vi.fn(() => true),
    sendStewardConfirm: vi.fn(() => true),
    sendStewardInterrupt: vi.fn(() => true),
    sendStewardSubscribe: vi.fn(() => true),
    sendStewardUnsubscribe,
    sendStewardGetConfig: vi.fn(() => true),
    subscribeStewardFrames: makeSubscribe("steward"),
    sendSttTranscribe,
    subscribeSttFrames: makeSubscribe("stt"),
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamFinish,
    sendSttStreamStop,
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
    subscribeVoiceFrames: makeSubscribe("voice"),
  }),
}));

vi.mock("@/shared/lib/stt-provider-pref", () => ({ readSttProviderPref: () => undefined }));

let fireWakeHotkey: (() => void) | null = null;
vi.mock("@/shared/lib/wake-hotkey", () => ({
  setWakeHotkeyFireHandler: (h: (() => void) | null) => {
    fireWakeHotkey = h;
  },
  syncWakeHotkeyRegistration: async () => "ok" as const,
}));

import { useStewardVoice } from "./useStewardVoice";

class FakeMediaRecorder {
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start(): void {
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    }, 5);
  }
  stop(): void {
    this.onstop?.();
  }
  static isTypeSupported(mime: string): boolean {
    return mime === "audio/webm;codecs=opus" || mime === "audio/webm" || mime === "audio/mp4";
  }
}

const fakeCreateMeter = async () => ({
  onLevel: () => undefined,
  close: () => undefined,
});

/** 有声帧样本（1600 Int16，幅度 3000 正弦）。 */
function loudFrameBuffer(): ArrayBuffer {
  const s = new Int16Array(1600);
  for (let i = 0; i < s.length; i++) s[i] = Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  return s.buffer;
}

type HookResult = { current: ReturnType<typeof useStewardVoice> };

function renderVoice(options?: Parameters<typeof useStewardVoice>[0]): HookResult {
  return renderHook(() => useStewardVoice(options), { wrapper: I18nProvider }).result;
}

function frame(type: string, payload: unknown, channel: string, sessionId = "__system__"): EventEnvelope {
  return { v: "0.14", sessionId, channel, type, payload } as EventEnvelope;
}

let streamSeq = 0;
async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
}

async function pressHotkey(r?: HookResult): Promise<void> {
  await act(async () => {
    fireWakeHotkey?.();
  });
  await tick();
  act(() => {
    streamSeq += 1;
    emit("stt", frame("stt.stream.started", { status: "ok", streamId: `s${streamSeq}` }, "stt"));
  });
  if (r !== undefined) await waitFor(() => expect(r.current.duplexActive).toBe(true));
}

describe("useStewardVoice 声纹面（M3-c：授权点音频环）", () => {
  let restoreEnv: (() => void) | null = null;
  let pumpFrame: ((frame: ArrayBuffer) => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    streamSeq = 0;
    pumpFrame = null;

    const origDevices = navigator.mediaDevices;
    const trackStop = vi.fn();
    const fakeStream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    restoreEnv = () => {
      Object.defineProperty(navigator, "mediaDevices", { value: origDevices, configurable: true });
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    };
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    restoreEnv?.();
    restoreEnv = null;
  });

  it("duplex 期间帧入环：lastUtterancePcm 返回尾部语音段（有声帧拼接）", async () => {
    const r = renderVoice({
      createMeter: fakeCreateMeter,
      createPlayer: () => ({
        enqueue: () => true,
        setVolume: () => {},
        drop: () => {},
        stop: () => {},
        close: () => {},
        reopen: () => {},
        onActiveChange: () => () => {},
      }),
      createPump: async () => ({
        onFrame(cb) {
          pumpFrame = cb;
        },
        close() {},
      }),
    });
    await pressHotkey(r);
    // 5 帧有声 + 1 帧静音（STT 回执延迟期间的尾部静音）
    act(() => {
      for (let i = 0; i < 5; i++) pumpFrame?.(loudFrameBuffer());
      pumpFrame?.(new Int16Array(1600).buffer);
    });
    const pcm = r.current.lastUtterancePcm();
    expect(pcm).not.toBeNull();
    expect(pcm!.length).toBe(5 * 1600); // 有声 5 帧（尾静音帧不入段——只留语音）
  });

  it("全静音环 → lastUtterancePcm null", async () => {
    const r = renderVoice({
      createMeter: fakeCreateMeter,
      createPlayer: () => ({
        enqueue: () => true,
        setVolume: () => {},
        drop: () => {},
        stop: () => {},
        close: () => {},
        reopen: () => {},
        onActiveChange: () => () => {},
      }),
      createPump: async () => ({
        onFrame(cb) {
          pumpFrame = cb;
        },
        close() {},
      }),
    });
    await pressHotkey(r);
    act(() => {
      for (let i = 0; i < 4; i++) pumpFrame?.(new Int16Array(1600).buffer);
    });
    expect(r.current.lastUtterancePcm()).toBeNull();
  });

  it("cancelWake（duplex 收口）清环：跨会话旧音频不泄入", async () => {
    const r = renderVoice({
      createMeter: fakeCreateMeter,
      createPlayer: () => ({
        enqueue: () => true,
        setVolume: () => {},
        drop: () => {},
        stop: () => {},
        close: () => {},
        reopen: () => {},
        onActiveChange: () => () => {},
      }),
      createPump: async () => ({
        onFrame(cb) {
          pumpFrame = cb;
        },
        close() {},
      }),
    });
    await pressHotkey(r);
    act(() => {
      for (let i = 0; i < 3; i++) pumpFrame?.(loudFrameBuffer());
    });
    expect(r.current.lastUtterancePcm()).not.toBeNull();
    act(() => {
      r.current.cancelWake();
    });
    expect(r.current.duplexActive).toBe(false);
    expect(r.current.lastUtterancePcm()).toBeNull();
  });
});
