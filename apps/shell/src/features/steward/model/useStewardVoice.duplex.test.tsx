// @vitest-environment jsdom
/**
 * useStewardVoice 双工会话集成测试（B2 全局语音批；TDD 红→绿）。
 *
 * 链路集成点（设计稿 §3.2/§3.3 + D5/D6）：
 * - 进入双工：组合键 → duplex=true + 欢迎语 TTS（speechOut 流式链复用——
 *   TR-200 播放闸不动）+ 光球可见态；
 * - 双工循环：终帧喂 ask → delta 字幕+TTS → 播放收口（说完）→ 自动续听
 *   （新 stt.stream.start，VAD 分段继续听直到关麦）；
 * - 关麦收口（D6=同现有逻辑）：对话在途再按组合键 → 停采集（track.stop
 *   即刻零转写，ed508171 同纪律）+ 停朗读（synthesize stop + 队列清空）
 *   + duplex=false；**不动在途 ask 轮**（steward.interrupt 零调用——
 *   abortInFlight 不触发，结果照常落历史）；
 * - 临时静音（D5）：listening 点击 toggleMute → 续听挂起；再按恢复；
 * - 口令拦截（D3=b）：options.onFinalText 返回 consumed → 零 ask（前端
 *   本地消费，口令解析面 voice-command.test 钉）。
 *
 * mock 面：SessionContext + FakeMediaRecorder + fake meter/player +
 * wake-hotkey fire handler 捕获（wake.test 同构）。
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
import { requestOpenSteward } from "@/shared/lib/steward-open-signal";
import { beginSpeechLease, endSpeechLease, resetSpeechMutexForTest } from "@/shared/lib/speech-mutex";
import {
  beginNotificationPlayback,
  endNotificationPlayback,
  resetSpeechFloorForTest,
} from "@/shared/lib/speech-floor";
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

const fakeCreateMeter = async () => ({
  onLevel: () => undefined,
  close: () => undefined,
});

let playerActiveCb: ((a: boolean) => void) | null = null;
const playerEnqueued: string[] = [];
const createPlayer = () => ({
  enqueue(_utterId: string, b64: string) {
    playerEnqueued.push(b64);
    return true;
  },
  setVolume: () => {},
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

/** 组合键触发 + 开流回执（唤醒词空串直通——无门槛即入 listening）。 */
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

/** 对最新一次开流回执 started（自动续听开的新流——streamId 门控需要）。 */
async function ackLatestStream(): Promise<void> {
  await waitFor(() => expect(sendSttStreamStart.mock.calls.length).toBeGreaterThan(streamSeq));
  act(() => {
    streamSeq += 1;
    emit("stt", frame("stt.stream.started", { status: "ok", streamId: `s${streamSeq}` }, "stt"));
  });
  await tick();
}

/** 强制停 + 终帧（VAD 分段断句收口——过最短录音窗防误触门；对最新流发）。 */
async function finishUtterance(r: HookResult, finalText: string): Promise<void> {
  let nowMs = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  try {
    nowMs += 500;
    act(() => {
      r.current.stopListening();
    });
    await tick();
  } finally {
    spy.mockRestore();
  }
  act(() => {
    emit("stt", frame("stt.stream.final", { status: "ok", streamId: `s${streamSeq}`, text: finalText }, "stt"));
  });
}

/** 驱动一轮「delta 流式 → TTS 出声」到 speaking 在途（chunk + player active；
 *  keepPending：不发 done 帧——关麦断言面需要 pending 在途）。 */
async function stewardAnswers(keepPending = false): Promise<string> {
  act(() => {
    emit("steward", frame("steward.ask.delta", { delta: "回答第一句。" }, "steward"));
    emit("steward", frame("steward.ask.result", { status: "answer", text: "回答第一句。" }, "steward"));
  });
  await waitFor(() => expect(sendVoiceSynthesizeStream.mock.calls.length).toBeGreaterThan(0));
  const realId = (sendVoiceSynthesizeStream.mock.calls.at(-1) as unknown as [string])[0];
  act(() => {
    emit("voice", frame("voice.synthesize.chunk", { utterId: realId, seq: 1, audio: "QUJD" }, "voice"));
    playerActiveCb?.(true);
    if (!keepPending) emit("voice", frame("voice.synthesize.done", { utterId: realId }, "voice"));
  });
  return realId;
}

