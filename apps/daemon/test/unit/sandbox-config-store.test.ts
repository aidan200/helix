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
 * autoApprove（提权自动通过）：缺键/非 true 一律 false——自动通过必须显式开启。
 */

function makeStore(dir: string): SandboxConfigStore {
  const wq = new WriteQueue(join(dir, "helix.db"));
  const kv = new RuntimeConfigStore(wq);
  return new SandboxConfigStore(kv);
}

describe("SandboxConfigStore（KV sandbox_config 单键）", () => {
  test("未设置 → current() 回落 {enabled:false, autoApprove:false}（缺省关——失败安全）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      expect(makeStore(dir).current()).toEqual({ enabled: false, extraRoots: [], autoApprove: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("set(true) → current() 往返；「重启」（新实例同库）后仍读到", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      const store = makeStore(dir);
      await store.set({ enabled: true, extraRoots: [], autoApprove: false });
      expect(store.current()).toEqual({ enabled: true, extraRoots: [], autoApprove: false });
      expect(makeStore(dir).current()).toEqual({ enabled: true, extraRoots: [], autoApprove: false }); // 重启模拟
      await store.set({ enabled: false, extraRoots: [], autoApprove: false });
      expect(store.current()).toEqual({ enabled: false, extraRoots: [], autoApprove: false });
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
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: false, extraRoots: [], autoApprove: false });
      await kv.set("sandbox_config", JSON.stringify({ enabled: "yes" }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: false, extraRoots: [], autoApprove: false });
      // 合法值不受脏读面影响
      await kv.set("sandbox_config", JSON.stringify({ enabled: true }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: true, extraRoots: [], autoApprove: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extraRoots 往返 + 旧载荷缺键兼容（→ []）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      const store = makeStore(dir);
      await store.set({ enabled: true, extraRoots: ["/Users/x/.cache/uv", "/opt/tools"], autoApprove: false });
      expect(store.current()).toEqual({ enabled: true, extraRoots: ["/Users/x/.cache/uv", "/opt/tools"], autoApprove: false });
      expect(makeStore(dir).current()).toEqual({ enabled: true, extraRoots: ["/Users/x/.cache/uv", "/opt/tools"], autoApprove: false }); // 重启模拟
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extraRoots 逐项过滤：非字符串/相对路径丢弃 + 去重（增强面不阻断）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      const wq = new WriteQueue(join(dir, "helix.db"));
      const kv = new RuntimeConfigStore(wq);
      await kv.set("sandbox_config", JSON.stringify({ enabled: true, extraRoots: ["/abs/ok", "relative/bad", 42, "/abs/ok", null] }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: true, extraRoots: ["/abs/ok"], autoApprove: false });
      // extraRoots 非数组 → []
      await kv.set("sandbox_config", JSON.stringify({ enabled: true, extraRoots: "nope" }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: true, extraRoots: [], autoApprove: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("autoApprove（提权自动通过）往返 + 旧载荷缺键/非 true 归一 false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      const wq = new WriteQueue(join(dir, "helix.db"));
      const kv = new RuntimeConfigStore(wq);
      // 旧载荷缺键 → false（自动通过必须显式开启）
      await kv.set("sandbox_config", JSON.stringify({ enabled: true, extraRoots: [] }));
      expect(new SandboxConfigStore(kv).current().autoApprove).toBe(false);
      // 显式 true 往返 + 重启模拟
      const store = new SandboxConfigStore(kv);
      await store.set({ enabled: true, extraRoots: [], autoApprove: true });
      expect(store.current()).toEqual({ enabled: true, extraRoots: [], autoApprove: true });
      expect(makeStore(dir).current()).toEqual({ enabled: true, extraRoots: [], autoApprove: true });
      // 非 boolean 脏值（字符串/数字）→ false 不抛错
      await kv.set("sandbox_config", JSON.stringify({ enabled: true, extraRoots: [], autoApprove: "yes" }));
      expect(new SandboxConfigStore(kv).current().autoApprove).toBe(false);
      await kv.set("sandbox_config", JSON.stringify({ enabled: true, extraRoots: [], autoApprove: 1 }));
      expect(new SandboxConfigStore(kv).current().autoApprove).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
