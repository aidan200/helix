// @vitest-environment jsdom
/**
 * useVoiceInput 状态机测试——后续批次扩展面（V3b-1 deferredTranscribe 流式
 * 收口 / 收口门共基：灵敏度偏好驱动 + ZCR 双参 + 有效发声闸 / 问题 3 保险：
 * 播报撞车录音拒转写）。纯位置迁移自 useVoiceInput.test.ts（P1 体量门拆分批，
 * 测试逻辑、断言与 fixture 零改动）。
 *
 * 注：模块级 mock 面（sendSttTranscribe/subscribeSttFrames/frameListener/
 * FakeMediaRecorder/installRecorder）在两文件各持一份副本——用例直接给这些
 * 模块级绑定赋值（ESM import 只读，无法跨文件共享可变绑定）。
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

// ── V3b-1 流式扩展面：deferred 收口 + PCM 泵 + 单飞门控扩展 ─────────

describe("useVoiceInput（V3b-1：deferredTranscribe 流式收口面）", () => {
  const origMediaDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    frameListener = null;
    FakeMediaRecorder.instances = [];
    Object.defineProperty(navigator, "mediaDevices", { value: origMediaDevices, configurable: true });
    if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
  });

  /** 走到 deferred 停录点（强停 + 过最短窗；返回 hook result）。 */
  async function recordAndStopDeferred(onDeferredHold: () => void) {
    const restore = installRecorder();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { result } = renderHook(
      () =>
        useVoiceInput(vi.fn(), {
          ...deps,
          deferredTranscribe: true,
          onDeferredHold,
          createMeter: () => Promise.resolve(makeFakeMeter()),
        }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    nowMs += 500; // 过最短录音窗
    await tick();
    act(() => {
      result.current.stop();
    });
    spy.mockRestore();
    restore();
    return result;
  }

  it("deferred 停录：持 blob 停留 transcribing（零上传）+ onDeferredHold 恰一次", async () => {
    const onDeferredHold = vi.fn();
    const result = await recordAndStopDeferred(onDeferredHold);
    expect(result.current.state).toBe("transcribing");
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    expect(onDeferredHold).toHaveBeenCalledTimes(1);
  });

  it("resolveStreaming(text)：非空 → idle + onTranscript；空 → idle 零回调（静音丢弃）", async () => {
    const onTranscript = vi.fn();
    const restore = installRecorder();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { result } = renderHook(
      () => useVoiceInput(onTranscript, { ...deps, deferredTranscribe: true, createMeter: () => Promise.resolve(makeFakeMeter()) }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    nowMs += 500;
    await tick();
    act(() => {
      result.current.stop();
    });
    let resolved = false;
    act(() => {
      resolved = result.current.resolveStreaming("帮我把 Paraformer 接入");
    });
    expect(resolved).toBe(true);
    expect(result.current.state).toBe("idle");
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("帮我把 Paraformer 接入");
    // 空文本轮：丢弃回 idle 零回调（fake clock 继续推进过最短窗）
    await act(async () => {
      await result.current.start();
    });
    nowMs += 500;
    await tick();
    act(() => {
      result.current.stop();
    });
    let resolvedEmpty = false;
    act(() => {
      resolvedEmpty = result.current.resolveStreaming("");
    });
    expect(resolvedEmpty).toBe(true);
    expect(result.current.state).toBe("idle");
    expect(onTranscript).toHaveBeenCalledTimes(1); // 未新增
    // 非 deferred 态 no-op
    let stale = true;
    act(() => {
      stale = result.current.resolveStreaming("x");
    });
    expect(stale).toBe(false);
    spy.mockRestore();
    restore();
  });

  it("transcribeNow：回落非流式——blob 上传链照旧（data URL + language zh）", async () => {
    const result = await recordAndStopDeferred(() => undefined);
    act(() => {
      result.current.transcribeNow();
    });
    await waitFor(() => {
      expect(sendSttTranscribe).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    const [audioArg, optsArg] = sendSttTranscribe.mock.calls[0] as unknown as [string, { language?: string }];
    expect(audioArg.startsWith("data:audio/webm;codecs=opus;base64,")).toBe(true);
    expect(optsArg.language).toBe("zh");
    expect(result.current.state).toBe("transcribing"); // 等回执
  });

  it("单飞门控（V3b-1 扩展）：deferred 等终帧期间外来回执不消费；transcribeNow 后消费", async () => {
    const result = await recordAndStopDeferred(() => undefined);
    act(() => {
      frameListener?.({
        v: "0.14",
        sessionId: "__system__",
        channel: "stt",
        type: "stt.transcribe.result",
        payload: { status: "ok", text: "他面的结果", provider: "dashscope" },
      } as unknown as EventEnvelope);
    });
    expect(result.current.state).toBe("transcribing"); // 未被外来回执收口
    act(() => {
      result.current.transcribeNow();
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    act(() => {
      frameListener?.({
        v: "0.14",
        sessionId: "__system__",
        channel: "stt",
        type: "stt.transcribe.result",
        payload: { status: "ok", text: "回落转写文本", provider: "dashscope" },
      } as unknown as EventEnvelope);
    });
    expect(result.current.state).toBe("idle");
  });

  it("onPcmFrame：pump 挂载 + 录音中帧转发 + 停录后关闭零转发", async () => {
    const restore = installRecorder();
    const onPcmFrame = vi.fn();
    let pumpCb: ((frame: ArrayBuffer) => void) | null = null;
    const pump = {
      onFrame: (cb: (frame: ArrayBuffer) => void) => {
        pumpCb = cb;
      },
      close: vi.fn(),
    };
    const createPump = vi.fn(() => Promise.resolve(pump));
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { ...deps, createMeter: () => Promise.resolve(makeFakeMeter()), onPcmFrame, createPump }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(createPump).toHaveBeenCalledTimes(1); // 挂载
    const frame = new ArrayBuffer(3200);
    act(() => {
      pumpCb?.(frame);
    });
    expect(onPcmFrame).toHaveBeenCalledTimes(1);
    expect(onPcmFrame).toHaveBeenCalledWith(frame);
    act(() => {
      result.current.stop();
    });
    expect(pump.close).toHaveBeenCalledTimes(1);
    act(() => {
      pumpCb?.(new ArrayBuffer(3200));
    });
    expect(onPcmFrame).toHaveBeenCalledTimes(1); // 停录后零转发
    restore();
  });

  it("不传 onPcmFrame：pump 工厂零调用（V3a 行为零感知——Composer 先例）", async () => {
    const restore = installRecorder();
    const createPump = vi.fn(() => Promise.resolve(null));
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { ...deps, createMeter: () => Promise.resolve(makeFakeMeter()), createPump }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    expect(createPump).not.toHaveBeenCalled();
    restore();
  });
});

// ── 收口门共基（语音判定钝感批：灵敏度/ZCR 双参同源 + 有效发声闸）──────

describe("useVoiceInput（收口门共基：灵敏度偏好驱动 + ZCR 双参 + 有效发声闸）", () => {
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
    localStorage.removeItem(VOICE_VAD_SENSITIVITY_PREF_KEY);
    localStorage.removeItem(VOICE_VOICE_CHECK_PREF_KEY);
    Object.defineProperty(navigator, "mediaDevices", { value: origMediaDevices, configurable: true });
    if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
  });

  /** 持续声帧驱动（帧间 100ms 同构真实节流；count 帧 ≈ count×100ms 有效发声）。 */
  async function driveFrames(meter: { emit: (rms: number, zcr?: number) => void }, count: number, rms: number, zcr?: number, clock?: { advance: (ms: number) => void }) {
    for (let i = 0; i < count; i += 1) {
      await act(async () => {
        meter.emit(rms, zcr);
      });
      clock?.advance(100);
    }
  }

  it("userSpeaking 保持窗：开麦未开口 false → 人声帧置 true → 静音超窗（900ms）回落 false；停录即复位", async () => {
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
    expect(result.current.userSpeaking).toBe(false); // 开麦未开口：待机驻留依据
    // 人声帧（rms 0.1 带内 ZCR 缺省 0.1）→ 立即 true（开口瞬间转倾听）
    await act(async () => {
      meter.emit(0.1);
    });
    expect(result.current.userSpeaking).toBe(true);
    // 静音帧持续：保持窗内（<900ms）不回落（词间停顿不闪断）
    clock.advance(500);
    await act(async () => {
      meter.emit(0.001);
    });
    expect(result.current.userSpeaking).toBe(true);
    // 静音超窗 → 回落 false（说完回待机；比静音自动停 1.8s 早——视觉先行）
    clock.advance(VOICE_SPEAKING_HOLD_MS + 100);
    await act(async () => {
      meter.emit(0.001);
    });
    expect(result.current.userSpeaking).toBe(false);
    restore();
  });

  it("灵敏度偏好驱动收口：调低（0 → 阈值 0.036）后 0.02 持续声帧不计开口 → 静音收口走丢弃；缺省档同幅帧照常转写", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    localStorage.setItem(VOICE_VAD_SENSITIVITY_PREF_KEY, "0"); // 钝档：阈值 0.036
    expect(voiceRmsThresholdFromSensitivity(0)).toBeCloseTo(0.036, 6);
    const meter = makeFakeMeter();
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { ...deps, createMeter: () => Promise.resolve(meter) }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    // 0.02 帧（> 旧缺省 0.012、< 钝档 0.036）持续——不置 spoke 不刷新 lastLoud
    await driveFrames(meter, 8, 0.02, undefined, clock);
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200);
    await act(async () => {
      meter.emit(0.02);
    });
    expect(result.current.state).toBe("idle"); // 未开口 VAD 丢弃（零转写零计费）
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    // 对照：缺省灵敏度（50 → 0.012）同幅帧计入开口 → 静音收口照常转写
    localStorage.removeItem(VOICE_VAD_SENSITIVITY_PREF_KEY);
    await act(async () => {
      await result.current.start();
    });
    await driveFrames(meter, 4, 0.02, undefined, clock);
    await tick(); // 分片落地（转写链前置）
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200);
    await act(async () => {
      meter.emit(0.001);
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    restore();
  });

  it("ZCR 带外帧（键盘噪声）不计开口：静音收口走丢弃；voiceCheck 关放行（单参回退）", async () => {
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
    // rms 0.05 超阈但 zcr 0.6 带外（键盘噪声特征，voiceCheck 缺省开）——不计开口
    await driveFrames(meter, 8, 0.05, 0.6, clock);
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200);
    await act(async () => {
      meter.emit(0.05, 0.6);
    });
    expect(result.current.state).toBe("idle"); // 按未开口丢弃
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    // voiceCheck 关（"0"）：同帧放行（rms 单参回退行为）→ 转写
    localStorage.setItem(VOICE_VOICE_CHECK_PREF_KEY, "0");
    await act(async () => {
      await result.current.start();
    });
    await driveFrames(meter, 4, 0.05, 0.6, clock);
    await tick(); // 分片落地（转写链前置）
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200);
    await act(async () => {
      meter.emit(0.001);
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    restore();
  });

  it("有效发声闸：短促人声帧累计 < VOICE_SPEECH_MIN_MS 后长静音 → 自动停零转写（噪声幻听兑底）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    expect(VOICE_SPEECH_MIN_MS).toBe(250);
    const meter = makeFakeMeter();
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { ...deps, createMeter: () => Promise.resolve(meter) }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    // 2 帧（200ms < 250ms）真判据帧后长静音——spoke 已置但有效发声不足
    await driveFrames(meter, 2, 0.05, undefined, clock);
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200);
    await act(async () => {
      meter.emit(0.001);
    });
    expect(result.current.state).toBe("idle"); // 按未开口丢弃（零转写零计费）
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    restore();
  });

  it("点击强制停不看发声闸：同短促帧场景强制停 → 照常转写（显式收口宁转写不丢话）", async () => {
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
    await tick();
    // 同上短促帧（200ms < 250ms）——但用户点击强制停
    await driveFrames(meter, 2, 0.05, undefined, clock);
    clock.advance(VOICE_MIN_DURATION_MS + 100);
    act(() => {
      result.current.stop();
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    restore();
  });

  it("getRmsThreshold 注入覆盖偏好：返回高阈值 → 低幅帧不计开口（底噪校准消费面）", async () => {
    const restore = installRecorder();
    const clock = useFakeClock();
    clockRestore = clock.restore;
    const getRmsThreshold = vi.fn(() => 0.05);
    const meter = makeFakeMeter();
    const { result } = renderHook(
      () => useVoiceInput(vi.fn(), { ...deps, createMeter: () => Promise.resolve(meter), getRmsThreshold }),
      { wrapper: I18nProvider },
    );
    await act(async () => {
      await result.current.start();
    });
    // 0.02 帧（> 缺省偏好阈值 0.012、< 注入 0.05）×4 帧 = 400ms（排除发声闸干扰）
    await driveFrames(meter, 4, 0.02, undefined, clock);
    expect(getRmsThreshold).toHaveBeenCalled(); // 注入面逐帧消费
    clock.advance(VOICE_LEAD_IN_MS + VOICE_SILENCE_STOP_MS + 200);
    await act(async () => {
      meter.emit(0.001);
    });
    expect(result.current.state).toBe("idle"); // 注入阈值拒帧 → 按未开口丢弃
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    restore();
  });
});

describe("useVoiceInput（问题 3 保险：播报撞车录音拒转写——blob 通道不混 TTS 自声）", () => {
  const origMediaDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    frameListener = null;
    FakeMediaRecorder.instances = [];
    resetSpeechMutexForTest();
    Object.defineProperty(navigator, "mediaDevices", { value: origMediaDevices, configurable: true });
    if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
  });

  /** 录一段（fake 时钟过最短窗 + 分片落地）到 stop 收口；返回 hook result。 */
  async function recordAndForceStop(
    options: Parameters<typeof useVoiceInput>[1],
    midRecord?: () => void,
  ) {
    const restore = installRecorder();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { result } = renderHook(() => useVoiceInput(vi.fn(), options), { wrapper: I18nProvider });
    await act(async () => {
      await result.current.start();
    });
    nowMs += 500; // 过最短录音窗（防误触门出链）
    await tick(); // 分片落地
    midRecord?.();
    act(() => {
      result.current.stop(); // 强制停（显式收口——宁转写不丢话的既有语义）
    });
    await tick();
    spy.mockRestore();
    restore();
    return result;
  }

  it("录音起始即有播报租约 → 强停后零转写零上行 + error 交代（拒混音宁重说）", async () => {
    beginSpeechLease("test-playback"); // 播报在播：录音窗与播报撞车（blob 必混 TTS 自声）
    const result = await recordAndForceStop({ ...deps, createMeter: () => Promise.resolve(makeFakeMeter()) });
    expect(sendSttTranscribe).not.toHaveBeenCalled(); // 拒转写（混音录音不出门）
    expect(result.current.state).toBe("idle");
    expect(result.current.error).not.toBeNull();
  });

  it("录音中播报起租（边沿）→ 同拒转写", async () => {
    const result = await recordAndForceStop({ ...deps, createMeter: () => Promise.resolve(makeFakeMeter()) }, () => {
      beginSpeechLease("test-playback"); // 录音中途播报起播
    });
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
  });

  it("撞车轮收口后新录音（租约已收）→ 照常转写（标记随轮清零）", async () => {
    beginSpeechLease("test-playback");
    await recordAndForceStop({ ...deps, createMeter: () => Promise.resolve(makeFakeMeter()) });
    endSpeechLease("test-playback"); // 播报播完
    const result = await recordAndForceStop({ ...deps, createMeter: () => Promise.resolve(makeFakeMeter()) });
    expect(sendSttTranscribe).toHaveBeenCalledTimes(1); // 新轮干净 → 正常转写
    expect(result.current.error).toBeNull();
  });

  it("deferred 回落 transcribeNow 撞车录音 → 拒回落零上传（备用通道不混音）", async () => {
    beginSpeechLease("test-playback");
    const result = await recordAndForceStop({
      ...deps,
      deferredTranscribe: true,
      createMeter: () => Promise.resolve(makeFakeMeter()),
    });
    expect(result.current.state).toBe("transcribing"); // deferred 持 blob 在途
    act(() => {
      result.current.transcribeNow(); // 主流转式失败 → 回落整段转写
    });
    await tick();
    expect(sendSttTranscribe).not.toHaveBeenCalled(); // 撞车录音拒绝回落（混音结果不发问）
    expect(result.current.state).toBe("idle");
    expect(result.current.error).not.toBeNull();
  });
});
