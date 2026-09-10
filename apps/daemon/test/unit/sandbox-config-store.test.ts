import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { RuntimeConfigStore } from "../../src/adapters/driven/sqlite-session/RuntimeConfigStore";
import { SandboxConfigStore } from "../../src/adapters/driven/sqlite-session/SandboxConfigStore";

/**
 * SandboxConfigStore（沙箱开关批）：KV sandbox_config 单键 JSON 读写 +
 * 缺省/非法回落关（失败安全方向 = 不沙箱）+ set 原子写往返。
 * SchedulingConfigStore 同构模板（test/unit/scheduling-config-store.test.ts）。
 */

function makeStore(dir: string): SandboxConfigStore {
  const wq = new WriteQueue(join(dir, "helix.db"));
  const kv = new RuntimeConfigStore(wq);
  return new SandboxConfigStore(kv);
}

describe("SandboxConfigStore（KV sandbox_config 单键）", () => {
  test("未设置 → current() 回落 {enabled:false}（缺省关——失败安全）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      expect(makeStore(dir).current()).toEqual({ enabled: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("set(true) → current() 往返；「重启」（新实例同库）后仍读到", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      const store = makeStore(dir);
      await store.set({ enabled: true });
      expect(store.current()).toEqual({ enabled: true });
      expect(makeStore(dir).current()).toEqual({ enabled: true }); // 重启模拟
      await store.set({ enabled: false });
      expect(store.current()).toEqual({ enabled: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("脏数据回落：KV 值非法（非 JSON / enabled 非 boolean）→ 缺省关不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      const wq = new WriteQueue(join(dir, "helix.db"));
      const kv = new RuntimeConfigStore(wq);
      await kv.set("sandbox_config", "{not-json");
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: false });
      await kv.set("sandbox_config", JSON.stringify({ enabled: "yes" }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: false });
      // 合法值不受脏读面影响
      await kv.set("sandbox_config", JSON.stringify({ enabled: true }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
