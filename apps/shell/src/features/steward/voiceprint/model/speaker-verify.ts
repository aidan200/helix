/**
 * speaker-verify —— 声纹校验纯函数域（M3-c 声纹批，AG-14 零 React 零 IO）。
 *
 * 三件：余弦相似度、模板合成（句向量均值 + L2 归一——单主人单模板）、
 * 阈值判定（pass / reject(score)）。skip 三态（未注册/引擎失败/推理抛错/
 * 音频过短）归 service 层（voiceprint-service.ts——本层只做数学）。
 *
 * 阈值口径：wespeaker resnet34（CN-Celeb）实测同人两句 cos≈0.83、异人
 * cos≈0.42（docs/temp/m3c-sv/research.md）；0.55 取分离带中点偏保守——
 * 短确认口令（<1.5s）同人相似度会低于注册长句，阈值过高误拒主人代价
 * 大于放过（授权点还有语义口令词表前置门）。注册页测试按钮实时展示
 * 得分供用户自校准。
 */

/** 判定阈值（余弦相似度 >= 此值 = 主人）。 */
export const VOICEPRINT_MATCH_THRESHOLD = 0.55;

/** 注册最少句数（brief：说 3-5 句话生成模板）。 */
export const VOICEPRINT_MIN_UTTERANCES = 3;

/** 注册最多句数。 */
export const VOICEPRINT_MAX_UTTERANCES = 5;

/** 注册单句最短有效语音（秒；不足拒绝注册）。 */
export const VOICEPRINT_MIN_UTTERANCE_SECONDS = 1.2;

/** 校验音频最短长度（秒；授权点选取段不足 → skip audio-too-short）。 */
export const VERIFY_MIN_SECONDS = 0.4;

/** 声纹模板（单主人单模板：句向量均值 + L2 归一）。 */
export interface VoiceprintTemplate {
  readonly dim: number;
  readonly vector: Float32Array;
  /** 注册句数（3-5）。 */
  readonly utterances: number;
  /** 注册时间（epoch ms）。 */
  readonly createdAt: number;
}

/** 余弦相似度（零向量防御 → 0）。 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 句向量列表 → 模板（均值 + L2 归一；空列表/零均值向量防御：首句方向）。 */
export function synthesizeTemplate(vectors: readonly Float32Array[], now: number = Date.now()): VoiceprintTemplate {
  if (vectors.length === 0) throw new Error("synthesizeTemplate: empty input");
  const dim = vectors[0]!.length;
  const mean = new Float64Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) throw new Error("synthesizeTemplate: dim mismatch");
    for (let i = 0; i < dim; i++) mean[i] = mean[i]! + v[i]!;
  }
  for (let i = 0; i < dim; i++) mean[i] = mean[i]! / vectors.length;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += mean[i]! * mean[i]!;
  norm = Math.sqrt(norm);
  const vector = new Float32Array(dim);
  if (norm === 0) {
    vector[0] = 1; // 病态输入防御（全零均值）：单位基向量占位
  } else {
    for (let i = 0; i < dim; i++) vector[i] = mean[i]! / norm;
  }
  return { dim, vector, utterances: vectors.length, createdAt: now };
}

/** 模板 → 句向量域回读投影（测试/日志用；同构拷贝）。 */
export function utteranceVectorsOf(t: VoiceprintTemplate): Float32Array {
  return new Float32Array(t.vector);
}

/** 阈值判定：>= 阈值 pass；< 阈值 reject（带 score）。 */
export function decideVerify(score: number): { kind: "pass" } | { kind: "reject"; score: number } {
  if (score >= VOICEPRINT_MATCH_THRESHOLD) return { kind: "pass" };
  return { kind: "reject", score };
}
