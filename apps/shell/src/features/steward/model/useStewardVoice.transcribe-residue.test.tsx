// @vitest-environment jsdom
/**
 * useStewardVoice 关麦后转写链残留回归测试（承接 close-race：麦克风释放后
 * 的数据/行为面残留）。
 *
 * 残留现场：双工对话中用户刚说完最后一句（VAD/强制停收口）→ blob 已交
 * `transcribeNow → uploadBlob → FileReader.readAsDataURL` → **此刻热键关麦**
 * → `cancel()` 置 idle + uploadInFlight=false → `FileReader.onload` 迟归
 * **无取消守卫**：照发 `sendSttTranscribe`（关麦后音频仍上行）+ 复活
 * `transcribing` 态 + `uploadInFlight=true` → 转写回执到达时 204 行守卫
 * （state==="transcribing" && uploadInFlight）**双双通过**（被复活）→
 * `onTranscript → handleTranscript`（入口无 duplex/会话门）→ **已关掉的
 * 管家突然开口念回答**（幽灵 ask + TTS）。
 *
 * 注：onstop 迟归路径被 `cancel()` 清空 chunksRef + onstop `blob.size===0`
 * 守卫双重堵死（单线程下 onstop 必在 cancel 后执行），非可达残留；本文件
 * 只测可达链（onload 迟归）。
 *
 * 修复 = 取消代数守卫族谱（4282f4ca 同根）：uploadBlob 以调用时代数捕获，
 * onload/onerror 迟归失配即弃（零上行零状态复活）。
 *
 * mock 面与 close-race 同构（SessionContext + FakeMediaRecorder + 可控
 * getUserMedia）；FileReader 另 stub 为挂起型（readAsDataURL 即挂起，测试
 * 手动放行 onload = 竞态窗口确定性打开）。
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

/** fake meter：永不产帧（VAD 不可达——用 stopListening 强制停驱动收口）。 */
const fakeCreateMeter = async () => ({
  onLevel: () => undefined,
  close: () => undefined,
});

function frame(type: string, payload: unknown, channel: string, sessionId = "__system__"): EventEnvelope {
  return { v: "0.14", sessionId, channel, type, payload } as EventEnvelope;
}

/** 立即放行的 getUserMedia（本场景开麦窗口不是竞态点）。 */
function installRecorder(): () => void {
  const origDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => fakeStream) },
    configurable: true,
  });
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  return () => {
    Object.defineProperty(navigator, "mediaDevices", { value: origDevices, configurable: true });
    if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
  };
}

/**
 * 挂起型 FileReader：readAsDataURL 即挂起（onload 由测试手动放行）——
 * 「转写在途关麦」窗口确定性打开。
 */
interface HeldReader {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  result: string | null;
  readAsDataURL(blob: Blob): void;
}
const heldReaders: HeldReader[] = [];
function installHeldFileReader(): () => void {
  const orig = globalThis.FileReader;
  class Fake {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result: string | null = "data:audio/webm;base64,QUJD";
    readAsDataURL(_blob: Blob): void {
      heldReaders.push(this as unknown as HeldReader);
    }
  }
  (globalThis as { FileReader: unknown }).FileReader = Fake;
  return () => {
    (globalThis as { FileReader: unknown }).FileReader = orig;
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

describe("useStewardVoice 关麦后转写链残留（FileReader.onload 迟归复活链）", () => {
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    heldReaders.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    restoreEnv?.();
    restoreEnv = null;
    heldReaders.length = 0;
  });

  it("现场：转写在途（readAsDataURL 挂起）时热键关麦 → onload 迟归不得上行/复活/幽灵 ask", async () => {
    const restoreRecorder = installRecorder();
    const restoreReader = installHeldFileReader();
    restoreEnv = () => {
      restoreReader();
      restoreRecorder();
    };
    const r = renderVoice();
    // 开启双工：放行开麦 + 流 started（streamId 就位，phase=listening）
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    expect(r.current.phase).toBe("listening");
    // 用户说完一句（强制停；+500ms 过 MIN_DURATION；不发 started 回执 → 流
    // 无 streamId → onDeferredHold 走 transcribeNow 回落链）
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
    // blob 已交 FileReader（挂起中 = 转写在途窗口打开）
    expect(heldReaders.length).toBe(1);
    // 热键关麦（cancelWake：duplex 落、voice.cancel 置 idle/uploadInFlight=false）
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    expect(r.current.duplexActive).toBe(false);
    // FileReader.onload 迟归（真实设备竞态点）——此刻才放行
    act(() => {
      heldReaders[0]!.onload?.();
    });
    await tick();
    // 期望正确行为：关麦后零上行（音频不离机）、零状态复活、零幽灵 ask。
    // 复现（红）：sendSttTranscribe 被调 + voiceState 复活 transcribing；
    // 回执到达时守卫被复活值绕过 → handleTranscript → 幽灵 ask。
    expect(sendSttTranscribe).not.toHaveBeenCalled(); // 修复后：迟归 onload 零上行
    expect(r.current.phase).toBe("idle"); // 修复后：不复活转写态（phase 由 voiceState 推导）
    expect(sendStewardAsk).not.toHaveBeenCalled(); // 修复后：零幽灵 ask
    // 纵深加强：即便守卫面全失守，回执到达也不得触发幽灵 ask（门兜底）
    act(() => {
      emit("stt", frame("stt.transcribe.result", { status: "ok", text: "帮我看下今天日程" }, "stt"));
    });
    await tick();
    expect(sendStewardAsk).not.toHaveBeenCalled();
  });
});
