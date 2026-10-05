// @vitest-environment jsdom
/**
 * useComposerVoice 流式接线测试（Composer 实时识别批；TDD 红→绿）。
 *
 * 链路集成点（brief 测试要求）：
 * - 流式闭环：start 开流（stt.stream.start zh）→ started ok → PCM 帧
 *   chunk 上行 → interim 上屏（prior+text+stash）→ stop → finish →
 *   final ok → onTranscript 恰一次（final 文本）+ interim 清空 +
 *   零 stt.transcribe 上传（单转写零双计费）；
 * - 单飞门控：他流 interim（streamId 不匹配）不上屏；
 * - 回落链（V3a 行为等价）：开流失败 started.error / final error /
 *   终帧超时 → 停后 blob 走 stt.transcribe，结果等价喂 onTranscript；
 * - provider 偏好非 dashscope（无流式能力）→ 不开流（money 纪律）；
 * - 出态清理：final 空文本丢弃（零 onTranscript）；idle 后 interim 不残留；
 * - 卸载废流：recording 在途卸载 → stt.stream.stop（零孤儿连接）。
 *
 * mock 面：SessionContext（stt 命令与订阅）+ FakeMediaRecorder
 * （useStewardVoice.test 同款）+ fake PCM 泵（帧注入面）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendSttTranscribe = vi.fn(() => true);
const sendSttStreamChunk = vi.fn(() => true);
const sendSttStreamFinish = vi.fn(() => true);
const sendSttStreamStop = vi.fn(() => true);

// 开流开关：false = 开流不可达（既有 V3a 回落回归不受串扰）
let streamStartEnabled = false;
const sendSttStreamStart = vi.fn(() => streamStartEnabled);

// provider 偏好注入面（缺省 undefined = auto）
let sttProviderPref: string | undefined = undefined;

const listeners = { stt: new Set<(e: EventEnvelope) => void>() };
function emit(e: EventEnvelope): void {
  for (const l of listeners.stt!) l(e);
}
const subscribeSttFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  listeners.stt.add(cb);
  return () => {
    listeners.stt.delete(cb);
  };
});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    sendSttTranscribe,
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamFinish,
    sendSttStreamStop,
    subscribeSttFrames,
  }),
}));

vi.mock("@/shared/lib/stt-provider-pref", () => ({
  readSttProviderPref: () => sttProviderPref,
}));

import { useComposerVoice } from "./useComposerVoice";

/** FakeMediaRecorder（useStewardVoice.test 同款时序 stub）。 */
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

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "stt", type, payload } as EventEnvelope;
}

/** 安装录音环境，返回还原函数。 */
function installEnv(): () => void {
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

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
}

