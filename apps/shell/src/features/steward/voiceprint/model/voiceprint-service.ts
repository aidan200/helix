/**
 * voiceprint-service —— 声纹校验应用服务（M3-c 声纹批）。
 *
 * 契约面（授权点消费方只认 verifyGate 三态）：
 * - pass：是主人 → 消费卡放行；
 * - reject(score)：不是主人 → 拒绝消费 + 语音明示（卡保留——拒绝不是
 *   cancel，等用户重说或 TTL；E-204 语义）；
 * - skip(reason)：未注册/引擎不可用/推理抛错/音频过短 → 照旧放行（E-250
 *   判官拆面降级纪律同构：授权链零劣化，WARN 日志不留静默）。
 *
 * 引擎注入（EmbedEngine port——生产 = wasm ort-web 懒加载，测试 = 假
 * 引擎）；模板存储注入（VoiceprintStore port）。
 */
import {
  SAMPLES_PER_SECOND,
  VOICEPRINT_MATCH_THRESHOLD,
  VOICEPRINT_MAX_UTTERANCES,
  VOICEPRINT_MIN_UTTERANCE_SECONDS,
  VOICEPRINT_MIN_UTTERANCES,
  VERIFY_MIN_SECONDS,
  cosineSimilarity,
  decideVerify,
  synthesizeTemplate,
  type VoiceprintTemplate,
} from "./speaker-verify";
import type { VoiceprintStore } from "./voiceprint-store";

/** 推理引擎 port（samples = Int16 域 Float32Array，16k mono）。 */
export interface EmbedEngine {
  embed(samples: Float32Array): Promise<Float32Array>;
}

/** 引擎加载器（懒加载：下载/缓存/初始化一次性；失败 reject）。 */
export type EmbedEngineLoader = () => Promise<EmbedEngine>;

/** skip 原因（全部照旧放行）。 */
export type VerifySkipReason = "unregistered" | "engine-unavailable" | "inference-error" | "audio-too-short";

/** verifyGate 判定三态。 */
export type VerifyDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "reject"; readonly score: number }
  | { readonly kind: "skip"; readonly reason: VerifySkipReason };

export interface VoiceprintServiceOptions {
  readonly engineLoader: EmbedEngineLoader;
  readonly store: VoiceprintStore;
  /** 阈值读取（缺省 = VOICEPRINT_MATCH_THRESHOLD；设置页滑杆热改后
   *  verifyGate 每次现读——调参即时生效零重建服务）。 */
  readonly threshold?: () => number;
  /** WARN 出口（缺省 console.warn；测试断言）。 */
  readonly warn?: (message: string) => void;
}

/** 注册/校验错误码（model 层零 CJK——UI 层映射 i18n 白话）。 */
export type VoiceprintErrorCode =
  | "min-utterances"
  | "max-utterances"
  | "utterance-too-short"
  | "not-registered"
  | "slots-unavailable"
  | "slot-range";

/** 结构化错误（code 供 UI 映射；detail 附带句号等上下文）。 */
export class VoiceprintError extends Error {
  readonly code: VoiceprintErrorCode;
  readonly which?: number;
  constructor(code: VoiceprintErrorCode, which?: number) {
    super(which === undefined ? code : `${code}:${which}`);
    this.code = code;
    this.which = which;
  }
}

