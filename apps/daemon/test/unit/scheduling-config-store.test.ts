import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { RuntimeConfigStore } from "../../src/adapters/driven/sqlite-session/RuntimeConfigStore";
import { SchedulingConfigStore } from "../../src/adapters/driven/sqlite-session/SchedulingConfigStore";
import { DEFAULT_SCHEDULING } from "../../src/domain/agent/SchedulingPolicy";

/**
 * SchedulingConfigStore（config 瘦身批）：KV scheduling_config 单键 JSON 读写
 * + 缺省/非法回落 DEFAULT_SCHEDULING + set 原子写往返。CompactionConfigStore
 * 同构模板（test/unit/compaction-config-store.test.ts 若有同名断言族，本文件
 * 为其 scheduling 孪生）。
 */

function makeStore(dir: string): SchedulingConfigStore {
  const wq = new WriteQueue(join(dir, "helix.db"));
  const kv = new RuntimeConfigStore(wq);
  // fallback 只取预算两字段（stalledThresholdMs 是 domain 内部阈值，不进本面）
  return new SchedulingConfigStore(kv, {
    maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent,
    maxQueued: DEFAULT_SCHEDULING.maxQueued,
  });
}

describe("SchedulingConfigStore（KV scheduling_config 单键）", () => {
  test("未设置 → current() 回落 DEFAULT_SCHEDULING（3/8）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-store-"));
    try {
      const store = makeStore(dir);
      expect(store.current()).toEqual({ maxConcurrent: 3, maxQueued: 8 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("set → current() 往返（新值即时可见）；进程重启（新实例）后仍读到", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-store-"));
    try {
      const store = makeStore(dir);
      await store.set({ maxConcurrent: 5, maxQueued: 12 });
      expect(store.current()).toEqual({ maxConcurrent: 5, maxQueued: 12 });
      // 「重启」模拟：新 store 实例同库读
      const revived = makeStore(dir);
      expect(revived.current()).toEqual({ maxConcurrent: 5, maxQueued: 12 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("脏数据回落：KV 值非法（非 JSON / 字段缺 / 越界 / 非整数）→ DEFAULT_SCHEDULING 不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-store-"));
    try {
      const wq = new WriteQueue(join(dir, "helix.db"));
      const kv = new RuntimeConfigStore(wq);
      const store = new SchedulingConfigStore(kv, {
        maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent,
        maxQueued: DEFAULT_SCHEDULING.maxQueued,
      });
      for (const bad of [
        "{not json",
        JSON.stringify({ maxConcurrent: 3 }), // 缺 maxQueued
        JSON.stringify({ maxConcurrent: 0, maxQueued: 8 }), // <1
        JSON.stringify({ maxConcurrent: 2.5, maxQueued: 8 }), // 非整数
        JSON.stringify({ maxConcurrent: 3, maxQueued: -1 }), // <0
      ]) {
        await kv.set("scheduling_config", bad);
        expect(store.current()).toEqual({ maxConcurrent: 3, maxQueued: 8 });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("db 关闭后读面兜底：current() 返回最近已知值不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-store-"));
    try {
      const wq = new WriteQueue(join(dir, "helix.db"));
      const kv = new RuntimeConfigStore(wq);
      const store = new SchedulingConfigStore(kv, {
        maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent,
        maxQueued: DEFAULT_SCHEDULING.maxQueued,
      });
      await store.set({ maxConcurrent: 6, maxQueued: 9 });
      await wq.close();
      expect(store.current()).toEqual({ maxConcurrent: 6, maxQueued: 9 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
