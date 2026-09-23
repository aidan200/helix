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
    localStorage.setItem("helix.steward.wakeWord", ""); // 空串直通：组合键即入 listening
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
    localStorage.setItem("helix.steward.wakeWord", "helix"); // 唤醒词在也直通（热键=显式手势）
    const r = renderVoice({ createMeter: fakeCreateMeter, createPlayer, wakeTimeoutMs: 50 });
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
