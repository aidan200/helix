import { describe, it, expect } from "bun:test";
import {
  IMAGE_CONFIG_KEY,
  DEFAULT_IMAGE_CONFIG,
  parseImageConfig,
} from "../../src/application/services/imageConfig";

/** 图片压缩配置域单键语义单源测试（image_config，E-274 同构）。 */

describe("imageConfig 纯函数", () => {
  it("键名与默认值：downscaleEnabled 默认 true（治理默认生效）", () => {
    expect(IMAGE_CONFIG_KEY).toBe("image_config");
    expect(DEFAULT_IMAGE_CONFIG.downscaleEnabled).toBe(true);
  });

  it("parse：合法 JSON → 域值", () => {
    expect(parseImageConfig(JSON.stringify({ downscaleEnabled: false }))).toEqual({
      downscaleEnabled: false,
    });
    expect(parseImageConfig(JSON.stringify({ downscaleEnabled: true }))).toEqual({
      downscaleEnabled: true,
    });
  });

  it("parse：未配置/坏 JSON/形状不符 → undefined（Store 保持最近已知值）", () => {
    expect(parseImageConfig(undefined)).toBeUndefined();
    expect(parseImageConfig("not json")).toBeUndefined();
    expect(parseImageConfig(JSON.stringify({ unrelated: 1 }))).toBeUndefined();
    expect(parseImageConfig(JSON.stringify({ downscaleEnabled: "yes" }))).toBeUndefined();
  });

  it("parse：负向形状（数组/字符串/null）→ undefined", () => {
    expect(parseImageConfig("[]")).toBeUndefined();
    expect(parseImageConfig("null")).toBeUndefined();
    expect(parseImageConfig('"text"')).toBeUndefined();
  });
});
