import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { RuntimeConfigStore } from "../../src/adapters/driven/sqlite-session/RuntimeConfigStore";
import { ProxyConfigStore } from "../../src/adapters/driven/sqlite-session/ProxyConfigStore";
import { isValidProxyUrl } from "@helix/protocol";

/**
 * ProxyConfigStore（网络代理批）：KV proxy_config 单键 JSON 读写 + 缺省/
 * 非法回落关（失败安全方向 = 直连）+ set 往返/重启保持。
 * SandboxConfigStore 同构模板（test/unit/sandbox-config-store.test.ts）。
 */

function makeKv(dir: string): RuntimeConfigStore {
  return new RuntimeConfigStore(new WriteQueue(join(dir, "helix.db")));
}

const OFF = { enabled: false, url: "" };
const ON = { enabled: true, url: "http://127.0.0.1:7890" };

describe("ProxyConfigStore（KV proxy_config 单键）", () => {
  test("未设置 → current() 回落 {enabled:false, url:\"\"}（缺省直连——失败安全）", () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-store-"));
    try {
      expect(new ProxyConfigStore(makeKv(dir)).current()).toEqual(OFF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("set 往返 + 「重启」（新实例同库）后仍读到；即热语义（set 后 current 即新值）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-store-"));
    try {
      const store = new ProxyConfigStore(makeKv(dir));
      await store.set(ON);
      expect(store.current()).toEqual(ON); // 即热：无需重建实例
      expect(new ProxyConfigStore(makeKv(dir)).current()).toEqual(ON); // 重启模拟
      await store.set(OFF);
      expect(store.current()).toEqual(OFF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("合法值读过后再遇脏数据也回落直连，不保留陈旧代理", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-store-"));
    try {
      const kv = makeKv(dir);
      const store = new ProxyConfigStore(kv);
      await store.set(ON);
      expect(store.current()).toEqual(ON);
      await kv.set("proxy_config", "{bad");
      expect(store.current()).toEqual(OFF);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("脏数据回落：非 JSON / enabled 非布尔 / enabled=true 而 url 非法 → 缺省直连不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-store-"));
    try {
      const kv = makeKv(dir);
      await kv.set("proxy_config", "{not-json");
      expect(new ProxyConfigStore(kv).current()).toEqual(OFF);
      await kv.set("proxy_config", JSON.stringify({ enabled: "yes" }));
      expect(new ProxyConfigStore(kv).current()).toEqual(OFF);
      await kv.set("proxy_config", JSON.stringify({ enabled: true, url: "ftp://bad" }));
      expect(new ProxyConfigStore(kv).current()).toEqual(OFF);
      // url 缺键但 enabled=false → 合法（未启用时 url 可空）
      await kv.set("proxy_config", JSON.stringify({ enabled: false }));
      expect(new ProxyConfigStore(kv).current()).toEqual(OFF);
      // 当前 Bun 不支持 SOCKS5，持久层不激活这种代理。
      await kv.set("proxy_config", JSON.stringify({ enabled: true, url: "socks5://u:p@h:1080" }));
      expect(new ProxyConfigStore(kv).current()).toEqual(OFF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isValidProxyUrl（合法形态单源）", () => {
  test.each([
    ["http://127.0.0.1:7890", true],
    ["https://proxy.corp:8443", true],
    ["socks5://user:pass@10.0.0.2:1080", false],
    ["http://", false],
    ["http://proxy:65536", false],
    ["http://proxy/path", false],
    ["http://proxy?key=secret", false],
    ["https://user:p%40ss@proxy.corp:8443", true],
    ["", false],
    ["ftp://x", false],
    ["http:// has space", false],
    ["127.0.0.1:7890", false], // 无协议前缀
    ["socks4://h", false],
  ])("%s → %s", (url, ok) => {
    expect(isValidProxyUrl(url)).toBe(ok);
  });
});
