import type { ImageGenConfigPort, ImageGenConfigPatch, ImageGenConfigState } from "../../../application/ports/outbound/ImageGenConfigPort";
import {
  DEFAULT_IMAGE_GEN_CONFIG,
  applyImageGenPatch,
  parseImageGenConfig,
} from "../../../application/services/imagegen/imagegenConfig";
import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import { makeKvConfigStore } from "./KvConfigStore";

/**
 * 生图渠道配置 store（KV 单键 `imagegen_config` 全量态 JSON；
 * VoiceModelConfigStore 同构，makeKvConfigStore 骨架）。
 *
 * 语义单源 = application/services/imagegen/imagegenConfig.ts（默认值/解析/
 * 部分更新合并）；set 语义 = 携带项写入 + 空串回落自动/默认。
 */
export class ImageGenConfigStore implements ImageGenConfigPort {
  private readonly store: ReturnType<typeof makeKvConfigStore<ImageGenConfigState>>;

  constructor(runtimeConfig: RuntimeConfigPort, fallback: ImageGenConfigState = DEFAULT_IMAGE_GEN_CONFIG) {
    this.store = makeKvConfigStore<ImageGenConfigState>(runtimeConfig, {
      key: "imagegen_config",
      parse: parseImageGenConfig,
      fallback,
      clone: (v) => ({ ...v }),
      serialize: (v) => JSON.stringify(v),
      warnLabel: "ImageGenConfigStore",
    });
  }

  /** 当前生效配置（KV 不可用 → 最近已知值；初值 = 默认值）。 */
  current(): ImageGenConfigState {
    return this.store.current();
  }

  /** 部分更新写入（单写通道，落盘完成即返回；回读新现态）。 */
  async set(patch: ImageGenConfigPatch): Promise<ImageGenConfigState> {
    const next = applyImageGenPatch(this.store.current(), patch);
    await this.store.set(next);
    return next;
  }
}
