// @vitest-environment jsdom
/**
 * useStewardVoice 关麦竞态回归测试（麦克风隐私：关麦后零活跃 track）。
 *
 * 报障现场：热键关掉管家（duplex 落、光球淡出）后，macOS 系统级麦克风占用
 * 指示仍亮——麦克风采集通道未随关麦释放。
 *
 * 根因（已修复）：useVoiceInput.start() 的取消守卫只在 `await getUserMedia`
 * 之前（useStewardVoice B2 注释自证：「beginListening 的 getUserMedia 窗口内
 * stateRef 仍 idle」）；cancelWake/cancel 在该窗口内执行时 recorderRef/
 * streamRef 尚未建立（cancel 全 no-op），getUserMedia resolve 后 start()
 * 不复检取消态——孤儿开麦（track 活跃、无人再停：duplex=false 后自动续听
 * effect 短路、光球已卸载无处点击、耳 meter 亦随 duplex 落关闭）。修复 =
 * useVoiceInput 取消代数（cancelGenRef）：cancel 递增代数，start 在
 * getUserMedia 迟归时凭代数失配即刻 track.stop 释放，零孤儿开麦。
 *
 * 两现场同根：
 * 1. 开麦窗口内再按热键（快速双击 toggle）；
 * 2. 双工自动续听窗口内按热键关麦（每轮说完回 idle 即开新麦——窗口常态暴露）。
 *
 * mock 面：SessionContext + FakeMediaRecorder + 可控 deferred getUserMedia
 *（wake/duplex.test 同构；resolve 时序手动 = 竞态窗口确定性打开；duplex 开启
 * 时耳 meter + 主录音两路并发挂起全放行——断言面 allTracksStopped 汇总）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** fake meter：onLevel 永不产帧 = VAD 静音自动停不可达（孤儿 track 无人停的现实面）。 */
const fakeCreateMeter = async () => ({
  onLevel: () => undefined,
  close: () => undefined,
});

function frame(type: string, payload: unknown, channel: string, sessionId = "__system__"): EventEnvelope {
  return { v: "0.14", sessionId, channel, type, payload } as EventEnvelope;
}

/**
 * 可控 deferred getUserMedia：getUserMedia 调用即挂起（resolveGum 手动放行）——
 * 竞态窗口确定性打开。注意 duplex 开启时有两路并发 getUserMedia（耳 meter
 * barge-in 采样 + 主录音链），每路独立 stream/track——放行放全部，断言面
 * allTracksStopped 汇总（关麦语义：duplex 落后零活跃 track）。
 */