describe("useComposerVoice（Composer 流式实时识别接线）", () => {
  const onTranscript = vi.fn();
  let restoreEnv: (() => void) | null = null;
  /** fake PCM 泵（帧注入面）。 */
  let pumpCb: ((frame: ArrayBuffer) => void) | null = null;
  const pump = {
    onFrame: (cb: (frame: ArrayBuffer) => void) => {
      pumpCb = cb;
    },
    close: vi.fn(),
  };
  const createPump = () => Promise.resolve(pump);

  function renderVoice(opts?: { streamFinalTimeoutMs?: number }) {
    return renderHook(() => useComposerVoice(onTranscript, { createPump, ...opts }), {
      wrapper: I18nProvider,
    });
  }

  /** 走到「开流就绪 + 录音中」（含 fake clock）。 */
  async function startStream(result: { current: ReturnType<typeof useComposerVoice> }): Promise<void> {
    await act(async () => {
      await result.current.start();
    });
    await tick();
    act(() => {
      emit(frame("stt.stream.started", { status: "ok", streamId: "str-1", provider: "dashscope" }));
    });
  }

  beforeEach(() => {
    localStorage.clear();
    listeners.stt.clear();
    pumpCb = null;
    streamStartEnabled = false;
    sttProviderPref = undefined;
    FakeMediaRecorder.instances = [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    restoreEnv?.();
    restoreEnv = null;
  });

  it("流式闭环：start 开流（zh）→ PCM 块上行 → interim 上屏 → stop → finish → final 喂 onTranscript（单次、零非流式上传）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderVoice().result;
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.start();
    });
    await tick();
    expect(sendSttStreamStart).toHaveBeenCalledTimes(1);
    expect((sendSttStreamStart.mock.calls as unknown as [{ language?: string }][])[0]?.[0]).toEqual({ language: "zh" });
    act(() => {
      emit(frame("stt.stream.started", { status: "ok", streamId: "str-1", provider: "dashscope" }));
    });
    // PCM 帧 → chunk 上行（base64 PCM）
    act(() => {
      pumpCb?.(new Uint8Array([1, 2, 3, 4]).buffer);
    });
    expect(sendSttStreamChunk).toHaveBeenCalledTimes(1);
    expect(typeof (sendSttStreamChunk.mock.calls as unknown as [string][])[0]?.[0]).toBe("string");
    // interim 上屏（prior+text+stash 拼接）
    act(() => {
      emit(frame("stt.stream.interim", { streamId: "str-1", prior: "", text: "帮我把", stash: "语音" }));
    });
    expect(r.current.interim).toBe("帮我把语音");
    expect(r.current.state).toBe("recording");
    // 强制停 → finish → final → onTranscript 恰一次（零 stt.transcribe 上传——单转写）
    nowMs += 500;
    act(() => {
      r.current.stop();
    });
    expect(sendSttStreamFinish).toHaveBeenCalledTimes(1);
    const before = onTranscript.mock.calls.length;
    act(() => {
      emit(frame("stt.stream.final", { status: "ok", streamId: "str-1", text: "帮我把语音输入接入", provider: "dashscope" }));
    });
    spy.mockRestore();
    await waitFor(() => expect(onTranscript.mock.calls.length).toBe(before + 1), { timeout: 2000 });
    expect((onTranscript.mock.calls as unknown as [string][])[onTranscript.mock.calls.length - 1]?.[0]).toBe("帮我把语音输入接入");
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    await waitFor(() => expect(r.current.interim).toBeNull()); // 出态清浮字
  });

  it("单飞门控：他流 interim（streamId 不匹配）不上屏不串台", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderVoice().result;
    await startStream(r);
    act(() => {
      emit(frame("stt.stream.interim", { streamId: "str-OTHER", prior: "", text: "他面浮字", stash: "" }));
    });
    expect(r.current.interim).toBeNull();
  });

  it("开流失败（started error）→ 静默降级：停后 blob 回落非流式，结果等价喂 onTranscript", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderVoice().result;
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.start();
    });
    await tick();
    act(() => {
      emit(frame("stt.stream.started", { status: "error", reason: "key 未配" }));
    });
    nowMs += 500;
    act(() => {
      r.current.stop();
    });
    spy.mockRestore();
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 }); // 回落上传
    expect(sendSttStreamFinish).not.toHaveBeenCalled(); // 死流不发 finish
    const before = onTranscript.mock.calls.length;
    act(() => {
      emit(frame("stt.transcribe.result", { status: "ok", text: "回落转写等价文本", provider: "dashscope" }));
    });
    await waitFor(() => expect(onTranscript.mock.calls.length).toBe(before + 1), { timeout: 2000 });
    expect((onTranscript.mock.calls as unknown as [string][])[onTranscript.mock.calls.length - 1]?.[0]).toBe("回落转写等价文本");
  });

  it("final error → 回落非流式（blob 整段转写等价收口）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderVoice().result;
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await startStream(r);
    nowMs += 500;
    act(() => {
      r.current.stop();
    });
    expect(sendSttStreamFinish).toHaveBeenCalledTimes(1);
    act(() => {
      emit(frame("stt.stream.final", { status: "error", streamId: "str-1", reason: "上游连接断开" }));
    });
    spy.mockRestore();
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    act(() => {
      emit(frame("stt.transcribe.result", { status: "ok", text: "final 失败后的等价文本", provider: "dashscope" }));
    });
    await waitFor(
      () =>
        expect((onTranscript.mock.calls as unknown as [string][])[onTranscript.mock.calls.length - 1]?.[0]).toBe("final 失败后的等价文本"),
      { timeout: 2000 },
    );
  });

  it("终帧超时 → 回落非流式（短超时注入）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderVoice({ streamFinalTimeoutMs: 5 }).result;
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await startStream(r);
    nowMs += 500;
    act(() => {
      r.current.stop();
    });
    expect(sendSttStreamFinish).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 }); // 超时回落上传
    act(() => {
      emit(frame("stt.transcribe.result", { status: "ok", text: "超时回落等价文本", provider: "dashscope" }));
    });
    await waitFor(
      () =>
        expect((onTranscript.mock.calls as unknown as [string][])[onTranscript.mock.calls.length - 1]?.[0]).toBe("超时回落等价文本"),
      { timeout: 2000 },
    );
  });

  it("provider 偏好非 dashscope（siliconflow 无流式能力）→ 不开流，停后直接上传", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    sttProviderPref = "siliconflow";
    const r = renderVoice().result;
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.start();
    });
    await tick();
    expect(sendSttStreamStart).not.toHaveBeenCalled(); // money 纪律：零连接
    nowMs += 500;
    act(() => {
      r.current.stop();
    });
    spy.mockRestore();
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("final 空文本 → 丢弃（零 onTranscript），interim 不残留", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderVoice().result;
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await startStream(r);
    act(() => {
      emit(frame("stt.stream.interim", { streamId: "str-1", prior: "", text: "嗯", stash: "" }));
    });
    expect(r.current.interim).toBe("嗯");
    nowMs += 500;
    act(() => {
      r.current.stop();
    });
    const before = onTranscript.mock.calls.length;
    act(() => {
      emit(frame("stt.stream.final", { status: "ok", streamId: "str-1", text: "  ", provider: "dashscope" }));
    });
    spy.mockRestore();
    await waitFor(() => expect(r.current.state).toBe("idle"), { timeout: 2000 });
    expect(onTranscript.mock.calls.length).toBe(before); // 空白丢弃
    await waitFor(() => expect(r.current.interim).toBeNull());
  });

  it("卸载废流：recording 在途卸载 → stt.stream.stop（零孤儿连接）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const hook = renderVoice();
    await startStream(hook.result);
    expect(hook.result.current.state).toBe("recording");
    act(() => {
      hook.unmount();
    });
    expect(sendSttStreamStop).toHaveBeenCalledTimes(1);
  });
});