export function createVoiceprintService(options: VoiceprintServiceOptions) {
  const { engineLoader, store } = options;
  const warn = options.warn ?? ((message: string) => console.warn(`[voiceprint] ${message}`));
  const thresholdOf = options.threshold ?? (() => VOICEPRINT_MATCH_THRESHOLD);
  let enginePromise: Promise<EmbedEngine> | null = null;

  const loadEngine = (): Promise<EmbedEngine> => {
    if (enginePromise === null) enginePromise = engineLoader();
    return enginePromise;
  };

  return {
    /** 是否已注册（模板在场）。 */
    isRegistered(): boolean {
      return store.read() !== null;
    },

    /** 模板现值（UI 槽位渲染/测试判定用；未注册 = null）。 */
    getTemplate(): VoiceprintTemplate | null {
      return store.read();
    },

    /**
     * 注册（3-5 句 → 模板 = 句向量均值 + L2 归一）。句数/句长不达标
     * 拒绝（Error.message 白话给注册 UI 直读）。
     */
    async register(utterances: readonly Float32Array[]): Promise<VoiceprintTemplate> {
      if (utterances.length < VOICEPRINT_MIN_UTTERANCES) {
        throw new VoiceprintError("min-utterances");
      }
      if (utterances.length > VOICEPRINT_MAX_UTTERANCES) {
        throw new VoiceprintError("max-utterances");
      }
      const minLength = VOICEPRINT_MIN_UTTERANCE_SECONDS * SAMPLES_PER_SECOND;
      for (let i = 0; i < utterances.length; i++) {
        if (utterances[i]!.length < minLength) {
          throw new VoiceprintError("utterance-too-short", i + 1);
        }
      }
      const engine = await loadEngine();
      const vectors: Float32Array[] = [];
      for (const pcm of utterances) vectors.push(await engine.embed(pcm));
      const template = synthesizeTemplate(vectors);
      store.write(template);
      return template;
    },

    /** 测试（注册页测试按钮）：一句 → 与模板实时相似度得分。 */
    async test(pcm: Float32Array): Promise<number> {
      const template = store.read();
      if (template === null) throw new VoiceprintError("not-registered");
      const engine = await loadEngine();
      const emb = await engine.embed(pcm);
      return cosineSimilarity(template.vector, emb);
    },

    /** 删除（彻底移除模板——回到未注册形态）。 */
    remove(): void {
      store.remove();
    },

    /**
     * 单槽录入（槽位编辑——已注册模板的逐句重录/补录）。槽位序 = 逐句
     * 向量序：index < 现句数 = 重录该槽；index === 现句数 = 补录末槽；
     * 其余越界拒（slot-range）。每次变更句向量重合成落盘（均值口径不变）。
     * 旧版模板（无逐句明细）拒（slots-unavailable——引导整份重注册）。
     */
    async recordSlot(index: number, pcm: Float32Array): Promise<VoiceprintTemplate> {
      const template = store.read();
      if (template === null) throw new VoiceprintError("not-registered");
      if (template.vectors.length === 0) throw new VoiceprintError("slots-unavailable");
      if (!Number.isInteger(index) || index < 0 || index > template.vectors.length) {
        throw new VoiceprintError("slot-range");
      }
      if (index >= VOICEPRINT_MAX_UTTERANCES) throw new VoiceprintError("max-utterances");
      const minLength = VOICEPRINT_MIN_UTTERANCE_SECONDS * SAMPLES_PER_SECOND;
      if (pcm.length < minLength) throw new VoiceprintError("utterance-too-short", index + 1);
      const engine = await loadEngine();
      const emb = await engine.embed(pcm);
      const vectors = template.vectors.map((v) => new Float32Array(v));
      const embCopy = new Float32Array(emb); // ArrayBuffer 域拷贝（泛型对齐 + 防外部底座变异）
      if (index === vectors.length) vectors.push(embCopy);
      else vectors[index] = embCopy;
      const next = synthesizeTemplate(vectors);
      store.write(next);
      return next;
    },

    /**
     * 单槽删除（逐句向量移除后重合成）。保底句数 3（min-utterances）
     * ——模板保底信噪比，不够就整份重录。
     */
    async deleteSlot(index: number): Promise<VoiceprintTemplate> {
      const template = store.read();
      if (template === null) throw new VoiceprintError("not-registered");
      if (template.vectors.length === 0) throw new VoiceprintError("slots-unavailable");
      if (!Number.isInteger(index) || index < 0 || index >= template.vectors.length) {
        throw new VoiceprintError("slot-range");
      }
      if (template.vectors.length <= VOICEPRINT_MIN_UTTERANCES) throw new VoiceprintError("min-utterances");
      const vectors = template.vectors.filter((_, i) => i !== index).map((v) => new Float32Array(v));
      const next = synthesizeTemplate(vectors);
      store.write(next);
      return next;
    },

    /** 模板预载（app 启动/注册完成后后台预热引擎，授权点零等待）。 */
    warmup(): void {
      if (store.read() === null) return;
      loadEngine().catch((e: unknown) => warn(`engine warmup failed (verify gate will skip): ${String(e)}`));
    },

    /**
     * 授权点校验门（确认口令消费卡前）。同步顺序：未注册（零引擎调用）
     * → 音频过短 → 引擎加载失败（WARN）→ 推理抛错（WARN）→ 阈值判定。
     */
    async verifyGate(pcm: Float32Array | null): Promise<VerifyDecision> {
      const template = store.read();
      if (template === null) return { kind: "skip", reason: "unregistered" };
      if (pcm === null || pcm.length < VERIFY_MIN_SECONDS * SAMPLES_PER_SECOND) {
        return { kind: "skip", reason: "audio-too-short" };
      }
      let engine: EmbedEngine;
      try {
        engine = await loadEngine();
      } catch (e) {
        warn(`engine unavailable (voiceprint skipped): ${String(e)}`);
        return { kind: "skip", reason: "engine-unavailable" };
      }
      let emb: Float32Array;
      try {
        emb = await engine.embed(pcm);
      } catch (e) {
        warn(`inference failed (voiceprint skipped): ${String(e)}`);
        return { kind: "skip", reason: "inference-error" };
      }
      const score = cosineSimilarity(template.vector, emb);
      return decideVerify(score, thresholdOf());
    },
  };
}

export type VoiceprintService = ReturnType<typeof createVoiceprintService>;
