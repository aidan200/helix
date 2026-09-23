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

import { useVoiceInput, VOICE_MIN_DURATION_MS, VOICE_SILENCE_STOP_MS, VOICE_LEAD_IN_MS } from "./useVoiceInput";
import type { MeterFrame, RmsMeter } from "./rms-meter";

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

/** fake RMS meter（VAD 帧注入面：emit(rms) 模拟 worklet/Analyser 帧回调；
 *  B3 帧载荷扩 ZCR——本面只消费 rms，zcr 补 0）。 */
function makeFakeMeter(): RmsMeter & { emit: (rms: number) => void } {
  let cb: ((frame: MeterFrame) => void) | null = null;
  return {
    onLevel: (fn: (frame: MeterFrame) => void) => {
      cb = fn;
    },
    close: vi.fn(),
    emit: (rms: number) => cb?.({ rms, zcr: 0 }),
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
    const restore = installRecorder();
    const meter = makeFakeMeter();
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
