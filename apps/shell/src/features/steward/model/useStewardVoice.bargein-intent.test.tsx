// @vitest-environment jsdom
/**
 * useStewardVoice barge-in 意图窗集成测试（Jev 停止意图判官单轨：声纹→ASR→
 * 判官判定→stop 真停/非 stop 丢弃——停止词表已整体退役）。
 *
 * 契约（行为变更）：
 * - T1 声学触发 → 开意图窗（不真停）：不停播（零 synthesize.stop）、零
 *   interrupt、duck 播报（player.setVolume 0.2）、开新转写流收插话、
 *   收音门控豁免（租约期 PCM 照上行）；
 * - T2 interim 快通道保持退役：窗内 interim 文本不再触发三步序（绕声纹
 *   总闸的快通道不复辟——停止判定必经 final 路径的声纹→判官序）；
 * - T3 final 分流面（丢弃语义改判官路径）：非停止 final → onFinalText 收
 *   ctx.bargeInIntent=true（Layer 经 judgeStopIntent 判定后丢弃）；判官
 *   RPC 回执判非 stop → 窗收位；零排队零 drain（播毕后零自动 ask）；
 * - T4 窗收位链：stopSpeaking 同径关窗（手动停读/新轮清在途）；
 * - T5 偏好关回退：helix.voice.bargeInIntent=0 → 声学直停（携 scope=all
 *   全停——裁决乙两轨分野）；
 * - T6-T8 judgeStopIntent 判官接线：回执分流 / 判不出归一（报错/降级/
 *   不可达/超时）——判不出=真停语义归消费面（窗内宁误停不漏停）。
 *
 * mock 面与 duplex.test 同构（SessionContext + FakeMediaRecorder + fake
 * meter/player）；耳 meter 帧注入 = 全实例广播（耳门/录音门共享 factory）。
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
const sendStewardJudgeStopIntent = vi.fn(() => true);

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
    subscribeVoiceFrames,
    sendStewardJudgeStopIntent,
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
import { resetSpeechMutexForTest } from "@/shared/lib/speech-mutex";
import { resetSpeechFloorForTest, beginNotificationPlayback, endNotificationPlayback } from "@/shared/lib/speech-floor";
import type { MeterFrame } from "@/shared/lib/rms-meter";

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

/** meter 帧回调收集（耳 meter + 录音 meter 共享 factory——注册的帧回调存此，测试广播帧驱动）。 */
const meterFrameCbs: Array<(f: MeterFrame) => void> = [];
const fakeCreateMeter = async () => ({
  onLevel: (cb: (f: MeterFrame) => void) => {
    meterFrameCbs.push(cb);
  },
  close: () => undefined,
});

let playerActiveCb: ((a: boolean) => void) | null = null;
const playerSetVolumeCalls: number[] = [];
const createPlayer = () => ({
  enqueue(_utterId: string, _b64: string) {
    return true;
  },
  setVolume: (v: number) => {
    playerSetVolumeCalls.push(v);
  },
  drop: () => {},
  stop: () => {},
  close: () => {},
  reopen: () => {},
  onActiveChange(cb: (a: boolean) => void) {
    playerActiveCb = cb;
    return () => {
      playerActiveCb = null;
    };
  },
});

function frame(type: string, payload: unknown, channel: string, sessionId = "__system__"): EventEnvelope {
  return { v: "0.14", sessionId, channel, type, payload } as EventEnvelope;
}

