/**
 * pcm-ring —— 授权点音频环（M3-c 声纹批）。
 *
 * 职责：光球会话期间滚动保存最近 PCM_RING_SECONDS 秒麦克风帧（16k mono
 * Int16，100ms/帧——pcm-pump 同规格），final 转写定稿时（授权点）从尾部
 * 回溯选取「本句话」的语音段（STT 回执延迟期间新进帧多为静音，从尾部
 * 找最后一段连续有声帧即本句）。
 *
 * 纯函数 selectUtterancePcm：尾部静音跳过（找最后有声帧）→ 从该帧往头
 * 扩展到静音边界（连续 SILENCE_BREAK 帧低于门限即断）→ 头端补 LEAD_PAD
 * 帧边距 → 段长上限截断（保留最近）。段长下限判定归 verifyGate
 * （audio-too-short）。环 clear 在 duplex 收口（跨会话旧音频不得被算进
 * 新会话第一句）。
 */

/** 环容量（秒；8s = 80 帧 × 3200B = 256KB 内存）。 */
export const PCM_RING_SECONDS = 8;

/** 每帧时长（ms；pcm-pump 100ms/帧同规格）。 */
export const PCM_FRAME_MS = 100;

/** 帧数每秒（16k/100ms）。 */
const FRAMES_PER_SECOND = 1000 / PCM_FRAME_MS;

/** 语音段最大时长（秒；超长从头部截断保留最近）。 */
export const UTTERANCE_MAX_SECONDS = 6;

/** 静音判定门限（Int16 域 RMS；float 域 0.02 × 32768 同源——voice-gate 口径）。 */
export const PCM_RMS_GATE = 655;

/** 连续多少帧低于门限视为语音段头端边界。 */
const SILENCE_BREAK_FRAMES = 8; // 0.8s

/** 段头静音边距（帧；保留少量起音边距防截头）。 */
const LEAD_PAD_FRAMES = 2;

/** 环内帧（samples = 1600 Int16；rms 预计算）。 */
export interface PcmRingFrame {
  readonly samples: Int16Array;
  readonly rms: number;
}

/** 帧能量（Int16 域 RMS）。 */
export function frameRms(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** 尾部语音段选取（纯函数；null = 无语音可用）。 */
export function selectUtterancePcm(frames: readonly PcmRingFrame[]): Float32Array | null {
  // 1. 从尾往头找最后一个有声帧（全部低于门限 → null）
  let lastLoud = -1;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.rms >= PCM_RMS_GATE) {
      lastLoud = i;
      break;
    }
  }
  if (lastLoud === -1) return null;
  // 2. 从 lastLoud 往头扩展：连续 SILENCE_BREAK_FRAMES 帧低于门限即断
  //    （静音帧照收——尾部边距自然保留在段内）
  let start = lastLoud;
  let silenceRun = 0;
  for (let i = lastLoud - 1; i >= 0; i--) {
    if (frames[i]!.rms >= PCM_RMS_GATE) {
      silenceRun = 0;
      start = i;
    } else {
      silenceRun += 1;
      if (silenceRun >= SILENCE_BREAK_FRAMES) break;
    }
  }
  // 3. 头端静音边距（多收 LEAD_PAD_FRAMES，截环头不越界）
  start = Math.max(0, start - LEAD_PAD_FRAMES);
  // 4. 段长上限（保留最近 UTTERANCE_MAX_SECONDS）
  const maxFrames = UTTERANCE_MAX_SECONDS * FRAMES_PER_SECOND;
  const end = lastLoud + 1; // 不含
  const frameCount = end - start;
  if (frameCount <= 0) return null;
  const clippedStart = frameCount > maxFrames ? end - maxFrames : start;
  // 5. 拼接（Int16 域 Float32Array——模型 normalize_samples=0 口径）
  const from = frames[clippedStart]!;
  const total = (end - clippedStart) * from.samples.length;
  const out = new Float32Array(total);
  let at = 0;
  for (let i = clippedStart; i < end; i++) {
    const s = frames[i]!.samples;
    for (let k = 0; k < s.length; k++) out[at++] = s[k]!;
  }
  return out;
}

/** 授权点音频环（push 不消费；takeUtterance 可重复取）。 */
export interface PcmRing {
  /** 帧入环（pcm-pump ArrayBuffer 形态，1600 Int16）。 */
  push(frame: ArrayBuffer): void;
  /** 取尾部语音段（null = 无语音/环空；不消费）。 */
  takeUtterance(): Float32Array | null;
  /** 清空（duplex 收口——跨会话旧音频不得泄入新会话）。 */
  clear(): void;
}

/** 建环（容量 PCM_RING_SECONDS 秒，FIFO 淘汰最旧）。 */
export function createPcmRing(capacitySeconds: number = PCM_RING_SECONDS): PcmRing {
  const capacity = Math.round(capacitySeconds * FRAMES_PER_SECOND);
  const frames: PcmRingFrame[] = [];
  return {
    push(frame: ArrayBuffer) {
      if (frame.byteLength < 2 || frame.byteLength % 2 !== 0) return; // 病态帧防御（测试 fake/异构泵）
      const samples = new Int16Array(frame);
      frames.push({ samples, rms: frameRms(samples) });
      while (frames.length > capacity) frames.shift();
    },
    takeUtterance() {
      return selectUtterancePcm(frames);
    },
    clear() {
      frames.length = 0;
    },
  };
}
