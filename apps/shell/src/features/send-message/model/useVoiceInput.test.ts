// @vitest-environment jsdom
/**
 * useVoiceInput 状态机测试（语音输入 V2：点击开始 / VAD 静音自动停 / 点击
 * 强制停；录音 mock 路径——MediaRecorder/getUserMedia/RMS meter 全 stub，
 * 零真机依赖）。
 *
 * - unsupported：无 navigator.mediaDevices → 初始态 unsupported、start() no-op；
 * - 点击开始：start() → recording（getUserMedia + mime 选择序 + meter 挂载）；
 * - VAD 自动停（开口后静音 ≥ VOICE_SILENCE_STOP_MS）：auto-stop → 正常转写
 *   链（blob → dataURL → sendSttTranscribe），meter 关闭；
 * - VAD 丢弃（全程未开口）：auto-stop → idle、零转写零计费、零 error；
 * - 点击强制停：recording 态 stop() → 转写链（不看 spoke——显式意图权威）；
 * - 过短录音（<VOICE_MIN_DURATION_MS）不发送（防误触计费）；
 * - 转写中互斥：transcribing 态 start() no-op（不二次 getUserMedia）；
 * - level 暴露：meter 帧驱动（loud 帧 ≥ 阈值抬升、静音帧衰减）；
 * - 回执 ok → onTranscript；回执 error → error 态；send false → idle + error。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendSttTranscribe = vi.fn(() => true);
let frameListener: ((e: EventEnvelope) => void) | null = null;
const subscribeSttFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  frameListener = cb;
  return () => {
    frameListener = null;
  };
});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({ sendSttTranscribe, subscribeSttFrames }),
}));

vi.mock("@/shared/lib/stt-provider-pref", () => ({
  readSttProviderPref: () => undefined,
}));

import { useVoiceInput, VOICE_MIN_DURATION_MS, VOICE_SILENCE_STOP_MS, VOICE_LEAD_IN_MS } from "./useVoiceInput";
import type { RmsMeter } from "./rms-meter";

/** fake MediaRecorder（jsdom 无实现——start/stop/ondataavailable/onstop 时序 stub）。 */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    private readonly stream: MediaStream,
    private readonly opts?: MediaRecorderOptions,
  ) {
    if (opts?.mimeType !== undefined) this.mimeType = opts.mimeType;
    FakeMediaRecorder.instances.push(this);
  }
  static isTypeSupported(mime: string): boolean {
    return mime === "audio/webm;codecs=opus" || mime === "audio/webm" || mime === "audio/mp4";
  }
  start(): void {
    // 5ms 后产一片（模拟分片；测试快进不等真实时间——stop 前手动产片）
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    }, 5);
  }
  stop(): void {
    this.onstop?.();
  }
}

/** fake RMS meter（VAD 帧注入面：emit(rms) 模拟 worklet/Analyser 帧回调）。 */
function makeFakeMeter(): RmsMeter & { emit: (rms: number) => void } {
  let cb: ((rms: number) => void) | null = null;
  return {
    onLevel: (fn: (rms: number) => void) => {
      cb = fn;
    },
    close: vi.fn(),
    emit: (rms: number) => cb?.(rms),
  };
}

/** 安装录音环境（mediaDevices + MediaRecorder），返回还原函数。 */
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

/** 可控时钟（VAD 静音窗推进不依赖真实等待；finally 还原）。 */
function useFakeClock(): { advance: (ms: number) => void; now: () => number; restore: () => void } {
  let nowMs = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    restore: () => spy.mockRestore(),
  };
}

/** 真实等待一拍（FakeMediaRecorder 分片 5ms 后落地——转写链前置）。 */
async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
}