describe("useStewardVoice 双工会话（B2：组合键 → 光球双工 → 关麦收口）", () => {
  let restoreEnv: (() => void) | null = null;
  let trackStop: ReturnType<typeof vi.fn> | null = null;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN"); // jsdom 默认 en-US：钉 zh-CN（AG-14 白名单键）

    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    playerEnqueued.length = 0;
    streamSeq = 0;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    restoreEnv?.();
    restoreEnv = null;
    trackStop = null;
  });

  it("进入双工：组合键 → duplex=true + 欢迎语 TTS 流式（speechOut 链复用，非一次性）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    expect(r.current.duplexActive).toBe(true);
    // 欢迎语经 speechOut 流式链（TR-200 闸复用）：sendStream 携欢迎语文本
    await waitFor(() => expect(sendVoiceSynthesizeStream).toHaveBeenCalledTimes(1));
    const welcomeText = (sendVoiceSynthesizeStream.mock.calls[0] as unknown as [string, string])[1];
    expect(welcomeText.length).toBeGreaterThan(0); // i18n 常量文案（Layer 测试钉具体文本）
    expect(sendVoiceSynthesize).not.toHaveBeenCalled(); // 非一次性回退路径
  });

  it("欢迎语固化优先（欢迎词固化批）：localStorage 固化音频在 → new Audio 直播 + 零 TTS 合成；未固化 → 回退 say 现合成", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    // Audio stub（jsdom 无 Audio——固化路径播面；play 回执计数）
    const plays: string[] = [];
    const audioInstances: { src: string; volume: number }[] = [];
    vi.stubGlobal(
      "Audio",
      // function 形态 mock（箭头函数非构造器——new 调用抛错会走错路径）
      vi.fn().mockImplementation(function (this: { src: string; volume: number; play: () => Promise<void>; pause: () => void; onended: null }, src: string) {
        this.src = src;
        this.volume = 1;
        this.play = () => (plays.push(src), Promise.resolve());
        this.pause = () => {};
        this.onended = null;
        audioInstances.push(this);
      }),
    );
    localStorage.setItem("helix.steward.welcomeAudio", "data:audio/mp4;base64,FIXED");
    localStorage.setItem("helix.steward.welcomeText", "主人好。");
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    expect(r.current.duplexActive).toBe(true);
    await waitFor(() => expect(plays).toEqual(["data:audio/mp4;base64,FIXED"])); // 固化音频直接播
    expect(sendVoiceSynthesizeStream).not.toHaveBeenCalled(); // 零 TTS 合成（零合成延迟）
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    expect(r.current.speaking).toBe(false); // 固化路径不占 speaking 相位（球待机驻留）
    expect(audioInstances[0]?.volume).toBeGreaterThan(0); // 音量偏好应用
    vi.unstubAllGlobals();
  });

  it("双工循环：终帧喂 ask → delta TTS → 播放收口后自动续听（新 stt.stream.start，直到关麦）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    trackStop = env.trackStop;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    // 欢迎语首句已开流；用户说话（终帧）→ ask
    const streamStartsBefore = sendSttStreamStart.mock.calls.length;
    await finishUtterance(r, "现在有什么在跑？");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledWith("现在有什么在跑？"));
    // 管家流式回答 → TTS 出声（speaking）
    await stewardAnswers();
    expect(r.current.speaking).toBe(true);
    // 播放收口（说完）→ 自动续听：phase 回 listening + 新开流
    act(() => {
      playerActiveCb?.(false);
    });
    await waitFor(() => expect(sendSttStreamStart.mock.calls.length).toBeGreaterThan(streamStartsBefore));
    await waitFor(() => expect(r.current.phase).toBe("listening"));
  });

  it("关麦收口（D6）：对话在途再按组合键 → 停采集（track.stop）+ 停朗读 + 不动在途轮（interrupt 零调用）+ duplex=false", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    trackStop = env.trackStop;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    await finishUtterance(r, "现在有什么在跑？");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    await stewardAnswers(true); // keepPending：关麦断言需要朗读在途
    expect(r.current.speaking).toBe(true);
    // 关麦（再按组合键——单键 toggle，D2）
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    expect(r.current.duplexActive).toBe(false);
    expect(trackStop).toHaveBeenCalled(); // 停采集：track.stop 即刻零转写
    expect(sendVoiceSynthesizeStop).toHaveBeenCalled(); // 停朗读：stop + 队列清空
    expect(sendStewardInterrupt).not.toHaveBeenCalled(); // 不动在途 ask 轮（结果照常落历史）
    expect(sendSttStreamStop).toHaveBeenCalled(); // 在途转写流废流
  });

  it("临时静音（D5）：listening toggleMute → 续听挂起（说完不自动重开）；再按恢复续听", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await pressHotkey(r);
    await finishUtterance(r, "现在有什么在跑？");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    await stewardAnswers();
    // answer 终态后自动续听（不等朗读收口——VAD 分段持续听，连说多句排队面）
    await waitFor(() => expect(r.current.phase).toBe("listening"));
    const beforeMute = sendSttStreamStart.mock.calls.length;
    // 静音：续听挂起（停采集）
    act(() => {
      r.current.toggleMute();
    });
    expect(r.current.muted).toBe(true);
    // 静音期：朗读收口（speaking→idle 边沿）零自动重开
    act(() => {
      playerActiveCb?.(false);
    });
    await tick();
    expect(sendSttStreamStart.mock.calls.length).toBe(beforeMute); // muted：零自动重开
    // 再按恢复：续听重开
    act(() => {
      r.current.toggleMute();
    });
    expect(r.current.muted).toBe(false);
    await waitFor(() => expect(sendSttStreamStart.mock.calls.length).toBeGreaterThan(beforeMute));
  });

  it("口令拦截（D3=b）：onFinalText 返回 consumed → 零 ask（前端本地消费）；pass → 照发", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const onFinalText = vi.fn((text: string): "consumed" | "pass" => (text === "确认" ? "consumed" : "pass"));
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer, onFinalText });
    await pressHotkey(r);
    await finishUtterance(r, "确认");
    await tick();
    expect(onFinalText).toHaveBeenCalledWith("确认");
    expect(sendStewardAsk).not.toHaveBeenCalled(); // 口令句零 ask
    // 自动续听开新流 → 回执后第二轮照发
    await ackLatestStream();
    await finishUtterance(r, "帮我确认一下");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledWith("帮我确认一下")); // 聊天句照发
  });

  it("B2-hotfix：热键直通无待命超时——唤醒词非空 + 短窗注入 duplex 也不落（旧待命超时收场语义退役）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;

    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: "s1" }, "stt"));
    });
    expect(r.current.duplexActive).toBe(true);
    expect(r.current.phase).toBe("listening"); // 直通待听（非 wake_armed）
    // 短窗 50ms × 8 倍余量：无超时计时器（duplex 只随关麦/Esc 收口）
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.current.duplexActive).toBe(true);
  });

  it("steward-open-signal 零消费（B2：唤醒不弹面板——requestOpenSteward 零调用面）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer });
    // Layer 的 wakeSignal 消费面在 StewardVoiceLayer——hook 本体不再发/不再依赖面板
    await pressHotkey(r);
    expect(r.current.duplexActive).toBe(true);
    // hook 面不再发起 requestOpenSteward（接线方已改光球）：以返回面无面板依赖为断言
    // （requestOpenSteward 的接线测试归 StewardVoiceLayer/App.steward-global）
  });
});

