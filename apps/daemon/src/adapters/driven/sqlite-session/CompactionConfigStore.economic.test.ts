import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import { CompactionConfigStore } from "./CompactionConfigStore";

/**
 * CompactionConfigStore 经济水位字段（economicCeilingTokens）单测：
 * 可选字段解析链（携带/缺席/非法拒绝回退默认/0 保留为显式关闭）+
 * 单键 JSON 序列化往返。
 */

function fakeRuntimeConfig(initial?: string): RuntimeConfigPort & { stored: string | undefined } {
  let stored = initial;
  const port = {
    get(_key: string): string | undefined {
      return stored;
    },
    set(_key: string, value: string): Promise<void> {
      stored = value;
      return Promise.resolve();
    },
  } as RuntimeConfigPort & { stored?: string | undefined };
  Object.defineProperty(port, "stored", { get: () => stored });
  return port as RuntimeConfigPort & { stored: string | undefined };
}

const fallback = { reserveTokens: 16384, keepRecentTokens: 20000 };

describe("CompactionConfigStore economicCeilingTokens", () => {
  test("携带合法 economicCeilingTokens → 解析往返", async () => {
    const store = new CompactionConfigStore(fakeRuntimeConfig(JSON.stringify({ reserveTokens: 1000, keepRecentTokens: 2000, economicCeilingTokens: 272000 })), fallback);
    const c = store.current();
    expect(c.reserveTokens).toBe(1000);
    expect(c.keepRecentTokens).toBe(2000);
    expect(c.economicCeilingTokens).toBe(272000);
  });

  test("字段缺席（旧格式）→ undefined（tiers 自动推导语义），其余字段照常", () => {
    const store = new CompactionConfigStore(fakeRuntimeConfig(JSON.stringify({ reserveTokens: 1000, keepRecentTokens: 2000 })), fallback);
    const c = store.current();
    expect(c.reserveTokens).toBe(1000);
    expect(c.keepRecentTokens).toBe(2000);
    expect(c.economicCeilingTokens).toBeUndefined();
  });

  test("0 → 保留（显式关闭经济线）", () => {
    const store = new CompactionConfigStore(fakeRuntimeConfig(JSON.stringify({ reserveTokens: 1000, keepRecentTokens: 2000, economicCeilingTokens: 0 })), fallback);
    expect(store.current().economicCeilingTokens).toBe(0);
  });

  test("非法值（负数/非整数/字符串）→ 整条拒绝回落默认", () => {
    for (const bad of [-1, 1.5, "272000"]) {
      const store = new CompactionConfigStore(
        fakeRuntimeConfig(JSON.stringify({ reserveTokens: 1000, keepRecentTokens: 2000, economicCeilingTokens: bad })),
        fallback,
      );
      const c = store.current();
      expect(c.reserveTokens).toBe(16384); // 整条回落（KV 解析失败语义）
      expect(c.economicCeilingTokens).toBeUndefined();
    }
  });

  test("set → 序列化往返（含可选字段）", async () => {
    const cfg = fakeRuntimeConfig();
    const store = new CompactionConfigStore(cfg, fallback);
    await store.set({ reserveTokens: 500, keepRecentTokens: 20, economicCeilingTokens: 100000 });
    const c = store.current();
    expect(c.economicCeilingTokens).toBe(100000);
    expect(c.reserveTokens).toBe(500);
  });

  test("set（不携带字段）→ 序列化后字段缺席", async () => {
    const cfg = fakeRuntimeConfig();
    const store = new CompactionConfigStore(cfg, fallback);
    await store.set({ reserveTokens: 500, keepRecentTokens: 20 });
    expect(store.current().economicCeilingTokens).toBeUndefined();
  });
});