describe("useVoiceInput（语音输入 V2：点击 + VAD）", () => {
  const origMediaDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  let clockRestore: (() => void) | null = null;

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    frameListener = null;
    FakeMediaRecorder.instances = [];
    clockRestore?.();
    clockRestore = null;
    Object.defineProperty(navigator, "mediaDevices", { value: origMediaDevices, configurable: true });
    if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
  });

  it("unsupported：无 mediaDevices → 初始态 unsupported、start() no-op 不抛错", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript), { wrapper: I18nProvider });
    expect(result.current.state).toBe("unsupported");
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("unsupported");
    expect(sendSttTranscribe).not.toHaveBeenCalled();
  });

  it("点击开始 → recording（getUserMedia + mime 首选 + meter 挂载 + level 初值 0）", async () => {
    const restore = installRecorder();
    const meter = makeFakeMeter();
    const factory = vi.fn(() => Promise.resolve(meter));
    const { result } = renderHook(() => useVoiceInput(vi.fn(), { createMeter: factory }), {
      wrapper: I18nProvider,
    });
    expect(result.current.state).toBe("idle");
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    expect(FakeMediaRecorder.instances.length).toBe(1);
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe("audio/webm;codecs=opus");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.current.level).toBe(0);
    restore();
  });

  it("VAD 自动停（开口后静音 ≥ SILENCE_STOP）：转写链正常发出 + meter 关闭", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const meter = makeFakeMeter();
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { createMeter: () => Promise.resolve(meter) }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");

    // 开口帧（超阈值）→ spoke + lastLoud 更新；等分片落地（转写链前置）
    await act(async () => {
      meter.emit(0.2);
    });
    await tick();
    // 静音窗越过 LEAD_IN + SILENCE_STOP（基点 = max(开始+LEAD_IN, lastLoud)）
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200);
    await act(async () => {
      meter.emit(0.001);
    });
    expect(result.current.state).toBe("transcribing");
    expect(meter.close).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(sendSttTranscribe).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    const [audioArg, optsArg] = sendSttTranscribe.mock.calls[0] as unknown as [string, { language?: string }];
    expect(audioArg.startsWith("data:audio/webm;codecs=opus;base64,")).toBe(true);
    expect(optsArg.language).toBe("zh");
    restore();
  });

  it("VAD 丢弃（全程未开口）：auto-stop → idle、零转写零计费、零 error", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const meter = makeFakeMeter();
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { createMeter: () => Promise.resolve(meter) }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    // 全程静音帧（低于阈值）——推进越过 lead-in + silence 窗
    clock.advance(VOICE_MIN_DURATION_MS);
    await act(async () => {
      meter.emit(0.001);
    });
    clock.advance(VOICE_SILENCE_STOP_MS + 5_000);
    await act(async () => {
      meter.emit(0.0005);
    });
    expect(result.current.state).toBe("idle");
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(meter.close).toHaveBeenCalledTimes(1);
    restore();
  });

  it("点击强制停：recording 态 stop() → 转写链（显式意图不看 spoke）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const meter = makeFakeMeter();
    const onTranscript = vi.fn();
    const { result } = renderHook(
      () => useVoiceInput(onTranscript, { createMeter: () => Promise.resolve(meter) }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    await tick();
    // 刚开口一帧即强制停（未过静音窗——stop 是点击路径非 VAD 路径）
    await act(async () => {
      meter.emit(0.15);
    });
    clock.advance(VOICE_MIN_DURATION_MS + 100);
    await act(async () => {
      meter.emit(0.15); // 仍在说话（静音窗未满足）
    });
    act(() => {
      result.current.stop();
    });
    await waitFor(() => {
      expect(sendSttTranscribe).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    expect(result.current.state).toBe("transcribing");
    // 回执 ok → idle + 回填
    act(() => {
      frameListener!({
        v: "0.13",
        type: "stt.transcribe.result",
        payload: { status: "ok", text: "把 useEffect 修一下", provider: "dashscope" },
      } as EventEnvelope);
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(onTranscript).toHaveBeenCalledWith("把 useEffect 修一下");
    restore();
  });

  it("过短强制停（< MIN_DURATION）不发送（防误触计费）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const { result } = renderHook(() => useVoiceInput(vi.fn()), { wrapper: I18nProvider });
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.stop(); // 时钟未推进 → duration 0
    });
    expect(result.current.state).toBe("idle");
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    restore();
  });

  it("转写中互斥：transcribing 态 start() no-op（不二次 getUserMedia）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const { result } = renderHook(() => useVoiceInput(vi.fn()), { wrapper: I18nProvider });
    await act(async () => {
      await result.current.start();
    });
    await tick();
    clock.advance(VOICE_MIN_DURATION_MS + 100);
    act(() => {
      result.current.stop();
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(result.current.state).toBe("transcribing");
    const instancesBefore = FakeMediaRecorder.instances.length;
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("transcribing");
    expect(FakeMediaRecorder.instances.length).toBe(instancesBefore);
    restore();
  });

  it("level 暴露：loud 帧抬升、静音帧衰减（电平反馈面）", async () => {
    const restore = installRecorder();
    const meter = makeFakeMeter();
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { createMeter: () => Promise.resolve(meter) }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      meter.emit(0.3);
    });
    expect(result.current.level).toBeGreaterThan(0.1);
    const peak = result.current.level;
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        meter.emit(0.001);
      });
    }
    expect(result.current.level).toBeLessThan(peak);
    expect(result.current.level).toBeLessThan(0.1);
    restore();
  });

  it("回执 error 判别 → idle + error 交代（key 未配引导）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const { result } = renderHook(() => useVoiceInput(vi.fn()), { wrapper: I18nProvider });
    await act(async () => {
      await result.current.start();
    });
    await tick();
    clock.advance(VOICE_MIN_DURATION_MS + 100);
    act(() => {
      result.current.stop();
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    act(() => {
      frameListener!({
        v: "0.13",
        type: "stt.transcribe.result",
        payload: { status: "error", reason: 'provider "dashscope" 未录入 API key' },
      } as EventEnvelope);
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toContain("API key");
    restore();
  });

  it("sendSttTranscribe 返回 false（未连接）→ idle + error，不进入 transcribing", async () => {
    sendSttTranscribe.mockReturnValueOnce(false);
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const { result } = renderHook(() => useVoiceInput(vi.fn()), { wrapper: I18nProvider });
    await act(async () => {
      await result.current.start();
    });
    await tick();
    clock.advance(VOICE_MIN_DURATION_MS + 100);
    act(() => {
      result.current.stop();
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).not.toBeNull(); // sendFail 词条
    restore();
  });
});
