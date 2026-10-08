import type { VoiceModelConfigPort } from "../../../application/ports/outbound/VoiceModelConfigPort";
import type {
  VoiceModelConfigPatch,
  VoiceModelConfigState,
} from "../../../application/voice/voiceModelConfig";
import {
  DEFAULT_VOICE_MODEL_CONFIG,
  applyVoiceModelPatch,
  parseVoiceModelConfig,
} from "../../../application/voice/voiceModelConfig";
import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import { makeKvConfigStore } from "./KvConfigStore";

/**
 * 语音模型配置 store（KV 单键 `voice_model_config` 全量态 JSON；
 * CompactionConfigStore 同构，makeKvConfigStore 骨架）。
 *
 * 语义单源 = application/voice/voiceModelConfig.ts（默认值/解析/部分更新合并）；
 * set 语义 = 携带项写入 + 空串回落默认（applyVoiceModelPatch 单点）。
 */
export class VoiceModelConfigStore implements VoiceModelConfigPort {
  private readonly store: ReturnType<typeof makeKvConfigStore<VoiceModelConfigState>>;

  constructor(runtimeConfig: RuntimeConfigPort, fallback: VoiceModelConfigState = DEFAULT_VOICE_MODEL_CONFIG) {
    this.store = makeKvConfigStore<VoiceModelConfigState>(runtimeConfig, {
      key: "voice_model_config",
      parse: parseVoiceModelConfig,
      fallback,
      clone: (v) => ({ ...v }),
      serialize: (v) => JSON.stringify(v),
      warnLabel: "VoiceModelConfigStore",
    });
  }

  /** 当前生效配置（KV 不可用 → 最近已知值；初值 = 默认值）。 */
  current(): VoiceModelConfigState {
    return this.store.current();
  }

  /** 部分更新写入（单写通道，落盘完成即返回；回读新现态）。 */
  async set(patch: VoiceModelConfigPatch): Promise<VoiceModelConfigState> {
    const next = applyVoiceModelPatch(this.store.current(), patch);
    await this.store.set(next);
    return next;
  }
}
