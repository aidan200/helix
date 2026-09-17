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
      expect(makeStore(dir).current()).toEqual({ enabled: false, extraRoots: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("set(true) → current() 往返；「重启」（新实例同库）后仍读到", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      const store = makeStore(dir);
      await store.set({ enabled: true, extraRoots: [] });
      expect(store.current()).toEqual({ enabled: true, extraRoots: [] });
      expect(makeStore(dir).current()).toEqual({ enabled: true, extraRoots: [] }); // 重启模拟
      await store.set({ enabled: false, extraRoots: [] });
      expect(store.current()).toEqual({ enabled: false, extraRoots: [] });
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
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: false, extraRoots: [] });
      await kv.set("sandbox_config", JSON.stringify({ enabled: "yes" }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: false, extraRoots: [] });
      // 合法值不受脏读面影响
      await kv.set("sandbox_config", JSON.stringify({ enabled: true }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: true, extraRoots: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extraRoots 往返 + 旧载荷缺键兼容（→ []）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-store-"));
    try {
      const store = makeStore(dir);
      await store.set({ enabled: true, extraRoots: ["/Users/x/.cache/uv", "/opt/tools"] });
      expect(store.current()).toEqual({ enabled: true, extraRoots: ["/Users/x/.cache/uv", "/opt/tools"] });
      expect(makeStore(dir).current()).toEqual({ enabled: true, extraRoots: ["/Users/x/.cache/uv", "/opt/tools"] }); // 重启模拟
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
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: true, extraRoots: ["/abs/ok"] });
      // extraRoots 非数组 → []
      await kv.set("sandbox_config", JSON.stringify({ enabled: true, extraRoots: "nope" }));
      expect(new SandboxConfigStore(kv).current()).toEqual({ enabled: true, extraRoots: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
