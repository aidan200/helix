// @vitest-environment jsdom
/**
 * 注册引导录音器（mic-recorder）测试：句收口三闸 + 未开口兜底。
 *
 * 评审 mic-recorder.ts:52：未开口兜底超时（(max+2)s）不判 spoke 直接 resolve
 * 纯静音段——上游 recordInto/register 只校验时长 ≥1.2s，静音句会被注册成声纹
 * 模板句（污染模板、相似度判定失真）。port 契约「null = 采集失败」——未开口
 * 即采集失败，收口返回 null。
 *
 * mock 面：pcm-pump（帧源可控）+ navigator.mediaDevices.getUserMedia。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createWorkletPcmPump = vi.fn();

vi.mock("@/shared/lib/pcm-pump", () => ({
  createWorkletPcmPump: (stream: MediaStream) => createWorkletPcmPump(stream),
}));

import { createMicUtteranceRecorder } from "./mic-recorder";

/** 帧源控制面：record 启动后由用例主动喂帧。 */
let onFrame: ((frame: ArrayBuffer) => void) | null = null;
let pumpClosed = false;
const trackStop = vi.fn();

function installEnv(gumOk = true): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn(() =>
        gumOk
          ? Promise.resolve({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream)
          : Promise.reject(new Error("denied")),
      ),
    },
    configurable: true,
  });
  createWorkletPcmPump.mockResolvedValue({
    onFrame: (cb: (frame: ArrayBuffer) => void) => {
      onFrame = cb;
    },
    close: () => {
      pumpClosed = true;
    },
  });
}

/** 一帧 100ms @16k 单声道 Int16（帧粒度与生产 100ms 对齐）。 */
function feedFrame(amplitude: number): void {
  const samples = new Int16Array(1_600);
  if (amplitude !== 0) samples.fill(amplitude);
  onFrame?.(samples.buffer);
}

/** 放行 record() 的 await 链（getUserMedia → createWorkletPcmPump → onFrame 注册）。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  onFrame = null;
  pumpClosed = false;
  trackStop.mockClear();
  createWorkletPcmPump.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createMicUtteranceRecorder 未开口兜底（评审 :52）", () => {
  it("全程静音 → 兜底超时收口返回 null（纯静音段不得当采集成功）", async () => {
    installEnv();
    const rec = createMicUtteranceRecorder();
    const pending = rec.record(1.2, 6);
    await flush();
    expect(onFrame).not.toBeNull();
    // 只喂静音帧（RMS 0 < 门限 655）——用户没开口
    for (let i = 0; i < 20; i += 1) feedFrame(0);
    vi.advanceTimersByTime((6 + 2) * 1_000);
    await expect(pending).resolves.toBeNull();
    expect(pumpClosed).toBe(true); // 泵照常收口
    expect(trackStop).toHaveBeenCalled(); // 轨道释放（money 纪律：零孤儿采集）
  });

  it("开口后静音达标 → 正常收口返回 PCM（不误伤有效录入）", async () => {
    installEnv();
    const rec = createMicUtteranceRecorder();
    const pending = rec.record(1.2, 6);
    await flush();
    // 开口一段（有声帧）+ 1.8s 静音 → 句收口（达最短且静音窗口满足）
    feedFrame(20_000);
    for (let i = 0; i < 30; i += 1) feedFrame(0);
    const pcm = await pending;
    expect(pcm).not.toBeNull();
    expect(pcm!.length).toBeGreaterThan(0);
    expect(trackStop).toHaveBeenCalled();
  });
});
