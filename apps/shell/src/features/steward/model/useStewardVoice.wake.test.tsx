// @vitest-environment jsdom
/**
 * useStewardVoice 唤醒链集成测试（B4 全局组合键手动开麦；B2-hotfix 语义
 * 修订：热键直通双工——唤醒词门槛退役出热键会话；TDD 红→绿）。
 *
 * 链路集成点（brief 测试要求）:
 * - 组合键 → 直通双工 listening（wakeState off——无待命态、无唤醒词门槛）:
 *   开麦 + 流式开流（stt.stream.start）；唤醒词偏好非空（默认 "helix"）也
 *   直通（B2-hotfix 回归钉子——热键是显式手势，门槛仅属未来被动监听场景);
 * - 说任意话（不含唤醒词）→ 终帧全文进 ask（既有 ask 链——修复「说完零
 *   回应 + 待命 30s 超时光球消失」报障）；
 * - 无待命超时收场：短窗注入后 duplex 会话不因超时消失（待命超时机制随
 *   门槛退役出热键路径）；
 * - 手动退出关麦：Esc / 组合键再按 = duplex 收口关麦（track.stop 断言）;
 * - 面板关闭即关麦（麦克风生命周期纪律）：duplex 会话随面板关闭取消收场。
 *
 * 机制面（wakeSession 结构/matchWakeWord/deriveOrbPhase wake_armed 分支）
 * 保留待未来「被动监听唤起」批复用——纯函数面测试不动（machine.test）。
 *
 * mock 面：SessionContext（同 useStewardVoice.test）+ FakeMediaRecorder +
 * wake-hotkey 注册面（fire handler 捕获 = 全局组合键触发模拟）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor, fireEvent } from "@testing-library/react";
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

// ── 全局组合键注册面 mock（fire handler 捕获 = 壳侧全局快捷键触发模拟）──
let fireWakeHotkey: (() => void) | null = null;
const syncWakeHotkeyRegistration = vi.fn(
  async (_opts?: unknown): Promise<"ok" | "failed" | "unavailable"> => "ok",
);
vi.mock("@/shared/lib/wake-hotkey", () => ({
  setWakeHotkeyFireHandler: (h: (() => void) | null) => {
    fireWakeHotkey = h;
  },
  // 惰性包装（vi.mock 工厂提升：顶层 const 不得在工厂求值期解引用）
  syncWakeHotkeyRegistration: (opts?: unknown) => syncWakeHotkeyRegistration(opts),
}));

import { useStewardVoice } from "./useStewardVoice";

/** FakeMediaRecorder（useVoiceInput.test 同款时序 stub）。 */
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

/** fake meter（非 null = 计量可用：耳/录音双挂载不走降级 track.stop 路径，
 *  track.stop 断言面只反映收场链路——jsdom 无音频设备，createMeter 注入）。 */
const fakeCreateMeter = async () => ({
  onLevel: () => undefined,
  close: () => undefined,
});

function frame(type: string, payload: unknown, channel: string, sessionId = "__system__"): EventEnvelope {
  return { v: "0.14", sessionId, channel, type, payload } as EventEnvelope;
}

/** 安装录音环境；返回 { trackStop, restore }（track.stop = ed508171 关麦断言面）。 */
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

function renderVoice(options?: { readonly wakeTimeoutMs?: number }): HookResult {
  // 返回 result ref（r.current = 钩子面）——renderHook 返回值解构常见坑钉死；
  // B2：open 参数退役（耳面采样门改 duplex 会话活跃——面板语音已随 B2 退役）
  return renderHook(() => useStewardVoice({ createMeter: fakeCreateMeter, ...options }), {
    wrapper: I18nProvider,
  }).result;
}

