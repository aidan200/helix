import { describe, it, expect, beforeAll } from "bun:test";
import {
  downscaleForContext,
  type DownscaleOutcome,
} from "../../src/application/services/imageDownscale";

/**
 * 图片治理管线 downscaleForContext 单测（图片治理批）。
 *
 * fixture 策略：sharp 现场生成（大 PNG / alpha PNG / 小图 / GIF）——测试自
 * 洽不依赖仓外样本；断言语义（缩到 1536 长边 / 转码 JPEG|WebP / 小图 GIF
 * 直通 null / 坏输入降级 null 不抛）。
 */

let bigPng: Uint8Array; // 1900×1070 无 alpha（模拟 Godot 视口截图分辨率）
let alphaPng: Uint8Array; // 1900×1000 带 alpha
let smallPng: Uint8Array; // 800×600 小图
let gifBytes: Uint8Array; // 最小 GIF 头（无需真动图）

beforeAll(async () => {
  const sharp = (await import("sharp")).default;
  bigPng = new Uint8Array(
    await sharp({ create: { width: 1900, height: 1070, channels: 3, background: "#3a7bd5" } })
      .png()
      .toBuffer(),
  );
  alphaPng = new Uint8Array(
    await sharp({ create: { width: 1900, height: 1000, channels: 4, background: "#ff000080" } })
      .png()
      .toBuffer(),
  );
  smallPng = new Uint8Array(
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#112233" } })
      .png()
      .toBuffer(),
  );
  // 最小合法 GIF（1×1，GIF89a 头 + 结尾块）——管线按 mimeType 短路，不需真动图
  gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
});

describe("downscaleForContext 管线", () => {
  it("T1: 大图（>1536 长边 PNG）→ 缩到 1536 长边并转 JPEG，note 含原始尺寸", async () => {
    const out: DownscaleOutcome | null = await downscaleForContext(bigPng, "image/png");
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.bytes.byteLength).toBeGreaterThan(0);
    expect(out.bytes.byteLength).toBeLessThan(300 * 1024); // 大图缩后 <300KB
    const sharp = (await import("sharp")).default;
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(1536);
    expect(meta.height).toBeLessThanOrEqual(1070);
    expect(out.note).toContain("1900");
    expect(out.note.toLowerCase()).toContain("jpeg");
  });

  it("T2: 小图（≤1536 且 <200KB）→ null 直通", async () => {
    const out = await downscaleForContext(smallPng, "image/png");
    expect(out).toBeNull();
  });

  it("T3: alpha 图 → 转 WebP 保 alpha", async () => {
    const out = await downscaleForContext(alphaPng, "image/png");
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.mimeType).toBe("image/webp");
    const sharp = (await import("sharp")).default;
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(1536);
    expect(meta.hasAlpha).toBe(true);
  });

  it("T4: GIF → null 直通（动图语义不动）", async () => {
    const out = await downscaleForContext(gifBytes, "image/gif");
    expect(out).toBeNull();
  });

  it("T5: 坏字节（非图片数据）→ null 降级不抛", async () => {
    const junk = new Uint8Array(4096).fill(0x41);
    const out = await downscaleForContext(junk, "image/png");
    expect(out).toBeNull();
  });

  it("T6: 长边横向判定——竖长图（高为长边）也缩到 1536 长边", async () => {
    const sharp = (await import("sharp")).default;
    const tall = new Uint8Array(
      await sharp({ create: { width: 900, height: 2000, channels: 3, background: "#654321" } })
        .png()
        .toBuffer(),
    );
    const out = await downscaleForContext(tall, "image/png");
    expect(out).not.toBeNull();
    if (out === null) return;
    const meta = await sharp(out.bytes).metadata();
    expect(meta.height).toBe(1536);
    expect(meta.width).toBeLessThan(900);
  });
});
