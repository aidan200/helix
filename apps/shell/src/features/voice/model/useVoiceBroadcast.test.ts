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
  paused = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    return rejectPlay ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

vi.mock("@/shared/lib/voice-pref", () => ({
  readVoiceBroadcastPref: () => true,
  readTtsVoicePref: () => "Cherry",
  readVoiceVolumePref: () => 60,
}));

import { useVoiceBroadcast } from "./useVoiceBroadcast";
import { resetSpeechMutexForTest, speechLeaseActive } from "@/shared/lib/speech-mutex";
import {
  beginDialogueSpeech,
  endDialogueSpeech,
  resetSpeechFloorForTest,
  stopNotificationSpeech,
} from "@/shared/lib/speech-floor";

const broadcastFrame = (seq: number, audio = `data:audio/wav;base64,S${seq}`): EventEnvelope =>
  ({ v: "0.14", sessionId: "__system__", channel: "voice", type: "voice.broadcast", payload: { kind: "agent.completed", agentId: "agent-1", text: "t", audio, provider: "dashscope", seq } }) as unknown as EventEnvelope;

describe("useVoiceBroadcast（语音播报批 V2）", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    rejectPlay = false;
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
    resetSpeechMutexForTest();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    frameListener = null;
    connState = "connected";
    resetSpeechMutexForTest();
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

  it("⑥ 播报租约：播放期租约在场（收音互斥面），队列排空才释放（顺序播放不闪断）", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    expect(speechLeaseActive()).toBe(false);
    await act(async () => {
      frameListener!(broadcastFrame(1));
      frameListener!(broadcastFrame(2));
    });
    expect(speechLeaseActive()).toBe(true); // 首条播放期持租约
    await act(async () => {
      FakeAudio.instances[0]!.onended?.();
    });
    expect(speechLeaseActive()).toBe(true); // 第二条接续——队列非空不释放（零闪断）
    await act(async () => {
      FakeAudio.instances[1]!.onended?.();
    });
    expect(speechLeaseActive()).toBe(false); // 队列排空 → 释放（收音恢复）
  });

  it("⑥ 播报租约：播放拒绝/异常路径零泄漏（跳完即释放）", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    rejectPlay = true;
    await act(async () => {
      frameListener!(broadcastFrame(1));
      frameListener!(broadcastFrame(2));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(speechLeaseActive()).toBe(false); // 全部跳过 → 租约释放（不永久暂停收音）
  });
});

// ── ①④ 发言协调（speech-floor 接线：对话 > 通知，播×播互斥）──────────────

describe("useVoiceBroadcast（① 发言协调：对话优先，c 面服从/被收编 + ④ 全轨停止）", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    rejectPlay = false;
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
    resetSpeechMutexForTest();
    resetSpeechFloorForTest();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    frameListener = null;
    resetSpeechMutexForTest();
    resetSpeechFloorForTest();
  });

  it("T3 通知服从对话：对话发言期 voice.broadcast 到达 → 延后（不立即播）；对话收口 → 串行起播", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    act(() => {
      beginDialogueSpeech("stream"); // 对话发言期（a 面在播形态）
    });
    await act(async () => {
      frameListener!(broadcastFrame(1));
      frameListener!(broadcastFrame(2));
    });
    expect(FakeAudio.instances.length).toBe(0); // 延后——不立即播（不打断对话）
    expect(speechLeaseActive()).toBe(false); // 延后期不占播报租约（未出声不拦收音）
    act(() => {
      endDialogueSpeech("stream"); // 对话收口
    });
    expect(FakeAudio.instances.length).toBe(1); // 收口后串行起播（首条）
    await act(async () => {
      FakeAudio.instances[0]!.onended?.();
    });
    expect(FakeAudio.instances.length).toBe(2); // 逐条串行（顺序保障保持）
  });

  it("T4 对话收编通知：通知在播 + 队列有货时新对话起 → 在播 pause + 队列清空（弃播——收口后也不回放）", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    await act(async () => {
      frameListener!(broadcastFrame(1)); // 在播
      frameListener!(broadcastFrame(2)); // 排队
    });
    expect(FakeAudio.instances.length).toBe(1);
    act(() => {
      beginDialogueSpeech("round"); // 新对话轮起（最新对话优先）
    });
    expect(FakeAudio.instances[0]!.paused).toBe(true); // 在播被停
    expect(speechLeaseActive()).toBe(false); // 租约收位（不永久暂停收音）
    act(() => {
      endDialogueSpeech("round"); // 对话收口——弃播不续：清掉的队列不回放
    });
    expect(FakeAudio.instances.length).toBe(1); // 零回放（第二条不补播）
  });

  it("T5 全轨停止（stopNotificationSpeech = stopSpeaking 的 c 面）：在播 pause + 队列清空 + 弃播不续", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    await act(async () => {
      frameListener!(broadcastFrame(1));
      frameListener!(broadcastFrame(2));
    });
    expect(FakeAudio.instances.length).toBe(1);
    act(() => {
      stopNotificationSpeech();
    });
    expect(FakeAudio.instances[0]!.paused).toBe(true); // 在播停
    expect(speechLeaseActive()).toBe(false);
    await act(async () => {
      FakeAudio.instances[0]!.onended?.(); // 已被弃播：收口回调零续播
    });
    expect(FakeAudio.instances.length).toBe(1); // 队列已清——不续播
  });

  it("延后期租约语义：对话收口起播首条 → 租约占住；排空释放（⑥ 边沿与协调并存不破）", async () => {
    await act(async () => {
      renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
    });
    act(() => {
      beginDialogueSpeech("stream");
    });
    await act(async () => {
      frameListener!(broadcastFrame(1));
    });
    expect(speechLeaseActive()).toBe(false); // 延后期
    act(() => {
      endDialogueSpeech("stream");
    });
    expect(speechLeaseActive()).toBe(true); // 放行起播 → 发言期占租约
    await act(async () => {
      FakeAudio.instances[0]!.onended?.();
    });
    expect(speechLeaseActive()).toBe(false); // 排空释放
  });
});
