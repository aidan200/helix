// @vitest-environment jsdom
/**
 * useStewardVoice 出声面协调集成测试（双声重叠修复批 ①②③④；TDD 红→绿）。
 *
 * 双钩同挂（useVoiceBroadcast + useStewardVoice——App 真实形态）验证四条出声面
 * 的互斥/收编语义：
 * - T1 重叠回归（①②核心）：旧轮句未收口（无 done）+ 新轮 ask → 旧句定向停
 *   （sendStopFor）+ player 旧尾音停 + 新句 chunk 直入播放队列（不卡闸）+
 *   零降级（无 sendFallback）+ 零 fallback Audio；
 * - T2 迟到回执弃播（③）：fallback 发出记轮次，新 ask 开轮后回执到达 → 零
 *   new Audio；同轮回执照播（不误伤）；
 * - T3 通知服从对话（①）：对话语音在播时 voice.broadcast 到达 → 延后不立即
 *   播；对话收口后串行起播；
 * - T4 对话收编通知（①）：通知在播 + 队列有货时新对话轮起 → 在播 pause +
 *   队列清空（最新对话优先，弃播不回放）；
 * - T5 全轨停止（④）：通知在播时 stopSpeaking（静音钮/barge-in/Esc 共径）→
 *   通知停播 + 队列清空、弃播不续；
 * - T6 欢迎语钉子（范围钳制）：stopSpeaking 后欢迎语固化音频照常播完（不接
 *   协调器，现状行为保持）。
 *
 * mock 面：SessionContext（双钩共享）+ FakeMediaRecorder + fake meter/player
 * （player 带真体同构的 active 边沿）+ Audio stub（实例/pause 记录）+
 * wake-hotkey fire handler 捕获（T6）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardInterrupt = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
const sendSttTranscribe = vi.fn(() => true);
const sendVoiceSynthesize = vi.fn(() => true);
const sendVoiceSynthesizeStream = vi.fn(() => true);
const sendVoiceSynthesizeStop = vi.fn(() => true);
const sendSttStreamStart = vi.fn(() => true);
const sendSttStreamChunk = vi.fn(() => true);
const sendSttStreamFinish = vi.fn(() => true);
const sendSttStreamStop = vi.fn(() => true);
const sendVoiceSubscribe = vi.fn(() => true);
const sendVoiceUnsubscribe = vi.fn(() => true);

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
const subscribeStewardFrames = makeSubscribe("steward");
const subscribeSttFrames = makeSubscribe("stt");
const subscribeVoiceFrames = makeSubscribe("voice");

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardInterrupt,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    subscribeStewardFrames,
    sendSttTranscribe,
    subscribeSttFrames,
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamFinish,
    sendSttStreamStop,
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
    sendVoiceSubscribe,
    sendVoiceUnsubscribe,
    subscribeVoiceFrames,
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

import { useStewardVoice } from "@/features/steward/model/useStewardVoice";
import { useVoiceBroadcast } from "@/features/voice/model/useVoiceBroadcast";
import { resetSpeechMutexForTest, speechLeaseActive } from "@/shared/lib/speech-mutex";
import { resetSpeechFloorForTest } from "@/shared/lib/speech-floor";
import type { MeterFrame } from "@/shared/lib/rms-meter";

/** Audio stub（三出声面共用：实例/pause 记录；play 恒成功）。 */
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
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream, opts?: MediaRecorderOptions) {
    if (opts?.mimeType !== undefined) this.mimeType = opts.mimeType;
    FakeMediaRecorder.instances.push(this);
  }
  static isTypeSupported(mime: string): boolean {
    return mime === "audio/webm;codecs=opus" || mime === "audio/webm" || mime === "audio/mp4";
  }
  start(): void {
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    }, 5);
  }
  stop(): void {
    this.onstop?.();
  }
}

const fakeCreateMeter = async () => ({
  onLevel: (_cb: (frame: MeterFrame) => void) => undefined,
  close: () => undefined,
});

