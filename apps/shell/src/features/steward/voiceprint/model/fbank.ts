/**
 * fbank —— kaldi fbank 特征复刻（M3-c 声纹批；sherpa-onnx 特征面 TS 移植）。
 *
 * 规格 = sherpa-onnx SpeakerEmbeddingExtractor 侧 kaldi-native-fbank 默认
 * 参数（wespeaker/3d-speaker 模型通用面）：frame 25ms(400)/shift 10ms(160)、
 * snip_edges=false（帧数 = 四舍五入(num_samples/160)、头尾反射填充）、
 * remove_dc_offset、preemph 0.97（倒序）、povey 窗、512 FFT（round_to_power_
 * of_two）、80 mel bins（low 20 / high -400→7600，kaldi mel 刻度、三角无
 * 面积归一、无 vtln）、dither 0、use_log_fbank（log max(eps)）。
 *
 * 数值域：wespeaker_zh_cnceleb_resnet34_LM 模型 normalize_samples=0 →
 * 输入为 Int16 样本原值域（非 [-1,1]）——消费方直接传 Int16 域 Float32Array。
 * 模型无 feature_normalize_type → 不做 global-mean。
 *
 * 验证：与 python sherpa-onnx 官方参考 embedding 对拍三例余弦均 = 1.000000
 * （docs/temp/m3c-sv/proto 对拍记录 + 本文件测试的模型在场对拍用例）。
 */

export const FBANK_SAMPLE_RATE = 16_000;
const FRAME_LENGTH = 400; // 25ms
const FRAME_SHIFT = 160; // 10ms
const NFFT = 512; // round_to_power_of_two(400)
const NUM_BINS = 80;
const LOW_FREQ = 20;
const HIGH_FREQ = -400; // nyquist(8000) - 400 = 7600
const PREEMPH = 0.97;
const EPS = 1.1920929e-7; // numeric_limits<float>::epsilon()

const melScale = (f: number) => 1127 * Math.log(1 + f / 700);

/** povey 窗：pow(0.5 - 0.5*cos(2πi/(N-1)), 0.85)。 */
function poveyWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  const a = (2 * Math.PI) / (n - 1);
  for (let i = 0; i < n; i++) w[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  return w;
}

interface MelBin {
  offset: number;
  weights: Float64Array;
}

/** kaldi mel 滤波器组（三角、无面积归一、无 vtln）。 */
function kaldiMelBanks(numFftBins: number): MelBin[] {
  const nyquist = 0.5 * FBANK_SAMPLE_RATE;
  const highFreq = HIGH_FREQ > 0 ? HIGH_FREQ : nyquist + HIGH_FREQ;
  const fftBinWidth = FBANK_SAMPLE_RATE / NFFT;
  const melLow = melScale(LOW_FREQ);
  const melHigh = melScale(highFreq);
  const melFreqDelta = (melHigh - melLow) / (NUM_BINS + 1);
  const bins: MelBin[] = [];
  for (let b = 0; b < NUM_BINS; b++) {
    const leftMel = melLow + b * melFreqDelta;
    const centerMel = melLow + (b + 1) * melFreqDelta;
    const rightMel = melLow + (b + 2) * melFreqDelta;
    const thisBin = new Float64Array(numFftBins);
    let first = -1;
    let last = -1;
    for (let i = 0; i < numFftBins; i++) {
      const mel = melScale(fftBinWidth * i);
      if (mel > leftMel && mel < rightMel) {
        const weight = mel <= centerMel ? (mel - leftMel) / (centerMel - leftMel) : (rightMel - mel) / (rightMel - centerMel);
        thisBin[i] = weight;
        if (first === -1) first = i;
        last = i;
      }
    }
    bins.push({ offset: first, weights: thisBin.slice(first, last + 1) });
  }
  return bins;
}

/** 就地 radix-2 复 FFT（迭代位反转；n 为 2 的幂）。 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const rTmp = re[i]!;
      re[i] = re[j]!;
      re[j] = rTmp;
      const iTmp = im[i]!;
      im[i] = im[j]!;
      im[j] = iTmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + half]! * curRe - im[i + k + half]! * curIm;
        const vIm = re[i + k + half]! * curIm + im[i + k + half]! * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextCurRe;
      }
    }
  }
}

/** snip_edges=false 的帧起点（FirstSampleOfFrame）。 */
function firstSampleOfFrame(frame: number): number {
  const midpoint = FRAME_SHIFT * frame + FRAME_SHIFT / 2;
  return midpoint - FRAME_LENGTH / 2;
}

/** flush 帧数（snip_edges=false：四舍五入到最近帧）。 */
export function fbankNumFrames(numSamples: number): number {
  return Math.floor((numSamples + FRAME_SHIFT / 2) / FRAME_SHIFT);
}

const WINDOW = poveyWindow(FRAME_LENGTH);
const MEL_BANKS = kaldiMelBanks(NFFT / 2);

/**
 * 整段（flush 语义）计算 fbank。samples 为 Int16 域数值（Float32Array）。
 * 返回展平 [T][80]（row-major）。
 */
export function computeFbank(samples: Float32Array): Float32Array {
  const T = fbankNumFrames(samples.length);
  const out = new Float32Array(T * NUM_BINS);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const frame = new Float64Array(FRAME_LENGTH);
  for (let f = 0; f < T; f++) {
    const start = firstSampleOfFrame(f);
    // ExtractWindow：头尾反射填充
    for (let s = 0; s < FRAME_LENGTH; s++) {
      let idx = s + start;
      while (idx < 0 || idx >= samples.length) {
        if (idx < 0) idx = -idx - 1;
        else idx = 2 * samples.length - 1 - idx;
      }
      frame[s] = samples[idx]!;
    }
    // remove_dc_offset
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) mean += frame[i]!;
    mean /= FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) frame[i] = frame[i]! - mean;
    // preemphasize（倒序；d[0] -= coeff*d[0]）
    for (let i = FRAME_LENGTH - 1; i > 0; i--) frame[i] = frame[i]! - PREEMPH * frame[i - 1]!;
    frame[0] = frame[0]! - PREEMPH * frame[0]!;
    // povey 窗 + zero-pad 到 512 → FFT → power spectrum(0..256) → mel + log
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FRAME_LENGTH; i++) re[i] = frame[i]! * WINDOW[i]!;
    fftInPlace(re, im);
    const power = new Float64Array(NFFT / 2 + 1);
    power[0] = re[0]! * re[0]!;
    power[NFFT / 2] = re[NFFT / 2]! * re[NFFT / 2]!;
    for (let i = 1; i < NFFT / 2; i++) power[i] = re[i]! * re[i]! + im[i]! * im[i]!;
    for (let b = 0; b < NUM_BINS; b++) {
      const { offset, weights } = MEL_BANKS[b]!;
      let energy = 0;
      for (let i = 0; i < weights.length; i++) energy += power[offset + i]! * weights[i]!;
      out[f * NUM_BINS + b] = Math.log(Math.max(energy, EPS));
    }
  }
  return out;
}