/** 全局组合键触发（壳侧 onFire → 注册面 → 钩子 toggleWake 模拟）+ 开流回执。 */
async function pressHotkey(): Promise<void> {
  await act(async () => {
    fireWakeHotkey?.();
  });
  await tick(); // beginListening 异步（getUserMedia + MediaRecorder + 开流）
  act(() => {
    emit("stt", frame("stt.stream.started", { status: "ok", streamId: "s1" }, "stt"));
  });
}

/** 过最短录音窗 + 强制停 + 终帧（useVoiceInput.test speakOnce 同款时钟手法）。 */
async function finishRound(r: HookResult, finalText: string): Promise<void> {
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
    emit("stt", frame("stt.stream.final", { status: "ok", streamId: "s1", text: finalText }, "stt"));
  });
}

describe("useStewardVoice 唤醒链（B4 组合键 → B2-hotfix 直通双工）", () => {
  let restoreEnv: (() => void) | null = null;
  let trackStop: ReturnType<typeof vi.fn> | null = null;

  beforeEach(() => {
    localStorage.clear();
    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    restoreEnv?.();
    restoreEnv = null;
    trackStop = null;
  });

  it("组合键 → 直通双工 listening（无待命态零门槛）：开麦 + 流式开流；再按组合键 = 关麦收口（track.stop + 废流）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    trackStop = env.trackStop;
    const r = renderVoice();
    await pressHotkey();
    // 直通：无待命会话（wakeState off）、相位即 listening、双工活跃
    expect(r.current.wakeState).toBe("off");
    expect(r.current.phase).toBe("listening");
    expect(r.current.duplexActive).toBe(true);
    expect(sendSttStreamStart).toHaveBeenCalledTimes(1);
    expect(trackStop).not.toHaveBeenCalled();
    // 再按组合键 = 关麦收口（toggle，D2 单键）
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    expect(r.current.wakeState).toBe("off");
    expect(r.current.phase).toBe("idle");
    expect(r.current.duplexActive).toBe(false);
    expect(trackStop).toHaveBeenCalled();
    expect(sendSttStreamStop).toHaveBeenCalled();
  });

  it("回归钉子（B2-hotfix 报障修复）：唤醒词默认非空（helix）也直通——说任意话（不含唤醒词）→ 终帧全文进 ask", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    const r = renderVoice();
    // 不设 wakeWord 偏好：readWakeWordPref 缺省 "helix"（非空）——旧语义下
    // 此配置 = 待命态等词（报障现场：说完零回应 + 30s 超时光球消失）
    await pressHotkey();
    expect(r.current.phase).toBe("listening"); // 直通待听（非 wake_armed）
    await finishRound(r, "今天有什么任务在跑");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    expect(sendStewardAsk).toHaveBeenCalledWith("今天有什么任务在跑");
    // 会话仍在（无超时收场）
    expect(r.current.duplexActive).toBe(true);
  });

  it("无待命超时收场（短窗注入后 duplex 不因超时消失）：修复「说完话等 30s 光球自灭」路径", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    trackStop = env.trackStop;
    const r = renderVoice({ wakeTimeoutMs: 50 });
    await pressHotkey();
    expect(r.current.phase).toBe("listening");
    // 短窗 50ms × 4 倍余量：直通会话无超时计时器（旧语义待命超时收场）
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(r.current.duplexActive).toBe(true);
    expect(trackStop).not.toHaveBeenCalled();
  });

  it("Esc 在 duplex 期 = 关麦收口（track.stop 断言；直通后 Esc 面向双工会话）", async () => {
    const env = installEnv();
    restoreEnv = env.restore;
    trackStop = env.trackStop;
    const r = renderVoice();
    await pressHotkey();
    expect(r.current.phase).toBe("listening");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(r.current.wakeState).toBe("off");
    expect(r.current.duplexActive).toBe(false);
    expect(trackStop).toHaveBeenCalled();
  });

  // B2「面板关闭即关麦」随 open 参数退役：duplex 会话收口（关麦/超时/Esc）
  // 共径 cancelWake 已在 useStewardVoice.duplex.test 钉（track.stop 断言面）。
});
