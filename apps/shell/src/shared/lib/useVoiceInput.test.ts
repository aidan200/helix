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
 * - 回执 ok → onTranscript；回执 error → error 态；send false → idle + error；
 * - 单飞门控（V3a）：idle 态吞外来回执（两消费面并存防串台）。
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

/** DI 面（V3a 下移 shared：session 命令/订阅注入——与消费方 Composer/StewardDock 同形）。 */
const deps = { sendSttTranscribe, subscribeSttFrames };

vi.mock("@/shared/lib/stt-provider-pref", () => ({
  readSttProviderPref: () => undefined,
}));

import { useVoiceInput, VOICE_MIN_DURATION_MS, VOICE_SILENCE_STOP_MS, VOICE_LEAD_IN_MS, VOICE_SPEECH_MIN_MS, VOICE_SPEAKING_HOLD_MS } from "./useVoiceInput";
import {
  VOICE_VAD_SENSITIVITY_PREF_KEY,
  VOICE_VOICE_CHECK_PREF_KEY,
  voiceRmsThresholdFromSensitivity,
} from "./voice-pref";
import type { MeterFrame, RmsMeter } from "./rms-meter";
import { beginSpeechLease, endSpeechLease, resetSpeechMutexForTest } from "./speech-mutex";

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

/** fake RMS meter（VAD 帧注入面：emit(rms, zcr) 模拟 worklet/Analyser 帧回调；
 *  B3 帧载荷扩 ZCR——缺省 0.1 人声带内值（存量 VAD 时序断言行为不变；
 *  带外帧用例显式传第二参）。 */