function installEnv(): { restore: () => void } {
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

/** 向全部 meter 回调广播帧（耳门/录音门同帧驱动——录音门收帧无碍判定）。 */
function broadcastFrame(rms: number, zcr: number): void {
  const f: MeterFrame = { rms, zcr };
  for (const cb of meterFrameCbs) cb(f);
}

/** 强制停 + 终帧（对最新流发——收口录音链让 speaking 相位可见；
 *  recording/transcribing 优先级压过 speaking，不收口则测不到播报期）。 */
async function finishUtterance(finalText: string): Promise<void> {
  let nowMs = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  try {
    nowMs += 500;
    act(() => {
      FakeMediaRecorder.instances.at(-1)?.stop();
    });
    await tick();
  } finally {
    spy.mockRestore();
  }
  act(() => {
    emit("stt", frame("stt.stream.final", { status: "ok", streamId: `s${streamSeq}`, text: finalText }, "stt"));
  });
  await tick();
}

/** 对最新一次开流回执 started（意图窗 beginListening 开的新流——帧门控需要）。 */
async function ackLatestStream(): Promise<void> {
  await waitFor(() => expect(sendSttStreamStart.mock.calls.length).toBeGreaterThan(streamSeq));
  act(() => {
    streamSeq += 1;
    emit("stt", frame("stt.stream.started", { status: "ok", streamId: `s${streamSeq}` }, "stt"));
  });
  await tick();
}

/** 声学触发 barge-in 门：speaking 档人声帧 ×5（RMS 0.5 超抬档阈值 × ZCR 带内
 *  × 间隔 100ms 累计 400ms ≥ 最短持续 300ms）。 */
async function voiceBargeInFrames(): Promise<void> {
  let nowMs = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  try {
    nowMs += 500; // 跳过 stopSpeaking 残响静默窗（300ms——stewardSpeaking 链内开窗）
    for (let i = 0; i < 5; i += 1) {
      nowMs += 100;
      broadcastFrame(0.5, 0.1);
      await tick();
    }
  } finally {
    spy.mockRestore();
  }
}

/** 驱动一轮「delta → answer → TTS 出声」到 speaking 相位
 *  （前置 toggleMute 挂起自动续听——recording 相位优先级压过 speaking，
 *  常开麦下 speaking 不可见；测试面挂起续听让播报期相位可见）。 */
async function stewardSpeaking(r: HookResult): Promise<void> {
  act(() => {
    r.current.toggleMute(); // 挂起自动续听（D5）——零 recording 压制
  });
  await tick();
  act(() => {
    emit("steward", frame("steward.ask.delta", { delta: "回答正文。" }, "steward"));
    emit("steward", frame("steward.ask.result", { status: "answer", text: "回答正文。" }, "steward"));
  });
  await waitFor(() => expect(sendVoiceSynthesizeStream.mock.calls.length).toBeGreaterThan(0));
  const realId = (sendVoiceSynthesizeStream.mock.calls.at(-1) as unknown as [string])[0];
  act(() => {
    emit("voice", frame("voice.synthesize.chunk", { utterId: realId, seq: 1, audio: "QUJD" }, "voice"));
    playerActiveCb?.(true);
    emit("voice", frame("voice.synthesize.done", { utterId: realId }, "voice"));
  });
  await tick();
}

describe("useStewardVoice barge-in 意图窗（意图门控打断——停止意图才真停）", () => {
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    playerSetVolumeCalls.length = 0;
    meterFrameCbs.length = 0;
    streamSeq = 0;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    restoreEnv?.();
    restoreEnv = null;
  });

  it("T1 声学触发 → 开意图窗不真停：零 stop 帧 + 零 interrupt + duck + 开新流 + 收音豁免", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    await stewardSpeaking(r);
    expect(r.current.phase).toBe("speaking");

    sendSttStreamStart.mockClear();
    sendSttStreamChunk.mockClear();
    sendVoiceSynthesizeStop.mockClear(); // stewardSpeaking 链内残留清零——断言只看触发后行为
    sendStewardInterrupt.mockClear();
    playerSetVolumeCalls.length = 0; // player 构造期音量预设（0.8）清零
    await voiceBargeInFrames();

    await waitFor(() => expect(r.current.bargeInIntentActive).toBe(true));
    // 不真停：零停止帧 + 零 interrupt（三步序未执行）
    expect(sendVoiceSynthesizeStop).not.toHaveBeenCalled();
    expect(sendStewardInterrupt).not.toHaveBeenCalled();
    // duck：player 音量压到 0.2
    expect(playerSetVolumeCalls).toEqual([0.2]);
    // 开新转写流收插话（③beginListening 面）
    expect(sendSttStreamStart.mock.calls.length).toBeGreaterThan(0);
  });

  it("T2 interim 快通道保持退役：窗内 interim 全等停止文本「停」→ 不触发三步序（声纹→ASR→判官链——停止判定必经 final 路径声纹验后）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    await stewardSpeaking(r);
    sendVoiceSynthesizeStop.mockClear();
    sendStewardInterrupt.mockClear();
    playerSetVolumeCalls.length = 0;
    await voiceBargeInFrames();
    await waitFor(() => expect(r.current.bargeInIntentActive).toBe(true));
    await ackLatestStream(); // 窗内 beginListening 开的新流 ack（帧门控）

    act(() => {
      emit("stt", frame("stt.stream.interim", { streamId: `s${streamSeq}`, prior: "", text: "停", stash: "" }, "stt"));
    });
    await tick();

    // 零三步序：interim 仅上屏，停止判定等 final 路径（声纹→判官）
    expect(sendVoiceSynthesizeStop).not.toHaveBeenCalled();
    expect(sendStewardInterrupt).not.toHaveBeenCalled();
    expect(r.current.bargeInIntentActive).toBe(true); // 窗仍在（未真停）
    expect(playerSetVolumeCalls).toEqual([0.2]); // duck 保持（未恢复）
  });

  it("T3 final 分流面（丢弃语义改判官路径）：非停止 final → ctx.bargeInIntent=true + 判官判非 stop 丢弃；零排队零 drain", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const seenCtx: Array<{ bargeInIntent: boolean } | undefined> = [];
    const r = renderVoice({
      createMeter: fakeCreateMeter,
      createPlayer,
      onFinalText: (text, ctx) => {
        if (text === "你说得对但是") seenCtx.push(ctx);
        return "consumed";
      },
    });
    await pressHotkey(r);
    await stewardSpeaking(r);
    sendVoiceSynthesizeStop.mockClear();
    sendStewardInterrupt.mockClear();
    playerSetVolumeCalls.length = 0;
    await voiceBargeInFrames();
    await waitFor(() => expect(r.current.bargeInIntentActive).toBe(true));
    await ackLatestStream();

    // 收口（VAD 停 → finalPending 门开）→ final 到达（意图窗内）→ ctx 分流面。
    // Date.now 推进越过窗开期 mock 时间轴（voiceBargeInFrames 的 startedAt 带
    // 未来时戳——真时钟回落后 duration 为负；起步真 now +1500 保证 > startedAt+300）。
    let nowMs = Date.now();
    const stopSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    nowMs += 1_500;
    act(() => {
      r.current.stopListening();
    });
    await tick();
    stopSpy.mockRestore();
    act(() => {
      emit("stt", frame("stt.stream.final", { status: "ok", streamId: `s${streamSeq}`, text: "你说得对但是" }, "stt"));
    });
    await tick();
    expect(seenCtx).toEqual([{ bargeInIntent: true }]);

    // 判官判定面（停止判定单源 = Jev）：RPC 发出 + 回执判非 stop → 丢弃
    const verdict = r.current.judgeStopIntent("你说得对但是");
    expect(sendStewardJudgeStopIntent).toHaveBeenCalledWith("你说得对但是");
    act(() => {
      emit("steward", frame("steward.judge_stop_intent.result", { stop: false, score: 0.1 }, "steward"));
    });
    await expect(verdict).resolves.toBe("other");

    // Layer 丢弃裁决镜像（裁决 #2：判非 stop → 丢弃关窗，无排队面）
    act(() => {
      r.current.closeBargeInIntentWindow();
    });
    expect(r.current.bargeInIntentActive).toBe(false);
    // 播报未停（无 stop 帧）——插话不中断
    expect(sendVoiceSynthesizeStop).not.toHaveBeenCalled();
    expect(sendStewardInterrupt).not.toHaveBeenCalled();

    // 播毕（player active false）→ 零自动 ask（drain 已拆——插话已丢弃，无队列残留）
    sendStewardAsk.mockClear();
    act(() => {
      playerActiveCb?.(false);
    });
    await tick();
    await new Promise((res) => setTimeout(res, 40));
    expect(sendStewardAsk).not.toHaveBeenCalled();
  });

  it("T4 窗收位链（stopSpeaking 同径关窗）：手动停读/新轮清在途 → 窗关 + 音量恢复 + 零 interrupt（超时计时器 = 同一 settle 回调另一触发源，T2 已覆盖 settle 链）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    await stewardSpeaking(r);
    sendVoiceSynthesizeStop.mockClear();
    sendStewardInterrupt.mockClear();
    playerSetVolumeCalls.length = 0;
    await voiceBargeInFrames();
    await waitFor(() => expect(r.current.bargeInIntentActive).toBe(true));

    sendStewardInterrupt.mockClear(); // stopSpeaking 会发 stop 帧（合法）——只断言零 interrupt
    act(() => {
      r.current.stopSpeaking(); // 手动停读（静音钮同径）
    });
    await tick();
    expect(r.current.bargeInIntentActive).toBe(false); // 窗随停播收位
    expect(playerSetVolumeCalls).toEqual([0.2, 1]); // duck → 恢复
    expect(sendStewardInterrupt).not.toHaveBeenCalled(); // 停读不打断 LLM 轮
    expect(sendStewardAsk).not.toHaveBeenCalled(); // 零排队提交
  });

  it("T5 偏好关回退声学直停：bargeInIntent=0 → 触发即三步序（原行为）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    localStorage.setItem("helix.voice.bargeInIntent", "0");
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    await stewardSpeaking(r);
    sendVoiceSynthesizeStop.mockClear();
    sendStewardInterrupt.mockClear();
    playerSetVolumeCalls.length = 0;
    await voiceBargeInFrames();

    await waitFor(() => expect(sendVoiceSynthesizeStop).toHaveBeenCalled()); // ① 直停
    expect(sendStewardInterrupt).toHaveBeenCalledWith("barge-in", "all"); // ② 携 scope=all（裁决乙：语音停止通道全停）
    expect(r.current.bargeInIntentActive).toBe(false); // 零意图窗
    expect(playerSetVolumeCalls).toEqual([]); // 零 duck
  });
  // 批 3b 退役：T6 drain 通知守卫（排队插话 drain 面拆除——无队列无自动提交，
  // 通知守卫随 drain 一同消亡）；judge describe 随判官单轨复归（Jev 停止判定
  // 慢通道→单轨判定面，见下方 describe）。
});

