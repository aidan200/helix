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
 * 分层口径（低危批备案，TR-13 张力面）：本文件的 application import 指向
 * **纯函数 + 键常量单源**（KgConfigStore = application/services/kg/kgConfig，
 * SummaryConfigStore = application/summary/summaryConfig，
 * VoiceModelConfigStore = application/voice/voiceModelConfig），不是服务——
 * 键位/解析/合并判据全仓只允许一份，端口层（port 文件）目前不承载纯函数，
 * 各处复制键常量即制造双源。口径：驱动适配器可 import application 的纯常量/
 * 纯函数单元，禁 import 带依赖构造的服务类（越界即以端口/domain 落位替代）。
 * 机械守护见 test/unit/adapter-layer-pure-imports.test.ts。
 */
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
