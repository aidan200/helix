import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_PORT,
  ensureConfigTemplate,
  loadConfig,
  writeConfig,
} from "../../src/infrastructure/config";
import { DEFAULT_SCHEDULING } from "../../src/domain/agent/SchedulingPolicy";

/**
 * AG-09 + T2.3：config.json 写入语义（瘦身形态）——
 * - 0600（首次创建模板与显式写回统一收权）；
 * - **全字段序列化**（T2.3 修复截断：port/maxConcurrent/maxQueued/staticDir
 *   全量往返，旧实现只写三字段会静默丢字段）；
 * - 模板 = 纯运行参数（模型/key 位已迁出，AD-2）。
 */
describe("config.json 写入语义（AG-09 + T2.3 瘦身/全字段）", () => {
  test("首次创建模板：权限 0600 + 幂等（已存在不动）+ 纯运行参数形态", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      const first = ensureConfigTemplate(file);
      expect(first.created).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // 模板瘦身形态：无 model/apiKeys 字段
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(parsed.model).toBeUndefined();
      expect(parsed.apiKeys).toBeUndefined();
      expect(parsed.port).toBe(DEFAULT_PORT);

      // 幂等：已存在不覆盖
      writeFileSync(file, '{"port":1}', "utf8");
      const second = ensureConfigTemplate(file);
      expect(second.created).toBe(false);
      expect(loadConfig(file).config.port).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeConfig 全字段序列化往返（截断修复：maxConcurrent/maxQueued/staticDir 不丢）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      writeFileSync(file, '{"port":1}', { mode: 0o644 });
      writeConfig(file, {
        port: 9001,
        maxConcurrent: 6,
        maxQueued: 12,
        staticDir: "/tmp/shell-dist",
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const round = loadConfig(file);
      expect(round.config).toEqual({
        port: 9001,
        maxConcurrent: 6,
        maxQueued: 12,
        staticDir: "/tmp/shell-dist",
      });
      expect(round.legacy).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeConfig 缺省字段往返（staticDir 省略时不出现在落盘 JSON）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-"));
    try {
      const file = path.join(dir, "config.json");
      writeConfig(file, {
        port: DEFAULT_PORT,
        maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent,
        maxQueued: DEFAULT_SCHEDULING.maxQueued,
      });
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(parsed.staticDir).toBeUndefined();
      expect(parsed.maxQueued).toBe(DEFAULT_SCHEDULING.maxQueued); // 截断修复回归锚
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
