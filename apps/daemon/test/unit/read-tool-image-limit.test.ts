import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createReadTool } from "../../src/adapters/driven/tools/read/ReadTool";
import { MAX_IMAGE_BYTES } from "../../src/application/services/images";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";

/**
 * read 图片大小上限（M8 修复红→绿）：detectImageMimeType 命中后不再无条件
 * base64 全量进工具结果——超 MAX_IMAGE_BYTES（2MB，与 BrowserTools.readShot
 * oversize 守卫同上限）回纯文本提示而非 image 块，防大图片一次性注入模型上下文。
 * 另辖 limit<1 鉗制（code-review 低危）：0/负数重接不再产出空结果（首行必含）。
 */

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** 最小合法静态 PNG 头（魔数 + IHDR，无 acTL）+ 零填充到指定字节数。 */
function makePngBytes(size: number): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  return buf;
}

describe("read 图片路径：MAX_IMAGE_BYTES 上限", () => {
  test("超限图片（>2MB）→ 纯文本提示，不产 image 块", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "helix-read-img-limit-"));
    writeFileSync(path.join(dir, "big.png"), makePngBytes(MAX_IMAGE_BYTES + 1));
    const env = new NodeExecutionEnv({ cwd: dir });
    const result = await createReadTool().execute(
      "tc-1",
      { path: "big.png" } as never,
      undefined as never,
      { env },
      undefined as never,
      BACKGROUND_CONTEXT,
    );
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks.every((b) => b.type === "text")).toBe(true);
    expect(blocks.map((b) => b.text ?? "").join("\n")).toContain("超过");
  });

  test("限内图片（≤2MB）→ 照常 image 块（回归面）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "helix-read-img-limit-"));
    writeFileSync(path.join(dir, "small.png"), makePngBytes(64));
    const env = new NodeExecutionEnv({ cwd: dir });
    const result = await createReadTool().execute(
      "tc-1",
      { path: "small.png" } as never,
      undefined as never,
      { env },
      undefined as never,
      BACKGROUND_CONTEXT,
    );
    const blocks = result.content as Array<{ type: string; mimeType?: string }>;
    expect(blocks.some((b) => b.type === "image" && b.mimeType === "image/png")).toBe(true);
  });
});

describe("read 文本路径：limit<1 鉗制为 1（首行必含）", () => {
  test("limit=0 / 负数 → 鉗制为 1 行，不产出空结果", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "helix-read-limit-clamp-"));
    writeFileSync(path.join(dir, "a.txt"), "line1\nline2\nline3\n");
    const env = new NodeExecutionEnv({ cwd: dir });
    for (const limit of [0, -3]) {
      const result = await createReadTool().execute(
        "tc-clamp",
        { path: "a.txt", limit } as never,
        undefined as never,
        { env },
        undefined as never,
        BACKGROUND_CONTEXT,
      );
      const text = (result.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
      expect(text).toContain("     1\tline1");
      expect(text).not.toContain("line2");
      // 续读指针仍指向第 2 行（鉗制不截断后续可达性）
      expect(text).toContain("offset=2");
    }
  });
});
