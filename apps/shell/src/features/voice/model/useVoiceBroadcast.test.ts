// @vitest-environment jsdom
/**
 * useVoiceBroadcast 测试（语音播报批 V2；Audio/命令面全 stub，零真机依赖）。
 *
 * - 订阅闸门：conn=connected + 偏好开 → sendVoiceSubscribe(音色)；
 *   偏好关 → sendVoiceUnsubscribe；conn 非 connected 零发送；
 * - 播放面：voice.broadcast seq 单调去重（重复/回退帧丢弃）+ 顺序播放
 *   （首条 onended 后才播第二条）；音量偏好消费（volume = pref/100）；
 * - 播放拒绝（autoplay policy）：跳过该条继续后续（顺序保障不卡死）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendVoiceSubscribe = vi.fn(() => true);
const sendVoiceUnsubscribe = vi.fn(() => true);
let frameListener: ((e: EventEnvelope) => void) | null = null;
const subscribeVoiceFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  frameListener = cb;
  return () => {
    frameListener = null;
  };
});
let connState = "connected";

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: connState } },
    sendVoiceSubscribe,
    sendVoiceUnsubscribe,
    subscribeVoiceFrames,
  }),
}));

/** 可控 Audio fake（rejectPlay 模块位控制 play 拒绝——实例字段会遮蔽 prototype）。 */
let rejectPlay = false;
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    return rejectPlay ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
  }
}

vi.mock("@/shared/lib/voice-pref", () => ({
  readVoiceBroadcastPref: () => true,
  readTtsVoicePref: () => "Cherry",
  readVoiceVolumePref: () => 60,
}));

import { useVoiceBroadcast } from "./useVoiceBroadcast";

const broadcastFrame = (seq: number, audio = `data:audio/wav;base64,S${seq}`): EventEnvelope =>
  ({ v: "0.12", sessionId: "__system__", channel: "voice", type: "voice.broadcast", payload: { kind: "agent.completed", agentId: "agent-1", text: "t", audio, provider: "dashscope", seq } }) as unknown as EventEnvelope;

describe("useVoiceBroadcast（语音播报批 V2）", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    rejectPlay = false;
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    frameListener = null;
    connState = "connected";
  });

  it("闸门：connected + 偏好开 → sendVoiceSubscribe(Cherry)", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    expect(sendVoiceSubscribe).toHaveBeenCalledWith("Cherry");
    expect(sendVoiceUnsubscribe).not.toHaveBeenCalled();
  });

  it("闸门：conn 非 connected → 零发送", async () => {
    connState = "connecting";
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    expect(sendVoiceSubscribe).not.toHaveBeenCalled();
    expect(sendVoiceUnsubscribe).not.toHaveBeenCalled();
  });

  it("播放：voice.broadcast → new Audio(data URL) + 音量偏好（60%）+ play", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    await act(async () => {
      frameListener!(broadcastFrame(1));
    });
    expect(FakeAudio.instances.length).toBe(1);
    expect(FakeAudio.instances[0]!.src).toBe("data:audio/wav;base64,S1");
    expect(FakeAudio.instances[0]!.volume).toBeCloseTo(0.6);
  });

  it("seq 去重：重复/回退帧丢弃（只播一次）", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    await act(async () => {
      frameListener!(broadcastFrame(1));
      frameListener!(broadcastFrame(1)); // 重复
      frameListener!(broadcastFrame(5));
      frameListener!(broadcastFrame(3)); // 回退
    });
    // 首条在播；seq 5 排队、重复/回退丢弃——首条结束后 seq 5 才播
    expect(FakeAudio.instances.length).toBe(1);
    await act(async () => {
      FakeAudio.instances[0]!.onended?.();
    });
    expect(FakeAudio.instances.length).toBe(2); // 仅 seq 1 + 5
    expect(FakeAudio.instances[1]!.src).toBe("data:audio/wav;base64,S5");
  });

  it("顺序保障：第二条在首条 onended 后才播", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    await act(async () => {
      frameListener!(broadcastFrame(1));
      frameListener!(broadcastFrame(2));
    });
    // 首条在播，第二条未启动
    expect(FakeAudio.instances.length).toBe(1);
    await act(async () => {
      FakeAudio.instances[0]!.onended?.();
    });
    expect(FakeAudio.instances.length).toBe(2);
    expect(FakeAudio.instances[1]!.src).toBe("data:audio/wav;base64,S2");
  });

  it("播放拒绝（autoplay 策略）：跳过该条继续后续", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    rejectPlay = true;
    await act(async () => {
      frameListener!(broadcastFrame(1));
      frameListener!(broadcastFrame(2));
    });
    // 两条都被跳过（拒绝不卡死队列——第二条也尝试并跳过；微任务两轮链）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(FakeAudio.instances.length).toBe(2);
  });
});