/** fake player（真体同构：stop 在播时发 active=false 边沿；enqueue 记录）。 */
let playerActiveCb: ((a: boolean) => void) | null = null;
let playerActive = false;
const playerEnqueued: [string, string][] = [];
let playerStopCalls = 0;
const createPlayer = () => ({
  enqueue(utterId: string, b64: string) {
    playerEnqueued.push([utterId, b64]);
    return true;
  },
  setVolume: () => undefined,
  drop: () => undefined,
  stop() {
    playerStopCalls += 1;
    if (playerActive) {
      playerActive = false;
      playerActiveCb?.(false);
    }
  },
  close() {
    playerStopCalls += 1;
    if (playerActive) {
      playerActive = false;
      playerActiveCb?.(false);
    }
  },
  reopen: () => undefined,
  onActiveChange(cb: (a: boolean) => void) {
    playerActiveCb = cb;
    return () => {
      playerActiveCb = null;
    };
  },
});
/** 真体同构 active 边沿驱动（enqueue 后真 player 自动转 active；act 包裹——边沿同步触发 React 状态）。 */
function playerGo(active: boolean): void {
  act(() => {
    if (playerActive === active) return;
    playerActive = active;
    playerActiveCb?.(active);
  });
}

function frame(type: string, payload: unknown, channel: string, sessionId = "__system__"): EventEnvelope {
  return { v: "0.14", sessionId, channel, type, payload } as EventEnvelope;
}

function installEnv(): { trackStop: ReturnType<typeof vi.fn>; restore: () => void } {
  const origDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const trackStop = vi.fn();
  const fakeStream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => fakeStream) },
    configurable: true,
  });
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  return {
    trackStop,
    restore: () => {
      Object.defineProperty(navigator, "mediaDevices", { value: origDevices, configurable: true });
      if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
      else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
    },
  };
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
}

type HookResult = { current: ReturnType<typeof useStewardVoice> };

let streamSeq = 0;

function renderVoice(options?: Parameters<typeof useStewardVoice>[0]): HookResult {
  return renderHook(() => useStewardVoice(options), { wrapper: I18nProvider }).result;
}

/** 挂 useVoiceBroadcast（App 根真实形态——通知面控制登记）。 */
async function mountBroadcast(): Promise<void> {
  await act(async () => {
    renderHook(() => useVoiceBroadcast(), { wrapper: I18nProvider });
  });
}

/** voice.broadcast 帧驱动（seq 单调）。 */
function broadcast(seq: number, tag: string): void {
  act(() => {
    emit(
      "voice",
      frame(
        "voice.broadcast",
        { kind: "agent.completed", agentId: "agent-1", text: "t", audio: `data:audio/wav;base64,${tag}`, provider: "dashscope", seq },
        "voice",
      ),
    );
  });
}

/** 广播 Audio 实例（src 后缀区分面——welcome/legacy/broadcast 三面共用 stub）。 */
const broadcastAudios = (): FakeAudio[] => FakeAudio.instances.filter((a) => a.src.startsWith("data:audio/wav;base64,B"));

