import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/infrastructure/config";
import { DEFAULT_SCHEDULING } from "../../src/domain/agent/SchedulingPolicy";

/**
 * T2.1 config 新字段解析单测（K4：maxConcurrent/maxQueued 经
 * `<home>/config.json` 可配）。独立文件避让并行任务的 config.test.ts 改动。
 *
 * ① 字段缺省（文件存在但未写）→ 3/8；② 覆写生效（如 2/4）；
 * ③ 非法值（非正整数/非整数）→ 中文 fail-fast；④ 文件缺失 → 缺省 3/8。
 */

const tmpRoots: string[] = [];

function configPath(content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-t21-cfg-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "config.json");
  if (content !== undefined) writeFileSync(file, content, "utf8");
  return file;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("config maxConcurrent/maxQueued（T2.1，K4）", () => {
  test("① 字段缺省 → 3/8（与 domain 缺省同源）", () => {
    const cfg = loadConfig(configPath(JSON.stringify({ model: "anthropic/claude-sonnet-4-5" })));
    expect(cfg.maxConcurrent).toBe(3);
    expect(cfg.maxQueued).toBe(8);
    expect(cfg.maxConcurrent).toBe(DEFAULT_SCHEDULING.maxConcurrent);
    expect(cfg.maxQueued).toBe(DEFAULT_SCHEDULING.maxQueued);
  });

  test("② 覆写生效（2/4）", () => {
    const cfg = loadConfig(
      configPath(
        JSON.stringify({ model: "anthropic/claude-sonnet-4-5", maxConcurrent: 2, maxQueued: 4 }),
      ),
    );
    expect(cfg.maxConcurrent).toBe(2);
    expect(cfg.maxQueued).toBe(4);
  });

  test("③ 非法值 → 中文 fail-fast", () => {
    const file1 = configPath(JSON.stringify({ model: "m", maxConcurrent: 0 }));
    expect(() => loadConfig(file1)).toThrow(/maxConcurrent/);
    const file2 = configPath(JSON.stringify({ model: "m", maxQueued: -1 }));
    expect(() => loadConfig(file2)).toThrow(/maxQueued/);
    const file3 = configPath(JSON.stringify({ model: "m", maxConcurrent: 1.5 }));
    expect(() => loadConfig(file3)).toThrow(/maxConcurrent/);
    try {
      loadConfig(file1);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/[\u4e00-\u9fa5]/);
      expect((err as Error).message).toContain(file1);
    }
  });

  test("④ 文件缺失 → 缺省 3/8（不抛错）", () => {
    const cfg = loadConfig(configPath());
    expect(cfg.maxConcurrent).toBe(3);
    expect(cfg.maxQueued).toBe(8);
  });
});
