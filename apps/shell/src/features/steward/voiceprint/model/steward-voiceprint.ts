/**
 * steward-voiceprint —— 声纹域组合根（M3-c 声纹批）。
 *
 * 生产单例：localStorage 模板存储 + wasm 引擎加载器（**动态 import**
 * embed-engine——onnxruntime-web bundle chunk 按需加载，主包零膨胀；
 * 26.5MB 模型经 IndexedDB 缓存后离线可用）。测试方（Layer/设置页）经
 * props/service 注入假实现，不触本单例。
 */
import { createVoiceprintService, type VoiceprintService } from "./voiceprint-service";
import { createLocalVoiceprintStore } from "./voiceprint-store";
import type { VerifyDecision } from "./voiceprint-service";

let shared: VoiceprintService | null = null;

/** 生产单例（Layer 与设置页共用——引擎单飞与模板一致性）。 */
export function getStewardVoiceprintService(): VoiceprintService {
  if (shared === null) {
    shared = createVoiceprintService({
      store: createLocalVoiceprintStore(globalThis.localStorage),
      engineLoader: async () => {
        const { createWasmEmbedEngineLoader } = await import("./embed-engine");
        return createWasmEmbedEngineLoader()();
      },
    });
  }
  return shared;
}

/** 授权点消费的窄面（StewardVoiceLayer 只需要 gate——测试注入假 gate）。 */
export interface VoiceprintGate {
  verifyGate(pcm: Float32Array | null): Promise<VerifyDecision>;
}