function makeFakeMeter(): RmsMeter & { emit: (rms: number, zcr?: number) => void } {
  let cb: ((frame: MeterFrame) => void) | null = null;
  return {
    onLevel: (fn: (frame: MeterFrame) => void) => {
      cb = fn;
    },
    close: vi.fn(),
    emit: (rms: number, zcr = 0.1) => cb?.({ rms, zcr }),
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
    const { result } = renderHook(() => useVoiceInput(onTranscript, deps), { wrapper: I18nProvider });
    expect(result.current.state).toBe("unsupported");
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("unsupported");
    expect(sendSttTranscribe).not.toHaveBeenCalled();
  });

  it("点击开始 → recording（getUserMedia + mime 首选 + meter 挂载 + level 初值 0）", async () => {
    const restore = installRecorder();    const meter = makeFakeMeter();
    const factory = vi.fn(() => Promise.resolve(meter));
    const { result } = renderHook(() => useVoiceInput(vi.fn(), { ...deps, createMeter: factory }), {
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
      () => useVoiceInput(vi.fn(), { ...deps, createMeter: () => Promise.resolve(meter) }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");

    // 开口帧（超阈值 ×4 帧，帧间 100ms——累计 400ms ≥ VOICE_SPEECH_MIN_MS
    // 有效发声闸内；spoke + lastLoud 更新）；等分片落地（转写链前置）
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        meter.emit(0.2);
      });
      clock.advance(100);
    }
    await tick();
    // 静音窗越过 LEAD_IN + SILENCE_STOP（基点 = max(开始+LEAD_IN, lastLoud)）
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200 - 400);
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

  it("VAD 自动停走最新 stop 闭包（sendSttTranscribe 引用漂移后不悬挂在旧命令面——中危 F3a）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const meter = makeFakeMeter();
    const sendV1 = vi.fn(() => true);
    const sendV2 = vi.fn(() => true);
    const initial = { sendSttTranscribe: sendV1, subscribeSttFrames };
    const { result, rerender } = renderHook(
      (p: typeof initial) => useVoiceInput(vi.fn(), { ...p, createMeter: () => Promise.resolve(meter) }),
      { wrapper: I18nProvider, initialProps: initial },
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    // 命令面引用漂移（重连换面等）：重渲染换 sendSttTranscribe——start 闭包
    // 不随重刷，VAD 自动停必须走最新 stop（旧实现走旧 sendV1）
    rerender({ sendSttTranscribe: sendV2, subscribeSttFrames });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        meter.emit(0.2);
      });
      clock.advance(100);
    }
    await tick();
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200 - 400);
    await act(async () => {
      meter.emit(0.001);
    });
    expect(result.current.state).toBe("transcribing");
    await waitFor(() => {
      expect(sendV2).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    expect(sendV1).not.toHaveBeenCalled();
    restore();
  });

  it("VAD 丢弃（全程未开口）：auto-stop → idle、零转写零计费、零 error", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const meter = makeFakeMeter();
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { ...deps, createMeter: () => Promise.resolve(meter) }),
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
      () => useVoiceInput(onTranscript, { ...deps, createMeter: () => Promise.resolve(meter) }),
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
        v: "0.14",
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
    const { result } = renderHook(() => useVoiceInput(vi.fn(), deps), { wrapper: I18nProvider });
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

  it("stop→onstop 在途窗口二次 stop 不清 chunks（VAD 自动停与手动停相撞不丢整段录音）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const { result } = renderHook(() => useVoiceInput(vi.fn(), deps), { wrapper: I18nProvider });
    await act(async () => {
      await result.current.start();
    });
    clock.advance(VOICE_MIN_DURATION_MS + 100);
    await tick(); // 分片落地（在途 chunks 已入篮）
    // 在途化 onstop：接管 fake recorder.stop，不立即回调（模拟 stop→onstop 异步窗口）
    const rec = FakeMediaRecorder.instances[0]!;
    let deferredOnstop: (() => void) | null = null;
    rec.stop = () => {
      deferredOnstop = rec.onstop;
    };
    act(() => {
      result.current.stop(); // 首次停（收口链在途）
    });
    expect(result.current.state).toBe("transcribing");
    act(() => {
      result.current.stop(); // 窗口内二次停（VAD 自动停/连点）：不得清 chunks
    });
    await act(async () => {
      deferredOnstop?.();
    });
    await waitFor(() => {
      expect(sendSttTranscribe).toHaveBeenCalledTimes(1); // 录音未被静默丢弃
    }, { timeout: 2000 });
    restore();
  });

  it("卸载落 getUserMedia 在途窗口：迟归 stream 即刻释放零续行（不建 recorder 不开麦）", async () => {
    // TR-215 回归钉子（漏网通路）：unmount/StrictMode 重挂落在 getUserMedia
    // 在途窗口时，迟归 stream 必须凭取消代数失配即刻释放——否则续行创建
    // MediaRecorder 开麦且卸载后无人再释放（孤儿开麦/麦克风指示常亮）。
    let resolveGum: (s: MediaStream) => void = () => undefined;
    const track = { stop: vi.fn() };
    const fakeStream = { getTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveGum = resolve;
            }),
        ),
      },
      configurable: true,
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const { result, unmount } = renderHook(() => useVoiceInput(vi.fn(), deps), { wrapper: I18nProvider });
    act(() => {
      void result.current.start(); // 领当代 → 进入 await getUserMedia 在途窗口
    });
    unmount(); // 卸载落窗口内（修复前：不递增代数，迟归必续行）
    await act(async () => {
      resolveGum(fakeStream);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(FakeMediaRecorder.instances.length).toBe(0); // 零续行：不建 recorder
    expect(track.stop).toHaveBeenCalled(); // 迟归 stream 同步释放（零孤儿开麦）
  });

  it("转写中互斥：transcribing 态 start() no-op（不二次 getUserMedia）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const { result } = renderHook(() => useVoiceInput(vi.fn(), deps), { wrapper: I18nProvider });
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
      () => useVoiceInput(vi.fn(), { ...deps, createMeter: () => Promise.resolve(meter) }),
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
    const { result } = renderHook(() => useVoiceInput(vi.fn(), deps), { wrapper: I18nProvider });
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
        v: "0.14",
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
    const { result } = renderHook(() => useVoiceInput(vi.fn(), deps), { wrapper: I18nProvider });
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

  it("单飞门控（V3a）：idle 态吞外来回执——他消费面（管家语音）的转写结果不回填不报错", async () => {
    const restore = installRecorder();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript, deps), { wrapper: I18nProvider });
    // 本钩子 idle（未在转写在途）；外来 ok 回执到达
    act(() => {
      frameListener!({
        v: "0.14",
        type: "stt.transcribe.result",
        payload: { status: "ok", text: "他消费面的转写", provider: "dashscope" },
      } as EventEnvelope);
    });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
    // 外来 error 回执同理吞（不污染本面 error）
    act(() => {
      frameListener!({
        v: "0.14",
        type: "stt.transcribe.result",
        payload: { status: "error", reason: "他面错误" },
      } as EventEnvelope);
    });
    expect(result.current.error).toBeNull();
    restore();
  });
});
