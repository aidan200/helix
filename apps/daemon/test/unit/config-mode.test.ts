import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_PORT,
  ensureConfigTemplate,
  loadConfig,
  writeConfig,
} from "../../src/infrastructure/config";

/**
 * AG-09：config.json 写入权限 0600（含 apiKeys 敏感信息）——
 * 首次创建（模板）与显式写回统一收权。
 */
describe("config.json 0600 写入语义（AG-09）", () => {
  test("首次创建模板：权限 0600 + 幂等（已存在不动）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      const first = ensureConfigTemplate(file);
      expect(first.created).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);

      // 幂等：已存在不覆盖
      writeFileSync(file, '{"model":"keep-me","port":1}', "utf8");
      const second = ensureConfigTemplate(file);
      expect(second.created).toBe(false);
      expect(loadConfig(file).model).toBe("keep-me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeConfig 覆盖宽权限旧文件时同样收严到 0600", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      writeFileSync(file, '{"model":"old"}', { mode: 0o644 });
      writeConfig(file, { model: "anthropic/claude-x", apiKeys: { anthropic: "sk-1" }, port: DEFAULT_PORT });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(loadConfig(file)).toEqual({
        model: "anthropic/claude-x",
        apiKeys: { anthropic: "sk-1" },
        port: DEFAULT_PORT,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
