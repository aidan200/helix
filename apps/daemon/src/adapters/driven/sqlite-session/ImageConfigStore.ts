import type { ImageConfigPort } from "../../../application/ports/outbound/ImageConfigPort";
import type { ImageConfigState } from "../../../application/services/imageConfig";
import { DEFAULT_IMAGE_CONFIG, IMAGE_CONFIG_KEY, parseImageConfig } from "../../../application/services/imageConfig";
import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import { makeKvConfigStore } from "./KvConfigStore";

/**
 * 分层口径（低危批备案，TR-13 张力面）：本文件的 application import 指向
 * **纯函数 + 键常量单源**（ImageConfigStore = application/services/imageConfig，
 * VoiceModelConfigStore 同构），不是服务——键位/解析/合并判据全仓只允许
 * 一份，各处复制键常量即制造双源。口径：驱动适配器可 import application 的
 * 纯常量/纯函数单元，禁 import 带依赖构造的服务类（越界即以端口/domain
 * 落位替代）。机械守护见 test/unit/adapter-layer-pure-imports.test.ts。
 */
/**
 * 图片压缩配置 store（KV 单键 `image_config` 全量态 JSON；
 * VoiceModelConfigStore / CompactionConfigStore 同构，makeKvConfigStore 骨架）。
 *
 * 语义单源 = application/services/imageConfig.ts（键常量/默认值/解析）。
 */
export class ImageConfigStore implements ImageConfigPort {
  private readonly store: ReturnType<typeof makeKvConfigStore<ImageConfigState>>;

  constructor(runtimeConfig: RuntimeConfigPort) {
    this.store = makeKvConfigStore<ImageConfigState>(runtimeConfig, {
      key: IMAGE_CONFIG_KEY,
      parse: parseImageConfig,
      fallback: DEFAULT_IMAGE_CONFIG,
      clone: (v) => ({ ...v }),
      serialize: (v) => JSON.stringify(v),
      warnLabel: "ImageConfigStore",
    });
  }

  /** 当前生效配置（KV 不可用 → 最近已知值；初值 = 默认开）。 */
  current(): ImageConfigState {
    return this.store.current();
  }

  /** 写入（单写通道，落盘完成即返回；回读新现态）。 */
  async set(next: ImageConfigState): Promise<ImageConfigState> {
    await this.store.set(next);
    return this.store.current();
  }
}
