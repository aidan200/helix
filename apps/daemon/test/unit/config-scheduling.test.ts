import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/infrastructure/config";

/**
 * config 瘦身批（2026-09-05）：maxConcurrent/maxQueued 不再是 config.json
 * 字段——现值在 runtime_config KV scheduling_config 键（语义校验/回落已由
 * test/unit/scheduling-config-store.test.ts 覆盖）。本文件只验证迁移读面：
 * 旧文件含该字段时读入 legacy（不报错、不丢值），组合根迁移写 KV。
 */

const tmpRoots: string[] = [];

function configPath(content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-sched-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "config.json");
  if (content !== undefined) writeFileSync(file, content, "utf8");
  return file;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe("config 瘦身批迁移读面（scheduling 字段）", () => {
  test("旧文件含 maxConcurrent/maxQueued → legacy 携带（config 面为空）", () => {
    const file = configPath(JSON.stringify({ maxConcurrent: 2, maxQueued: 4 }));
    const round = loadConfig(file);
    expect(round.config).toEqual({});
    expect(round.legacy.maxConcurrent).toBe(2);
    expect(round.legacy.maxQueued).toBe(4);
  });

  test("字段未写/文件缺失 → legacy 空（KV 缺省 3/8 生效域，不在本面）", () => {
    expect(loadConfig(configPath(JSON.stringify({}))).legacy).toEqual({});
    expect(loadConfig(configPath()).legacy).toEqual({});
  });

  test("非法值不再 fail-fast：迁移读面宽松（不校验强语义，非法值原样携带由组合根侧 store 落位回落）", () => {
    const file = configPath(JSON.stringify({ maxConcurrent: 0 }));
    expect(() => loadConfig(file)).not.toThrow();
  });
});
