/**
 * 图片压缩配置域（图片治理批）：KV 单键 `image_config` 全量态 JSON——
 * 语义单源本文件（键常量/默认值/解析），ImageConfigStore（adapters，
 * makeKvConfigStore 骨架）只做薄壳，E-274（voice_model_config）同构。
 *
 * 默认 downscaleEnabled = true（治理默认生效；设置页可关）。
 */

/** KV 键名（全仓单源）。 */
export const IMAGE_CONFIG_KEY = "image_config";

/** 配置域值形态。 */
export interface ImageConfigState {
  /** 工具下行图片压缩开关（read 读图 / browser 截图管线总闸）。 */
  readonly downscaleEnabled: boolean;
}

/** 默认值：治理默认开。 */
export const DEFAULT_IMAGE_CONFIG: ImageConfigState = { downscaleEnabled: true };

/**
 * KV 原值 → 域值：未配置/坏 JSON/形状不符（含类型错/数组/原始值）→ undefined
 * （Store 保持最近已知值——makeKvConfigStore 契约）。
 */
export function parseImageConfig(raw: string | undefined): ImageConfigState | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  if (typeof o.downscaleEnabled !== "boolean") return undefined;
  return { downscaleEnabled: o.downscaleEnabled };
}
