// @vitest-environment jsdom
/**
 * useVoiceInput 状态机测试（语音输入批 V1；录音 mock 路径——MediaRecorder/
 * getUserMedia 全 stub，零真机依赖）。
 *
 * - unsupported：无 navigator.mediaDevices → 初始态 unsupported、start() no-op；
 * - 全链：start() → recording（getUserMedia + mime 选择序）→ stop() →
 *   blob → dataURL → sendSttTranscribe（jsdom FileReader 真解析）→
 *   transcribing → 回执 ok → onTranscript(text)；回执 error → error 态；
 * - 过短录音（<300ms）不发送（防误触计费）；sendSttTranscribe 返回 false
 *   （未连接）→ idle + error。
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

import { useVoiceInput } from "./useVoiceInput";

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
    // 250ms 后产一片（模拟分片；测试快进不等真实时间——stop 前手动产片）
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    }, 5);
  }
  stop(): void {
    this.onstop?.();
  }
}

describe("useVoiceInput（语音输入批 V1）", () => {
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

  it("全链：按住→recording→松开→transcribing→回执 ok→onTranscript 回填；sendSttTranscribe 收 dataURL+provider 缺省", async () => {
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript), { wrapper: I18nProvider });
    expect(result.current.state).toBe("idle");

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    expect(FakeMediaRecorder.instances.length).toBe(1);
    // mime 选择序首选（audio/webm;codecs=opus）
    expect(FakeMediaRecorder.instances[0]!.mimeType).toBe("audio/webm;codecs=opus");

    // 过短拦截窗口（<300ms 防误触）——等窗过后再 stop
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    act(() => {
      result.current.stop();
    });
    // stop → onstop 同步 → FileReader 异步 → sendSttTranscribe
    await waitFor(() => {
      expect(sendSttTranscribe).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
    expect(result.current.state).toBe("transcribing");
    const [audioArg, optsArg] = sendSttTranscribe.mock.calls[0] as unknown as [string, { language?: string }];
    expect(audioArg.startsWith("data:audio/webm;codecs=opus;base64,")).toBe(true);
    expect(optsArg.language).toBe("zh");

    // 回执 ok → idle + onTranscript(text)
    act(() => {
      frameListener!({
        v: "0.12",
        type: "stt.transcribe.result",
        payload: { status: "ok", text: "把 useEffect 修一下", provider: "dashscope" },
      } as EventEnvelope);
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(onTranscript).toHaveBeenCalledWith("把 useEffect 修一下");
  });

  it("回执 error 判别 → idle + error 交代（key 未配引导）", async () => {
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const { result } = renderHook(() => useVoiceInput(vi.fn()), { wrapper: I18nProvider });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    act(() => {
      result.current.stop();
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    act(() => {
      frameListener!({
        v: "0.12",
        type: "stt.transcribe.result",
        payload: { status: "error", reason: 'provider "dashscope" 未录入 API key' },
      } as EventEnvelope);
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toContain("API key");
  });

  it("sendSttTranscribe 返回 false（未连接）→ idle + error，不进入 transcribing", async () => {
    sendSttTranscribe.mockReturnValueOnce(false);
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
    const { result } = renderHook(() => useVoiceInput(vi.fn()), { wrapper: I18nProvider });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    act(() => {
      result.current.stop();
    });
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).not.toBeNull(); // sendFail 词条（i18n 语言随 provider 缺省）
  });
});