interface DeferredEnv {
  trackStop: ReturnType<typeof vi.fn>;
  allTracksStopped: () => boolean;
  resolveGum: () => void;
  gumPending: () => boolean;
  restore: () => void;
}
function installDeferredEnv(): DeferredEnv {
  const origDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const masterStop = vi.fn();
  const pendings: { res: (s: MediaStream) => void; stop: ReturnType<typeof vi.fn> }[] = [];
  let batch: ReturnType<typeof vi.fn>[] = [];
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn(
        () =>
          new Promise<MediaStream>((res) => {
            const stop = vi.fn();
            pendings.push({ res, stop });
            batch.push(stop);
          }),
      ),
    },
    configurable: true,
  });
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  return {
    trackStop: masterStop,
    allTracksStopped: () => pendings.length === 0 && batch.every((s) => s.mock.calls.length > 0),
    resolveGum: () => {
      const all = pendings.splice(0);
      for (const p of all) p.res({ getTracks: () => [{ stop: p.stop }] } as unknown as MediaStream);
    },
    gumPending: () => pendings.length > 0,
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

function renderVoice(): HookResult {
  return renderHook(() => useStewardVoice({ createMeter: fakeCreateMeter }), {
    wrapper: I18nProvider,
  }).result;
}

describe("useStewardVoice 关麦竞态（getUserMedia 异步窗口孤儿开麦——麦克风隐私报障）", () => {
  let restoreEnv: (() => void) | null = null;

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
  });

  it("现场 1：开麦 getUserMedia 窗口内再按热键关麦 → resolve 后不得孤儿开麦（duplex 已落而麦仍开 = 报障）", async () => {
    const env = installDeferredEnv();
    restoreEnv = env.restore;
    const r = renderVoice();
    // 第一次热键：duplex 开启，beginListening 挂在 getUserMedia 窗口
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    expect(env.gumPending()).toBe(true); // 窗口已开（start() 挂起中）
    // 第二次热键：关麦收口（cancelWake——duplex 落、光球淡出）
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    expect(r.current.duplexActive).toBe(false); // 关麦已收口
    // getUserMedia 迟归（真实设备耗时/系统弹窗等）——此刻才放行（耳 meter +
    // 主录音两路并发挂起全放）
    await act(async () => {
      env.resolveGum();
    });
    await tick();
    // 期望正确行为：关麦后 getUserMedia 晚归不得开麦——孤儿 track = 麦克风
    // 指示常亮（无人停：duplex 落后自动续听短路、光球已卸载无处点击）。
    // 复现（红）：phase 实际 listening、放行 track 未被 stop。
    expect(r.current.phase).toBe("idle"); // 修复后：迟归麦不再孤儿开启
    expect(env.allTracksStopped()).toBe(true); // 修复后：迟归 track 即刻释放
  });

  it("现场 2：双工自动续听窗口内按热键关麦 → 同样不得孤儿开麦（每轮说完常态暴露的窗口）", async () => {
    const env = installDeferredEnv();
    restoreEnv = env.restore;
    const r = renderVoice();
    // 开启双工：第一轮 getUserMedia 手动放行 + started 回执
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    env.resolveGum(); // 第一轮开麦放行
    await tick();
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: "s1" }, "stt"));
    });
    expect(r.current.phase).toBe("listening");
    // 用户说完一轮（强制停 + 终帧 → ask → 回 idle）
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
      emit("stt", frame("stt.stream.final", { status: "ok", streamId: "s1", text: "帮我看下今天日程" }, "stt"));
    });
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    await tick();
    // ask 在途（phase=asking）→ 模拟 answer 终态收口 → 回 idle → 自动续听
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "今日三件事…" }, "steward"));
    });
    await tick();
    // 回 idle → 自动续听触发：新 getUserMedia 挂起（duplex 仍在）
    expect(env.gumPending()).toBe(true);
    // 热键关麦（恰在自动续听窗口内）
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    expect(r.current.duplexActive).toBe(false);
    // 自动续听的 getUserMedia 迟归（耳 meter 已随 duplex 落关闭，此处放行主录音链）
    await act(async () => {
      env.resolveGum();
    });
    await tick();
    // 期望正确行为同现场 1（复现红 = 报障实证）
    expect(r.current.phase).toBe("idle"); // 修复后：迟归麦不再孤儿开启
    expect(env.allTracksStopped()).toBe(true); // 修复后：迟归 track 即刻释放
  });
});

// ── 重入锁覆盖面（评审 useStewardVoice:1180）：并发开麦入口只开一次麦 ──
describe("听音重入锁覆盖全部 beginListening 入口", () => {
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    for (const s of Object.values(listeners)) s.clear();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    restoreEnv?.();
    restoreEnv = null;
  });

  it("并发 startListening（getUserMedia 窗口内二次入口）只开一次麦——锁内串行", async () => {
    const env = installDeferredEnv();
    restoreEnv = env.restore;
    const r = renderVoice();
    // 两个开麦入口同 tick 并发（手动开麦 + 打断/自动续听同构）：首路挂在
    // getUserMedia 窗口，次路必须被锁挡下（否则双开麦 = 双 getUserMedia）
    await act(async () => {
      void r.current.startListening();
      void r.current.startListening();
    });
    await tick();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    await act(async () => {
      env.resolveGum();
    });
    await tick();
  });

  it("源码定式：全部入口统一走 guardedBeginListening（无任何直调 beginListening 的入口）", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "useStewardVoice.ts"),
      "utf8",
    ).replace(/^\s*\/\/.*$/gm, "");
    // 仅锁包装体内一处 `await beginListening()`；其余入口（toggleWake/自动续听/
    // openBargeInIntentWindow/bargeIn/startListening）一律 guarded
    expect(src.match(/beginListening\(\)/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/void beginListening\(\)/);
    expect((src.match(/guardedBeginListening\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