// ── 底噪校准（语音判定钝感批：duplex 前置采样 → 两门阈值抬升）──────────

/** Fake meter（emit 驱动门判定；closed 后帧零转发——与真 meter 同构）。 */
class CalibMeter {
  static instances: CalibMeter[] = [];
  cb: ((frame: MeterFrame) => void) | null = null;
  closed = false;
  onLevel(cb: (frame: MeterFrame) => void): void {
    this.cb = cb;
  }
  close(): void {
    this.closed = true;
  }
  emit(rms: number, zcr = 0.1): void {
    if (!this.closed) this.cb?.({ rms, zcr });
  }
}

describe("useStewardVoice（底噪校准：duplex 前置采样 → 两门阈值抬升）", () => {
  let restoreEnv: (() => void) | null = null;
  let nowMs = 0;
  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;
  const createMeter = async () => {
    const m = new CalibMeter();
    CalibMeter.instances.push(m);
    return m;
  };
  /** 开着的 meter（toggleMute 后仅剩耳 meter；挂载序不定——取未关闭者）。 */
  const ear = (): CalibMeter => CalibMeter.instances.find((m) => !m.closed) ?? CalibMeter.instances[0]!;

  /** 进双工 + 双 meter 就位 + 临时静音留耳（reachSpeaking 需 voiceState 离开 recording）。 */
  async function enterDuplexMuted(r?: HookResult): Promise<void> {
    await pressHotkey(r);
    await waitFor(() => expect(CalibMeter.instances.length).toBeGreaterThanOrEqual(2));
    if (r !== undefined) {
      act(() => {
        r.current.toggleMute();
      });
    }
    await tick();
  }

  /** 采样窗驱动：窗内 count 帧底噪 0.02 + 每 5 帧一枚 TTS 回灌尖峰（帧间 100ms
   *  同构节流）；末帧落在窗边界外 → 定稿底噪估计。 */
  function calibrate(count = 25): void {
    for (let i = 0; i < count; i += 1) {
      act(() => {
        ear().emit(i % 5 === 4 ? 0.3 : 0.02); // 欢迎语回灌是偶发尖峰——低百分位鲁棒
      });
      nowMs += 100;
    }
    act(() => {
      ear().emit(0.02); // ≥ 窗长（2500ms）→ 采样窗关闭定稿
    });
  }

  /** 帧驱动（帧间 100ms）。 */
  function frames(count: number, rms: number, zcr = 0.1): void {
    for (let i = 0; i < count; i += 1) {
      act(() => {
        ear().emit(rms, zcr);
      });
      nowMs += 100;
    }
  }

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");

    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    playerEnqueued.length = 0;
    streamSeq = 0;
    CalibMeter.instances = [];
    resetSpeechMutexForTest();
    resetSpeechFloorForTest();
    nowMs = Date.now();
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    CalibMeter.instances = [];
    resetSpeechMutexForTest();
    resetSpeechFloorForTest();
    nowSpy?.mockRestore();
    nowSpy = null;
    restoreEnv?.();
    restoreEnv = null;
  });

  it("底噪估计（低百分位）抬升 barge-in 门：偏好阈值下会触发的帧（0.04）抬升后不触发；够响帧照常触发", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter, createPlayer });
    await enterDuplexMuted(r);
    // 采样窗：底噪 0.02 混 TTS 尖峰 → P20 ≈ 0.02 → 阈值 max(0.012, 0.02×2.5=0.05)
    calibrate(25);
    await stewardAnswers(true); // 流式朗读在途 → speaking
    expect(r.current.phase).toBe("speaking");
    // 0.04 帧：纯偏好下（speaking ×2 = 0.024）会触发；抬升后（×2 = 0.10）不触发
    frames(10, 0.04);
    expect(sendStewardInterrupt).not.toHaveBeenCalled();
    // 对照：够响帧（0.2 > 0.10）持续 → 照常触发（门未被校准钉死）
    frames(10, 0.2);
    expect(sendStewardInterrupt).toHaveBeenCalledTimes(1);
  });

  it("采样帧不足（<10）→ 不校准回落纯偏好值：同幅帧（0.04）照常触发", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter, createPlayer });
    await enterDuplexMuted(r);
    // 仅 5 帧采样 + 越窗定稿 → 回落纯偏好（0.012）
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        ear().emit(0.02);
      });
      nowMs += 100;
    }
    nowMs += 3_000; // 采样窗关闭
    act(() => {
      ear().emit(0.02);
    });
    await stewardAnswers(true);
    expect(r.current.phase).toBe("speaking");
    frames(8, 0.04); // speaking ×2 = 0.024 < 0.04 → 触发（纯偏好行为不变）
    expect(sendStewardInterrupt).toHaveBeenCalledTimes(1);
  });

  it("cancelWake 后再开双工 → 重新校准：同幅帧（0.05）两轮判定随底噪重采翻转", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter, createPlayer });
    await enterDuplexMuted(r);
    calibrate(25); // 轮 1：底噪 0.02 → 阈值 0.05（speaking ×2 = 0.10）
    await stewardAnswers(true);
    frames(8, 0.05);
    expect(sendStewardInterrupt).not.toHaveBeenCalled(); // 0.05 < 0.10：不触发
    // 关麦收口 → 再开双工：重采（底噪 0.004 → 阈值回落纯偏好 0.012）
    act(() => {
      r.current.cancelWake();
    });
    await tick();
    CalibMeter.instances = CalibMeter.instances.filter((m) => !m.closed);
    await enterDuplexMuted(r);
    for (let i = 0; i < 25; i += 1) {
      act(() => {
        ear().emit(0.004); // 安静房：底噪低
      });
      nowMs += 100;
    }
    act(() => {
      ear().emit(0.004);
    });
    await stewardAnswers(true);
    frames(8, 0.05); // 0.012×2 = 0.024 < 0.05 → 触发（同幅帧翻转）
    expect(sendStewardInterrupt).toHaveBeenCalledTimes(1);
  });

  it("同源单点：同一帧序列两门判定一致——收口门拒帧（零 finish）+ barge-in 门拒帧（零打断）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter, createPlayer });
    await pressHotkey(r);
    await waitFor(() => expect(CalibMeter.instances.length).toBeGreaterThanOrEqual(2));
    // 鉴别录音/耳 meter：低幅探测帧（0.009 < 一切阈值——不污染 spoke/校准）
    // 唯 level 面回响：录音 meter 驱动 level 状态
    let recM = CalibMeter.instances[0]!;
    let earM = CalibMeter.instances[1]!;
    act(() => {
      recM.emit(0.009);
    });
    if (r.current.level < 0.03) {
      [recM, earM] = [earM, recM];
    }
    // 耳侧校准（底噪 0.02 → 两门阈值 0.05）
    for (let i = 0; i < 25; i += 1) {
      act(() => {
        earM.emit(0.02);
      });
      nowMs += 100;
    }
    act(() => {
      earM.emit(0.02);
    });
    const finishBefore = sendSttStreamFinish.mock.calls.length;
    // 录音侧同幅帧（0.04 < 0.05 抬升阈值、> 0.012 纯偏好）：收口门若消费纯
    // 偏好则计为开口（静音窗满足后走 finish 转写）；消费抬升阈值则按未开口丢弃
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        recM.emit(0.04);
      });
      nowMs += 100;
    }
    for (let i = 0; i < 19; i += 1) {
      act(() => {
        recM.emit(0.001);
      });
      nowMs += 100;
    }
    await tick();
    expect(sendSttStreamFinish.mock.calls.length).toBe(finishBefore); // 按未开口丢弃（零转写零计费）
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    // 打断门同帧一致拒：speaking 期 0.04 帧零打断（0.04 < 0.15）
    await stewardAnswers(true);
    frames(10, 0.04);
    expect(sendStewardInterrupt).not.toHaveBeenCalled();
  });

  it("校准排除发言租约期帧（欢迎语污染修复）：租约期帧不入样本 → 样本不足回落纯偏好 → 阈值不被毒化", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter, createPlayer });
    await enterDuplexMuted(r);
    // 欢迎语播放形态：租约在场，采样窗内的帧全被跳过（不入样本）
    beginSpeechLease("test-welcome");
    for (let i = 0; i < 30; i += 1) {
      act(() => {
        ear().emit(0.3); // 若入样本，P20 会被 TTS 回灌毒化到焊死位
      });
      nowMs += 100;
    }
    act(() => {
      ear().emit(0.001); // 越窗定稿：样本学 0（租约期全跳）→ noiseFloor = null
    });
    endSpeechLease("test-welcome");
    await stewardAnswers(true);
    expect(r.current.phase).toBe("speaking");
    // 纯偏好阈值（0.012×2 = 0.024）：0.3 帧照常触发（若被毒化则 P20=0.3 → 阈 0.75 焊死永不触发）
    frames(10, 0.3);
    expect(sendStewardInterrupt).toHaveBeenCalledTimes(1);
  });

  it("通知播报期 barge-in 门开（打断不灵敏修复）：相位 idle + 通知占用在场 → 响帧照常打断；无占用同帧零触发（对照）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice({ createMeter, createPlayer });
    await enterDuplexMuted(r); // 静音休眠态：相位 idle，门本天
    await waitFor(() => expect(r.current.phase).toBe("idle")); // 欢迎语 TTS 收口后归位（控制段纯净）
    // 越窗定稿校准（零样本回落纯偏好——排除校准变量）
    nowMs += 3000;
    act(() => {
      ear().emit(0.001);
    });
    // 对照：无通知占用时响帧零触发（idle 相位门关——现状语义钉子）
    frames(6, 0.3);
    expect(sendStewardInterrupt).not.toHaveBeenCalled();
    // 通知占用在场（useVoiceBroadcast 播放边沿镜像）→ 门开，同幅帧触发打断
    //（帧数取 5：t=300ms 首触发后落在 300ms 静默窗内——单次触发零二次，
    // 确定性断言不依赖占用自清——真机上 useVoiceBroadcast 挂载会随停播自清）
    beginNotificationPlayback();
    frames(5, 0.3);
    expect(sendStewardInterrupt).toHaveBeenCalledTimes(1);
    endNotificationPlayback();
  });
});
