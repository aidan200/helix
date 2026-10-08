/**
 * voiceprint-store —— 声纹模板存储 port（M3-c 声纹批）。
 *
 * 生产形态 = localStorage（本机 WKWebView 应用数据区，单模板单主人，键
 * helix.steward.voiceprint；明文 JSON：dim/vector/vectors/utterances/createdAt
 * ——模板是 256 维 float ≈ 5KB（含逐句槽位明细），非音频非原文，删除即
 * 彻底移除）。测试注入内存实现（createMemoryVoiceprintStore）。
 */
import type { VoiceprintTemplate } from "./speaker-verify";

/** 存储键（单模板单主人）。 */
export const VOICEPRINT_STORE_KEY = "helix.steward.voiceprint";

/** 模板存储 port（read/write/remove）。 */
export interface VoiceprintStore {
  read(): VoiceprintTemplate | null;
  write(template: VoiceprintTemplate): void;
  remove(): void;
}

/** localStorage 实现（生产）。 */
export function createLocalVoiceprintStore(storage: Storage): VoiceprintStore {
  return {
    read() {
      const raw = storage.getItem(VOICEPRINT_STORE_KEY);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as {
          dim: number;
          vector: number[];
          vectors?: number[][];
          utterances: number;
          createdAt: number;
        };
        if (
          typeof parsed.dim !== "number" ||
          !Array.isArray(parsed.vector) ||
          parsed.vector.length !== parsed.dim ||
          typeof parsed.utterances !== "number" ||
          typeof parsed.createdAt !== "number"
        ) {
          return null; // 病态数据按未注册处理（授权链零劣化）
        }
        // 逐句向量（槽位明细）：缺失/病态回读为空数组（旧版模板——校验照旧
        // 走均值向量，单槽编辑不可用）。
        const vectors: Float32Array[] = [];
        if (Array.isArray(parsed.vectors)) {
          for (const v of parsed.vectors) {
            if (!Array.isArray(v) || v.length !== parsed.dim) return null; // 明细病态整份拒收
            vectors.push(new Float32Array(v));
          }
        }
        return {
          dim: parsed.dim,
          vector: new Float32Array(parsed.vector),
          vectors,
          utterances: parsed.utterances,
          createdAt: parsed.createdAt,
        };
      } catch {
        return null;
      }
    },
    write(template: VoiceprintTemplate) {
      const raw = JSON.stringify({
        dim: template.dim,
        vector: Array.from(template.vector),
        vectors: template.vectors.map((v) => Array.from(v)),
        utterances: template.utterances,
        createdAt: template.createdAt,
      });
      storage.setItem(VOICEPRINT_STORE_KEY, raw);
    },
    remove() {
      storage.removeItem(VOICEPRINT_STORE_KEY);
    },
  };
}

/** 内存实现（测试）。 */
export function createMemoryVoiceprintStore(): VoiceprintStore {
  let held: VoiceprintTemplate | null = null;
  return {
    read: () => held,
    write: (t) => {
      held = t;
    },
    remove: () => {
      held = null;
    },
  };
}
