/**
 * rms-meter —— 录音电平/RMS 计量管道（语音输入 V2：点击开始 + VAD 静音
 * 自动停）。
 *
 * 形态：AudioWorklet 主路径（worklet 源码 Blob URL 内联——单文件零构建
 * 配置；spike 已验证 AudioWorklet 16kHz RMS 可行）+ AnalyserNode 轮询兜底
 * （addModule 拒绝/不可用时降级，行为同构仅帧率略低）。两路径都只做一件事：
 * 每 ~VOICE_METER_INTERVAL_MS 产一帧 MeterFrame（RMS 0..1 + ZCR 过零率，
 * B3 双参载荷）回调——静音判定逻辑全在 useVoiceInput 侧、barge-in 双参判定
 * 全在 steward-voice-machine 侧（帧驱动门，逻辑可测面与设备面分离）。
 *
 * 环境防御：无 AudioContext（jsdom/裸 tauri）→ 返回 null（调用方 VAD 关闭，
 * 保留手动停路径）——绝不在不支持环境抛错。
 */

/** 计量帧节流（ms）：worklet 侧 sampleTime 门 + Analyser 轮询周期同源。 */
export const VOICE_METER_INTERVAL_MS = 100;

/** 计量帧载荷（B3 双参：RMS + 过零率 ZCR——键盘声=宽带脉冲 ZCR 高、
 *  人声浊音=谐波结构 ZCR 低中；barge-in 双参判定消费）。 */
export interface MeterFrame {
  /** 帧 RMS（0..1）。 */
  readonly rms: number;
  /** 帧过零率（0..1，每样本过零次数）。 */
  readonly zcr: number;
}

/** RMS meter 契约（测试注入面：fake meter 按 emit 帧载荷驱动门判定）。 */
export interface RmsMeter {
  /** 注册电平帧回调（每帧 MeterFrame：RMS + ZCR）。 */
  onLevel(cb: (frame: MeterFrame) => void): void;
  /** 关闭计量（停 AudioContext/清 interval；幂等）。 */
  close(): void;
}

/** meter 工厂契约：stream → meter（null = 环境不支持，VAD 降级关闭）。 */
export type RmsMeterFactory = (stream: MediaStream) => Promise<RmsMeter | null>;

/**
 * 帧特征纯计算（worklet 主路径与 AnalyserNode 兜底同口径；worklet Blob
 * 源码不可 import，内联同构实现）：样本窗 → RMS + ZCR。零音频环境可测。
 */
export function computeMeterFrame(samples: ArrayLike<number>): MeterFrame {
  const n = samples.length;
  if (n === 0) return { rms: 0, zcr: 0 };
  let sum = 0;
  let crossings = 0;
  let sign = 0; // 最后非零符号（零样本跳过——越零变号计一次）
  for (let i = 0; i < n; i += 1) {
    const s = samples[i]!;
    sum += s * s;
    const sgn = s > 0 ? 1 : s < 0 ? -1 : 0;
    if (sgn !== 0) {
      if (sign !== 0 && sgn !== sign) crossings += 1;
      sign = sgn;
    }
  }
  return { rms: Math.sqrt(sum / n), zcr: crossings / n };
}

/** AudioWorklet 处理器源码（Blob URL 装载；16kHz 采样率下 128 帧量子 ≈ 8ms）。
 *  帧计算与 computeMeterFrame 同构（RMS + ZCR；量子窗口径两路径一致；
 *  零样本跳过符号追踪，越零变号计一次过零）。 */
const WORKLET_SRC = `
class HelixRmsProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.lastPost = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const now = currentTime;
      if (now - this.lastPost >= ${VOICE_METER_INTERVAL_MS} / 1000) {
        this.lastPost = now;
        let sum = 0;
        let crossings = 0;
        let sign = 0;
        for (let i = 0; i < ch.length; i += 1) {
          const s = ch[i];
          sum += s * s;
          const sgn = s > 0 ? 1 : s < 0 ? -1 : 0;
          if (sgn !== 0) {
            if (sign !== 0 && sgn !== sign) crossings += 1;
            sign = sgn;
          }
        }
        this.port.postMessage({ rms: Math.sqrt(sum / ch.length), zcr: crossings / ch.length });
      }
    }
    return true;
  }
}
registerProcessor("helix-rms", HelixRmsProcessor);
`;

/**
 * 默认 meter 工厂：AudioWorklet 主路径 + AnalyserNode 轮询兜底。
 * 无 AudioContext → null（不抛错；调用方降级为无 VAD 手动停）。
 */
export const createWorkletRmsMeter: RmsMeterFactory = async (stream: MediaStream): Promise<RmsMeter | null> => {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (typeof Ctor === "undefined") return null;
  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null; // 构造失败（设备占用/策略）→ VAD 降级
  }
  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    void ctx.close().catch(() => undefined);
    source.disconnect();
  };
  const source = ctx.createMediaStreamSource(stream);
  const post = (cb: (frame: MeterFrame) => void, frame: MeterFrame) => {
    if (!closed) cb(frame);
  };

  // 主路径：worklet（Blob URL——单文件装载，无独立 worklet 文件/构建配置）
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (closed) {
      teardown();
      return null;
    }
    const node = new AudioWorkletNode(ctx, "helix-rms");
    let listener: ((e: MessageEvent) => void) | null = null;
    node.port.onmessage = (e: MessageEvent) => {
      if (listener !== null) listener(e);
    };
    source.connect(node);
    return {
      onLevel(cb) {
        listener = (e) => {
          // 帧载荷双轨兼容：新面 {rms, zcr} 对象 / 旧面纯数（rms）
          const data = e.data as { rms?: number; zcr?: number } | number;
          const frame: MeterFrame =
            typeof data === "number" ? { rms: data, zcr: 0 } : { rms: Number(data.rms), zcr: Number(data.zcr) };
          post(cb, frame);
        };
      },
      close() {
        node.port.onmessage = null;
        node.disconnect();
        teardown();
      },
    };
  } catch {
    // 兜底路径：AnalyserNode 轮询（addModule 拒绝/Worklet 不可用）
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    onLevel(cb) {
      timer = setInterval(() => {
        if (closed) return;
        analyser.getFloatTimeDomainData(buf);
        post(cb, computeMeterFrame(buf));
      }, VOICE_METER_INTERVAL_MS);
    },
    close() {
      if (timer !== null) clearInterval(timer);
      teardown();
    },
  };
};
