/**
 * rms-meter 帧特征纯计算测试（B3 双参载荷：RMS + ZCR；TDD 红→绿）。
 *
 * computeMeterFrame 是 worklet 主路径与 AnalyserNode 兜底的同口径帧计算
 * 提取面（worklet 内联同构实现——Blob 源码不可 import）：零音频环境可测。
 */
import { describe, expect, it } from "vitest";
import { computeMeterFrame, VOICE_METER_INTERVAL_MS, WORKLET_SRC } from "./rms-meter";

/** worklet 源 shim 装载（零音频环境可测）：globalThis 补 AudioWorkletProcessor /
 *  registerProcessor / currentTime（getter 可推进），eval 源码后返回处理器类。 */
function loadWorkletClass(): {
  Ctor: new () => {
    port: { postMessage: (m: { rms: number; zcr: number }) => void };
    process: (inputs: Float32Array[][]) => boolean;
  };
  posted: { rms: number; zcr: number }[];
  now: number;
  restore: () => void;
} {
  const posted: { rms: number; zcr: number }[] = [];
  let now = 0;
  class AudioWorkletProcessor {
    port = { postMessage: (m: { rms: number; zcr: number }) => void 0 };
  }
  // shim 类的 port 与实例无关——用闭包 posted 收帧：在源码实例化侧替换不可行，
  // 改为在 registerProcessor 捕获的类上包一层（构造后重绑 port）
  let Ctor: any = null;
  const registerProcessor = (_name: string, c: any) => {
    Ctor = class extends c {
      constructor() {
        super();
        this.port = { postMessage: (m: { rms: number; zcr: number }) => void posted.push(m) };
      }
    };
  };
  const descAP = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletProcessor");
  const descRP = Object.getOwnPropertyDescriptor(globalThis, "registerProcessor");
  const descCT = Object.getOwnPropertyDescriptor(globalThis, "currentTime");
  (globalThis as Record<string, unknown>).AudioWorkletProcessor = AudioWorkletProcessor;
  (globalThis as Record<string, unknown>).registerProcessor = registerProcessor;
  Object.defineProperty(globalThis, "currentTime", { configurable: true, get: () => now });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${WORKLET_SRC}\nreturn HelixRmsProcessor;`) as () => unknown;
  factory();
  const restore = () => {
    for (const [key, desc] of [
      ["AudioWorkletProcessor", descAP],
      ["registerProcessor", descRP],
      ["currentTime", descCT],
    ] as const) {
      if (desc !== undefined) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { Ctor: Ctor as never, posted, get now() { return now; }, set now(v: number) { now = v; }, restore } as never;
}

describe("computeMeterFrame（帧特征：RMS + 过零率 ZCR）", () => {
  it("空样本 → 零帧（不抛错）", () => {
    expect(computeMeterFrame(new Float32Array(0))).toEqual({ rms: 0, zcr: 0 });
  });

  it("常量正值 → rms = 幅值、zcr = 0（零过零——直流）", () => {
    const f = computeMeterFrame(new Float32Array([0.5, 0.5, 0.5, 0.5]));
    expect(f.rms).toBeCloseTo(0.5, 6);
    expect(f.zcr).toBe(0);
  });

  it("全零 → {0, 0}", () => {
    expect(computeMeterFrame(new Float32Array(8))).toEqual({ rms: 0, zcr: 0 });
  });

  it("交替方波 → 每样本一过零（zcr = (n-1)/n）；rms = 幅值", () => {
    const f = computeMeterFrame(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    expect(f.rms).toBeCloseTo(0.5, 6);
    expect(f.zcr).toBeCloseTo(3 / 4, 6);
  });

  it("触零不漏计：零样本跳过符号追踪，越零变号仍计一次", () => {
    // [1, 0, -1, 0, 1]：+→-（i2）与 -→+（i4）两次变号（零样本不另计）
    const f = computeMeterFrame(new Float32Array([1, 0, -1, 0, 1]));
    expect(f.zcr).toBeCloseTo(2 / 5, 6);
  });
});

describe("WORKLET_SRC（worklet 窗口累积计量——中危 F3a）", () => {
  const QUANTUM = 128;
  const QUANTUM_S = QUANTUM / 16000; // 16kHz → 8ms/量子

  it("帧间隔内全部量子参与 RMS（键盘脉冲类瞬态不漏帧）——非只计触发节流门那一拍", () => {
    const sh = loadWorkletClass();
    try {
      const p = new sh.Ctor();
      // 前 10 个量子：强信号 0.5（累计 80ms）——旧实现这些全不参与计量
      for (let q = 1; q <= 10; q += 1) {
        sh.now = q * QUANTUM_S;
        p.process([[new Float32Array(QUANTUM).fill(0.5)]]);
      }
      // 第 11 量子触发节流门（≥100ms）且为近零静音——旧实现帧 = 0.001（漏掉前 80ms）
      sh.now = VOICE_METER_INTERVAL_MS / 1000 + QUANTUM_S;
      p.process([[new Float32Array(QUANTUM).fill(0.001)]]);
      expect(sh.posted.length).toBe(1);
      // 窗口累积口径：11 量子全计（10×0.5² + 1×0.001²）/ 11 → rms ≈ 0.4767
      expect(sh.posted[0]!.rms).toBeGreaterThan(0.4);
      expect(sh.posted[0]!.rms).toBeCloseTo(Math.sqrt((10 * 0.25 + 0.000001) / 11), 3);
    } finally {
      sh.restore();
    }
  });

  it("累积窗口后复位：第二帧只计新窗内量子；静音窗 → rms ≈ 0", () => {
    const sh = loadWorkletClass();
    try {
      const p = new sh.Ctor();
      sh.now = VOICE_METER_INTERVAL_MS / 1000;
      p.process([[new Float32Array(QUANTUM).fill(0.5)]]); // 第一帧（累积触发）
      sh.now = VOICE_METER_INTERVAL_MS / 500;
      p.process([[new Float32Array(QUANTUM * 4).fill(0)]]); // 第二窗全静音
      expect(sh.posted.length).toBe(2);
      expect(sh.posted[1]!.rms).toBe(0);
      expect(sh.posted[1]!.zcr).toBe(0);
    } finally {
      sh.restore();
    }
  });
});
