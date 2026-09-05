import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureConfigTemplate,
  loadConfig,
  writeConfig,
} from "../../src/infrastructure/config";

/**
 * AG-09 + T2.3 + config 瘦身批（2026-09-05）：config.json 写入语义——
 * - 0600（首次创建模板与显式写回统一收权）；
 * - 瘦身形态：文件只剩 staticDir/rgPath（port/调度/mcpServers 全部迁出，
 *   旧字段进 legacy 由组合根迁移写新位）；
 * - 模板 = 空对象（文件在 = 已初始化标记）。
 */
describe("config.json 写入语义（AG-09 + config 瘦身批）", () => {
  test("首次创建模板：权限 0600 + 幂等（已存在不动）+ 空对象形态", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      const first = ensureConfigTemplate(file);
      expect(first.created).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // 模板瘦身形态：空对象（运行参数全部迁 KV/表）
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(parsed).toEqual({});

      // 幂等：已存在不覆盖
      writeFileSync(file, '{"staticDir":"/tmp/x"}', "utf8");
      const second = ensureConfigTemplate(file);
      expect(second.created).toBe(false);
      expect(loadConfig(file).config.staticDir).toBe("/tmp/x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeConfig 全字段序列化往返（staticDir/rgPath 不丢）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      writeFileSync(file, '{"staticDir":"/tmp/old"}', { mode: 0o644 });
      writeConfig(file, { staticDir: "/tmp/shell-dist", rgPath: "/opt/bin/rg" });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const round = loadConfig(file);
      expect(round.config).toEqual({ staticDir: "/tmp/shell-dist", rgPath: "/opt/bin/rg" });
      expect(round.legacy).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeConfig 缺省字段往返（staticDir 省略时不出现在落盘 JSON）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      writeConfig(file, {});
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(parsed).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("旧字段迁移读面（config 瘦身批）：port/maxConcurrent/maxQueued/mcpServers 读入 legacy（不报错）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      writeFileSync(
        file,
        JSON.stringify({
          port: 9001,
          maxConcurrent: 6,
          maxQueued: 12,
          mcpServers: [{ name: "s1", command: "npx" }],
        }),
        "utf8",
      );
      const round = loadConfig(file);
      expect(round.config).toEqual({}); // 引导参数面为空——全部进 legacy
      expect(round.legacy.port).toBe(9001);
      expect(round.legacy.maxConcurrent).toBe(6);
      expect(round.legacy.maxQueued).toBe(12);
      expect(round.legacy.mcpServers?.map((s) => s.name)).toEqual(["s1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