describe("useStewardVoice 出声面协调（双声重叠修复批 ①②③④）", () => {
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN"); // jsdom 默认 en-US：钉 zh-CN（AG-14 白名单键）
    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    playerEnqueued.length = 0;
    playerStopCalls = 0;
    playerActive = false;
    playerActiveCb = null;
    streamSeq = 0;
    FakeAudio.instances = [];
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
    resetSpeechMutexForTest();
    resetSpeechFloorForTest();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    restoreEnv?.();
    restoreEnv = null;
    resetSpeechMutexForTest();
    resetSpeechFloorForTest();
  });

  it("T1 重叠回归（①②）：旧轮句未收口 + 新轮 ask → 旧句 sendStopFor + player 旧尾音停 + 新句零卡闸零降级 + 无 fallback Audio", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    // 旧轮：delta → 流式句 → chunk 入队（player 在播）——无 done（在途滞留形态）
    act(() => {
      r.current.ask("第一轮问题");
    });
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "第一轮回答。" }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesizeStream).toHaveBeenCalledTimes(1));
    const id1 = (sendVoiceSynthesizeStream.mock.calls[0] as unknown as [string])[0];
    act(() => {
      emit("voice", frame("voice.synthesize.chunk", { utterId: id1, seq: 1, audio: "QUJD" }, "voice"));
    });
    playerGo(true);
    expect(r.current.speaking).toBe(true);
    // 轮 1 终态（在途句无 done——滞留形态保持；verdict=stream 零回退）
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "第一轮回答。" }, "steward"));
    });
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    // 新轮 ask：resetAnswer 清在途（②）——旧句定向 stop + player 旧尾音停
    act(() => {
      r.current.ask("第二轮问题");
    });
    expect(sendVoiceSynthesizeStop).toHaveBeenCalledWith(id1); // money：在途句定向停
    expect(playerStopCalls).toBeGreaterThan(0); // 旧尾音即停（anyAudio 错位根除）
    // 新句零卡闸：delta → chunk 直入播放队列（不缓冲不降级）
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "第二轮回答。" }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesizeStream).toHaveBeenCalledTimes(2));
    const id2 = (sendVoiceSynthesizeStream.mock.calls[1] as unknown as [string])[0];
    act(() => {
      emit("voice", frame("voice.synthesize.chunk", { utterId: id2, seq: 1, audio: "REFD" }, "voice"));
    });
    expect(playerEnqueued.map(([id]) => id)).toEqual([id1, id2]); // 新句直通（闸未卡）
    // 终态：零降级零回退零 fallback Audio（双声第二源头消失）
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "第二轮回答。" }, "steward"));
    });
    expect(sendVoiceSynthesize).not.toHaveBeenCalled(); // 无一次性回退
    // 无 fallback Audio 起播（warmup 静音预热音频除外——src 前缀区分面）
    expect(FakeAudio.instances.filter((a) => a.src.startsWith("data:audio/mp4")).length).toBe(0);
  });

  it("T2 迟到回执弃播（③）：fallback 发出记轮次 → 新 ask 开轮 → 回执到达零 new Audio；同轮回执照播（对照不误伤）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    // 轮 1（零 delta 纯一次性路径）：answer → sendFallback（记轮次）
    act(() => {
      r.current.ask("第一轮");
    });
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "第一轮答复。" }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesize).toHaveBeenCalledTimes(1));
    // 新轮开（轮次 +1）→ 轮 1 的回执迟到到达 → 弃播
    act(() => {
      r.current.ask("第二轮");
    });
    act(() => {
      emit("voice", frame("voice.synthesize.result", { status: "ok", audio: "data:audio/mp4;base64,STALE", provider: "dashscope" }, "voice"));
    });
    expect(FakeAudio.instances.length).toBe(0); // 迟到回执弃播——零 new Audio
    expect(r.current.speaking).toBe(false);
    // 对照：轮 2 自己的回执（同轮）→ 照播
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "第二轮答复。" }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesize).toHaveBeenCalledTimes(2));
    act(() => {
      emit("voice", frame("voice.synthesize.result", { status: "ok", audio: "data:audio/mp4;base64,FRESH", provider: "dashscope" }, "voice"));
    });
    expect(FakeAudio.instances.length).toBe(1);
    expect(FakeAudio.instances[0]!.src).toBe("data:audio/mp4;base64,FRESH");
  });

  it("T3 通知服从对话（①）：对话语音在播时 voice.broadcast 到达 → 延后不立即播；对话收口后串行起播", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    await mountBroadcast();
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    // 对话语音在播：ask → delta → chunk → player active
    act(() => {
      r.current.ask("问题");
    });
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "对话回答。" }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesizeStream).toHaveBeenCalledTimes(1));
    const id1 = (sendVoiceSynthesizeStream.mock.calls[0] as unknown as [string])[0];
    act(() => {
      emit("voice", frame("voice.synthesize.chunk", { utterId: id1, seq: 1, audio: "QUJD" }, "voice"));
    });
    playerGo(true);
    // 通知到达 ×2 → 延后（不立即播，不打断对话）
    broadcast(1, "B1");
    broadcast(2, "B2");
    expect(broadcastAudios().length).toBe(0);
    // 对话收口：player 播尽 + 轮终态 → 串行起播
    playerGo(false);
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "对话回答。" }, "steward"));
    });
    expect(broadcastAudios().length).toBe(1); // 收口后首条起播
    act(() => {
      broadcastAudios()[0]!.onended?.();
    });
    expect(broadcastAudios().length).toBe(2); // 逐条串行
  });

  it("T4 对话收编通知（①）：通知在播 + 队列有货时新对话轮起 → 在播 pause + 队列清空（弃播不回放）", async () => {
    await mountBroadcast();
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    broadcast(1, "B1"); // 在播
    broadcast(2, "B2"); // 排队
    expect(broadcastAudios().length).toBe(1);
    // 新对话轮起（ask → round 租约占面——最新对话优先）
    act(() => {
      r.current.ask("新对话轮");
    });
    expect(broadcastAudios()[0]!.paused).toBe(true); // 在播被停
    expect(speechLeaseActive()).toBe(false); // 播报租约收位（收音不永抑）
    // 对话收口后零回放（队列已清——弃播语义）
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "答复。" }, "steward"));
    });
    expect(broadcastAudios().length).toBe(1);
  });

  it("T5 全轨停止（④）：通知在播 + 队列有货时 stopSpeaking → 通知停播 + 队列清空 + 弃播不续", async () => {
    await mountBroadcast();
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    broadcast(1, "B1"); // 在播
    broadcast(2, "B2"); // 排队
    expect(broadcastAudios().length).toBe(1);
    act(() => {
      r.current.stopSpeaking();
    });
    expect(broadcastAudios()[0]!.paused).toBe(true); // c 面停播
    expect(broadcastAudios().length).toBe(1); // 队列清空——不新建不续播
    // 已弃播条目的收口回调不续链
    act(() => {
      broadcastAudios()[0]!.onended?.();
    });
    expect(broadcastAudios().length).toBe(1);
    expect(speechLeaseActive()).toBe(false); // 租约收位
  });

  it("T6 欢迎语钉子（范围钳制）：stopSpeaking 后欢迎语固化音频照常播完（不接协调器）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    localStorage.setItem("helix.steward.welcomeAudio", "data:audio/mp4;base64,FIXEDWELCOME");
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    // 组合键进双工 → 欢迎语固化音频直播
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    act(() => {
      streamSeq += 1;
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: `s${streamSeq}` }, "stt"));
    });
    await waitFor(() => {
      const welcome = FakeAudio.instances.find((a) => a.src === "data:audio/mp4;base64,FIXEDWELCOME");
      expect(welcome).toBeDefined();
    });
    const welcome = FakeAudio.instances.find((a) => a.src === "data:audio/mp4;base64,FIXEDWELCOME")!;
    expect(welcome.paused).toBe(false);
    // 静音钮（stopSpeaking 共径：barge-in ①步/Esc 同）→ 欢迎语不受影响照常播
    act(() => {
      r.current.stopSpeaking();
    });
    expect(welcome.paused).toBe(false); // 不被停
    expect(welcome.onended).not.toBeNull(); // 收口回调保持（播完自然走完）
    // 播完：自然收口（租约释放、无异常）
    act(() => {
      welcome.onended?.();
    });
    expect(speechLeaseActive()).toBe(false);
    expect(r.current.duplexActive).toBe(true); // 双工会话不受 stopSpeaking 影响
  });
});