describe("useStewardVoice judgeStopIntent（Jev 停止判定单轨：RPC 判定面 + 判不出归一）", () => {
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    playerSetVolumeCalls.length = 0;
    meterFrameCbs.length = 0;
    streamSeq = 0;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    restoreEnv?.();
    restoreEnv = null;
  });

  it("T6 回执分流：stop=true → \"stop\"；stop=false → \"other\"；stop=false+degraded → \"unjudged\"（判官报错/降级判不出）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });

    const first = r.current.judgeStopIntent("先别说了");
    act(() => {
      emit("steward", frame("steward.judge_stop_intent.result", { stop: true, score: 0.9 }, "steward"));
    });
    await expect(first).resolves.toBe("stop");

    const second = r.current.judgeStopIntent("现在说到哪了");
    act(() => {
      emit("steward", frame("steward.judge_stop_intent.result", { stop: false, score: 0.1 }, "steward"));
    });
    await expect(second).resolves.toBe("other");

    const third = r.current.judgeStopIntent("先别说了");
    act(() => {
      emit("steward", frame("steward.judge_stop_intent.result", { stop: false, degraded: "error" }, "steward"));
    });
    await expect(third).resolves.toBe("unjudged");
  });

  it("T7 未连接/未装配（send false）→ \"unjudged\"（不可达判不出——不悬挂等待）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    sendStewardJudgeStopIntent.mockImplementationOnce(() => false);
    await expect(r.current.judgeStopIntent("先别说了")).resolves.toBe("unjudged");
    expect(sendStewardJudgeStopIntent).toHaveBeenCalledTimes(1);
  });

  it("T8 判官超时 → \"unjudged\"（判不出归一——真停语义归消费面）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    vi.useFakeTimers();
    try {
      const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
      const p = r.current.judgeStopIntent("先别说了");
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(p).resolves.toBe("unjudged");
    } finally {
      vi.useRealTimers();
    }
  });

  it("T9 判 stop → 真停同径携 scope=all（executeBargeInStop：全轨停播 + interrupt all）；判非 stop → 丢弃镜像零 interrupt", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });

    // 判 stop → Layer 调 executeBargeInStop（判官单轨命中语义）
    const stopVerdict = r.current.judgeStopIntent("停");
    act(() => {
      emit("steward", frame("steward.judge_stop_intent.result", { stop: true, score: 0.95 }, "steward"));
    });
    await expect(stopVerdict).resolves.toBe("stop");
    sendStewardInterrupt.mockClear();
    act(() => {
      r.current.executeBargeInStop();
    });
    expect(sendStewardInterrupt).toHaveBeenCalledWith("barge-in", "all");

    // 判非 stop → 丢弃（窗收位镜像）零 interrupt
    sendStewardInterrupt.mockClear();
    const otherVerdict = r.current.judgeStopIntent("现在说到哪了");
    act(() => {
      emit("steward", frame("steward.judge_stop_intent.result", { stop: false, score: 0.1 }, "steward"));
    });
    await expect(otherVerdict).resolves.toBe("other");
    act(() => {
      r.current.closeBargeInIntentWindow();
    });
    expect(sendStewardInterrupt).not.toHaveBeenCalled();
  });
});