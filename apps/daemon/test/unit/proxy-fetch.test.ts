import { afterEach, describe, expect, test } from "bun:test";
import { installProxyFetch } from "../../src/adapters/driven/network/proxy-fetch";
import type { ProxyConfig } from "../../src/application/ports/outbound/ProxyConfigPort";

const ON: ProxyConfig = { enabled: true, url: "http://127.0.0.1:7890" };
const OFF: ProxyConfig = { enabled: false, url: "" };

describe("proxy fetch routing and lifecycle", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

  function spy() {
    const original = globalThis.fetch;
    const calls: { input: unknown; init?: RequestInit & { proxy?: string } }[] = [];
    const preconnects: unknown[] = [];
    const fetchSpy = Object.assign((input: unknown, init?: RequestInit & { proxy?: string }) => {
      calls.push({ input, init });
      return Promise.resolve(new Response("ok"));
    }, { preconnect: (...args: unknown[]) => { preconnects.push(args); } }) as typeof fetch;
    globalThis.fetch = fetchSpy;
    cleanups.push(() => { globalThis.fetch = original; });
    return { calls, preconnects, fetchSpy };
  }
  function install(get: () => ProxyConfig) {
    const undo = installProxyFetch(get);
    cleanups.push(undo);
    return undo;
  }

  test("off explicitly disables inherited environment/per-request proxies", async () => {
    const s = spy(); install(() => OFF);
    await fetch("https://example.com", { method: "POST", proxy: "http://wrong:1" });
    expect(s.calls[0]?.init).toEqual({ method: "POST", proxy: "" });
  });
  test("on preserves Request, headers, abort signal and body while selecting proxy", async () => {
    const s = spy(); install(() => ON);
    const request = new Request("https://example.com", { method: "POST", body: "payload" });
    const signal = new AbortController().signal;
    await fetch(request, { signal, headers: { a: "1" } });
    expect(s.calls[0]?.input).toBe(request);
    expect(s.calls[0]?.init).toEqual({ signal, headers: { a: "1" }, proxy: ON.url });
  });
  test("loopback is direct even with inherited proxies", async () => {
    const s = spy(); install(() => ON);
    for (const url of ["http://localhost:7333", "http://LOCALHOST.:7333", "http://127.2.3.4", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://0.0.0.0"]) await fetch(url);
    expect(s.calls).toHaveLength(6);
    for (const c of s.calls) expect(c.init?.proxy).toBe("");
  });
  test("invalid configuration and non-HTTP input go direct, not through proxy", async () => {
    const s = spy(); const ref = { value: { enabled: true, url: "http://" } };
    install(() => ref.value);
    await fetch("https://example.com");
    ref.value = ON;
    await fetch("data:text/plain,ok");
    expect(s.calls.map(c => c.init?.proxy)).toEqual(["", ""]);
  });
  test("hot switching affects the next call without reinstalling", async () => {
    const s = spy(); const ref = { value: OFF };
    install(() => ref.value);
    await fetch("https://example.com");
    ref.value = ON;
    await fetch("https://example.com");
    ref.value = { enabled: true, url: "https://proxy.corp:8443" };
    await fetch("https://example.com");
    ref.value = OFF;
    await fetch("https://example.com");
    expect(s.calls.map(c => c.init?.proxy)).toEqual(["", ON.url, "https://proxy.corp:8443", ""]);
  });
  test("uninstall restores exact fetch identity and preconnect, and is idempotent", async () => {
    const s = spy(); const undo = install(() => ON);
    undo(); undo();
    expect(globalThis.fetch).toBe(s.fetchSpy);
    globalThis.fetch.preconnect("https://example.com");
    expect(s.preconnects).toHaveLength(1);
  });
  test("multiple daemon owners do not retain a closed store; out-of-order cleanup is safe", async () => {
    const s = spy(); const undoA = install(() => ON);
    const undoB = install(() => OFF);
    undoA();
    await fetch("https://example.com");
    expect(s.calls[0]?.init?.proxy).toBe("");
    undoB();
    expect(globalThis.fetch).toBe(s.fetchSpy);
  });
  test("preconnect never bypasses an enabled proxy", () => {
    const s = spy(); install(() => ON);
    globalThis.fetch.preconnect("https://example.com");
    expect(s.preconnects).toHaveLength(0);
  });
});
