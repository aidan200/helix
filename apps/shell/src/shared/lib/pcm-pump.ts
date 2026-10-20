/**
 * pcm-pump —— 录音 PCM 抽取管道（V3b-1 流式转写批）。
 *
 * 形态：AudioWorklet（worklet 源码 Blob URL 内联——rms-meter 先例，单文件
 * 零构建配置）。与 rms-meter 同一 MediaStream 共存（各自 AudioContext/
 * addModule——互不干扰；不传 onPcmFrame 的消费面零挂载，V3a 行为零感知）。
 *
 * 职责单件：ctx 采样率（48k/44.1k）→ 16kHz 线性插值重采样 → Int16 量化
 * → 每 100ms（1600 样本 = 3200 字节）post 一帧 ArrayBuffer（transferable）
 * 回调。静音判定/发送节律全在消费方（逻辑可测面与设备面分离）。
 *
 * 环境防御：无 AudioContext / addModule 拒绝 → 返回 null（调用方流式降级，
 * 录音功能不受影响——rms-meter 同构纪律，绝不抛错）。
 */

/** 目标采样率（DashScope realtime input_audio_format pcm 上游口径）。 */
export const PCM_SAMPLE_RATE = 16_000;

/** 每帧样本数（100ms @16k = 1600 样本 = 3200 字节 Int16）。 */
export const PCM_FRAME_SAMPLES = PCM_SAMPLE_RATE / 10;

/** PCM 帧泵契约（测试注入面：fake pump 按 emit 驱动帧回调）。 */
export interface PcmPump {
  /** 注册帧回调（~100ms Int16 PCM 16k mono ArrayBuffer）。 */
  onFrame(cb: (frame: ArrayBuffer) => void): void;
  /** 关闭（停 AudioContext/断节点；幂等）。 */
  close(): void;
}

/** 泵工厂契约：stream → pump（null = 环境不支持，流式降级）。 */
export type PcmPumpFactory = (stream: MediaStream) => Promise<PcmPump | null>;

/** AudioWorklet 处理器源码（Blob URL 装载；线性插值重采样 + Int16 量化）。 */
const WORKLET_SRC = `
class HelixPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${PCM_SAMPLE_RATE};
    this.buf = new Float32Array(0);
    this.pos = 0;                          // 插值读指针（buf 内浮点位置）
    this.frame = new Float32Array(${PCM_FRAME_SAMPLES});
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) {
      const merged = new Float32Array(this.buf.length + ch.length);
      merged.set(this.buf);
      merged.set(ch, this.buf.length);
      this.buf = merged;
      // 尽量多地产 16k 样本（保留最后 1 样本供插值边界）
      while (Math.floor(this.pos) + 1 < this.buf.length) {
        const i = Math.floor(this.pos);
        const frac = this.pos - i;
        const s = this.buf[i] * (1 - frac) + this.buf[i + 1] * frac;
        this.frame[this.fill++] = s;
        this.pos += this.ratio;
        if (this.fill >= ${PCM_FRAME_SAMPLES}) {
          const out = new Int16Array(${PCM_FRAME_SAMPLES});
          for (let k = 0; k < ${PCM_FRAME_SAMPLES}; k++) {
            const v = Math.max(-1, Math.min(1, this.frame[k]));
            out[k] = v < 0 ? v * 32768 : v * 32767;
          }
          this.port.postMessage(out.buffer, [out.buffer]);
          this.fill = 0;
        }
      }
      // 消费掉已读区间（保留插值边界 1 样本）
      const consumed = Math.floor(this.pos);
      if (consumed > 0) {
        this.buf = this.buf.slice(consumed);
        this.pos -= consumed;
      }
    }
    return true;
  }
}
registerProcessor("helix-pcm", HelixPcmProcessor);
`;

/** 默认泵工厂：AudioWorklet 主路径；环境缺失/拒绝 → null（流式降级不阻断录音）。
 *  工厂无中途取消面（addModule 在途不可打断）：调用方 await 返回后自查录音态，
 *  已停则 close() 释放——不在工厂内造「await 期间被关」的假分支。 */
export const createWorkletPcmPump: PcmPumpFactory = async (stream: MediaStream): Promise<PcmPump | null> => {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (typeof Ctor === "undefined") return null;
  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    void ctx.close().catch(() => undefined);
    source.disconnect();
  };
  const source = ctx.createMediaStreamSource(stream);
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, "helix-pcm");
    let listener: ((e: MessageEvent) => void) | null = null;
    node.port.onmessage = (e: MessageEvent) => {
      if (listener !== null && !closed) listener(e);
    };
    source.connect(node);
    return {
      onFrame(cb) {
        listener = (e) => cb(e.data as ArrayBuffer);
      },
      close() {
        node.port.onmessage = null;
        node.disconnect();
        teardown();
      },
    };
  } catch {
    teardown();
    return null; // addModule 拒绝等——流式降级（无兜底轮询路径：PCM 抽取无 Analyser 同构面）
  }
};

/** ArrayBuffer（Int16 PCM）→ base64（chunked String.fromCharCode 防栈溢出）。 */
export function pcmFrameToBase64(frame: ArrayBuffer): string {
  const bytes = new Uint8Array(frame);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
