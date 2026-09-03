import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, writeConfig } from "../../src/infrastructure/config";

/**
 * T2.1（U，config 面）：config.json 新键 `codegraphPath`（codegraph 二级
 * 解析第②级，AF-2 裁决）——与 rgPath 完全同口径：
 * - 逐字段校验：非空字符串，非法值 fail-fast；
 * - writeConfig 全字段序列化：codegraphPath 写入不丢既有字段（截断回归锚）；
 * - 统一 0600；缺省时不出现在落盘 JSON。
 */

function makeTmp(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-t21-cgpath-"));
  return { dir, file: path.join(dir, "config.json") };
}

describe("config codegraphPath 键（T2.1 二级解析第②级读面）", () => {
  test("合法 codegraphPath 读出；缺省时字段为 undefined（不注入默认）", () => {
    const { dir, file } = makeTmp();
    try {
      expect(loadConfig(file).config.codegraphPath).toBeUndefined(); // 文件缺失 → 默认
      writeFileSync(file, JSON.stringify({ port: 7333, codegraphPath: "/opt/tools/codegraph" }), "utf8");
      expect(loadConfig(file).config.codegraphPath).toBe("/opt/tools/codegraph");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非法值 fail-fast：空串 / 非字符串", () => {
    const { dir } = makeTmp();
    try {
      for (const [name, bad] of [["empty", ""], ["num", 42], ["null", null], ["obj", {}]] as const) {
        const f = path.join(dir, `bad-${name}.json`);
        writeFileSync(f, JSON.stringify({ port: 7333, codegraphPath: bad }), "utf8");
        expect(() => loadConfig(f), `codegraphPath=${JSON.stringify(bad)} 应 fail-fast`).toThrow(/codegraphPath/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeConfig 全字段序列化：codegraphPath + 既有字段全量往返不丢，文件 0600", () => {
    const { dir, file } = makeTmp();
    try {
      writeConfig(file, {
        port: 9001,
        maxConcurrent: 6,
        maxQueued: 12,
        staticDir: "/tmp/shell-dist",
        rgPath: "/opt/tools/rg",
        codegraphPath: "/opt/tools/codegraph",
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(loadConfig(file).config).toEqual({
        port: 9001,
        maxConcurrent: 6,
        maxQueued: 12,
        staticDir: "/tmp/shell-dist",
        rgPath: "/opt/tools/rg",
        codegraphPath: "/opt/tools/codegraph",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("codegraphPath 缺省往返：不出现在落盘 JSON，其余字段不受影响", () => {
    const { dir, file } = makeTmp();
    try {
      writeConfig(file, { port: 7333, maxConcurrent: 3, maxQueued: 8 });
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(parsed.codegraphPath).toBeUndefined();
      expect(parsed.port).toBe(7333);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
