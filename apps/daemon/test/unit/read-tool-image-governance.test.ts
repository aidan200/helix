import { describe, it, expect, beforeAll } from "bun:test";
import { createReadTool } from "../../src/adapters/driven/tools/read/ReadTool";

/**
 * ReadTool 图片下行治理集成用例（图片治理批）：
 * 大图 read → 降采样 image 块（JPEG + note）；开关关闭 → 原图原样；
 * 降采样后超 2MB 的极端图不再走 oversize 拒绝（守卫顺序 = 降采样后判定）。
 */

let bigPng: Uint8Array; // 1900×1070 PNG（>1536 长边触发管线）

beforeAll(async () => {
  const sharp = (await import("sharp")).default;
  bigPng = new Uint8Array(
    await sharp({ create: { width: 1900, height: 1070, channels: 3, background: "#2c5f8a" } })
      .png()
      .toBuffer(),
  );
});

function makeEnv(bytes: Uint8Array) {
  return {
    absolutePath: async (p: string) => ({ ok: true as const, value: `/abs/${p}` }),
    readBinaryFile: async () => ({ ok: true as const, value: bytes }),
  } as never; // 仅 absolutePath/readBinaryFile 被图片分支消费
}

async function runRead(tool: ReturnType<typeof createReadTool>, enabled?: () => boolean) {
  const t = enabled === undefined ? tool : createReadTool({ isDownscaleEnabled: enabled });
  return t.execute("tc-1", { path: "shot.png" }, () => {}, { env: makeEnv(bigPng) }, undefined as never, undefined as never);
}

describe("ReadTool 图片治理接线", () => {
  it("默认（无注入）= 管线启用：大图 read 返回降采样 JPEG 块 + note", async () => {
    const tool = createReadTool();
    const result = await runRead(tool);
    const blocks = result.content as Array<{ type: string; mimeType?: string; data?: string; text?: string }>;
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/jpeg");
    const text = blocks.find((b) => b.type === "text")?.text ?? "";
    expect(text).toContain("降采样");
    expect(text).toContain("1900");
  });

  it("开关关闭（isDownscaleEnabled → false）→ 原图原样（PNG 原尺寸）", async () => {
    const tool = createReadTool();
    const result = await runRead(tool, () => false);
    const blocks = result.content as Array<{ type: string; mimeType?: string; data?: string; text?: string }>;
    const image = blocks.find((b) => b.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data).toBe(Buffer.from(bigPng).toString("base64"));
  });
});
