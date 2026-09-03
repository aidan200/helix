import { describe, expect, test } from "bun:test";
import { scopedBrowserCall } from "../../src/adapters/driven/subagent/ScopedBrowserProxy";
import { FakeBrowserPort } from "../mocks/FakeBrowserPort";
import type { TabInfo } from "../../src/application/ports/outbound/BrowserPort";

/**
 * H-3③：ScopedBrowserProxy 单测（daemon 侧归属代理——纯分发，无 IO 自持）。
 *
 * 四路断言（FakeBrowserPort 记录桩）：
 * - openTab：ownerId 强制改写为通道 instanceId（子进程传伪造 owner 被覆盖）；
 * - tabId 方法：归属校验（ownerId ≠ instanceId / 不存在 → 中文拒绝）+ 自有 tab 透传；
 * - listTabs：过滤 owner 维度子集；
 * - getStatus：透传（观测面无操作能力）。
 * 管理面 4 方法（connect/stop/reclaimOwner/onStatusChange）不上 wire → 白名单外拒绝。
 */

const tab = (tabId: string, ownerId: string): TabInfo => ({
  tabId,
  ownerId,
  url: `https://${tabId}.example`,
  title: tabId,
  lastAccessed: 1_000,
});

describe("ScopedBrowserProxy ③ openTab owner 强制改写", () => {
  test("子进程伪造 ownerId 被覆盖为通道 instanceId", async () => {
    const browser = new FakeBrowserPort();
    const result = await scopedBrowserCall(browser, "agent-7", "openTab", ["https://x.example", "main"]);
    expect(result).toEqual({ tabId: "tab-new" });
    expect(browser.lastCall("openTab")!.args).toEqual(["https://x.example", "agent-7"]);
  });
});

describe("ScopedBrowserProxy ③ tabId 归属校验", () => {
  test("自有 tab 透传（参数原样）", async () => {
    const browser = new FakeBrowserPort();
    browser.tabs = [tab("tab-1", "agent-7"), tab("tab-2", "main")];
    await scopedBrowserCall(browser, "agent-7", "navigateTab", ["tab-1", "https://n.example"]);
    expect(browser.lastCall("navigateTab")!.args).toEqual(["tab-1", "https://n.example"]);
  });

  test.each([
    ["navigateTab", ["tab-2", "https://n.example"]],
    ["backTab", ["tab-2"]],
    ["evalInTab", ["tab-2", "1+1"]],
    ["clickInTab", ["tab-2", "#b"]],
    ["clickAtInTab", ["tab-2", "#b"]],
    ["setFilesInTab", ["tab-2", "input", ["/tmp/a"]]],
    ["scrollTab", ["tab-2"]],
    ["screenshotTab", ["tab-2", "/tmp/s.png"]],
    ["closeTab", ["tab-2"]],
  ] as const)("他人 tab（owner=main）→ %s 拒绝且不触达 port", async (method, args) => {
    const browser = new FakeBrowserPort();
    browser.tabs = [tab("tab-2", "main")];
    await expect(scopedBrowserCall(browser, "agent-7", method, [...args])).rejects.toThrow(
      "tab tab-2 不属于实例 agent-7（或不存在）",
    );
    expect(browser.lastCall(method)).toBeUndefined();
  });

  test("不存在的 tab → 同口径拒绝", async () => {
    const browser = new FakeBrowserPort();
    browser.tabs = [tab("tab-1", "agent-7")];
    await expect(scopedBrowserCall(browser, "agent-7", "closeTab", ["tab-ghost"])).rejects.toThrow(
      "tab tab-ghost 不属于实例 agent-7（或不存在）",
    );
  });
});

describe("ScopedBrowserProxy ③ H9 可选参 null 占位 → undefined 还原", () => {
  test("scrollTab [tabId, null, \"bottom\"] → port 收到 (tabId, undefined, \"bottom\")（direction 不落 y 位）", async () => {
    const browser = new FakeBrowserPort();
    browser.tabs = [tab("tab-1", "agent-7")];
    await scopedBrowserCall(browser, "agent-7", "scrollTab", ["tab-1", null, "bottom"]);
    const args = browser.lastCall("scrollTab")!.args;
    expect(args[0]).toBe("tab-1");
    expect(args[1]).toBeUndefined();
    expect(args[2]).toBe("bottom");
  });

  test("scrollTab 全缺省 [tabId, null, null] → port 收到 (tabId, undefined, undefined)（缺省值归实现侧）", async () => {
    const browser = new FakeBrowserPort();
    browser.tabs = [tab("tab-1", "agent-7")];
    await scopedBrowserCall(browser, "agent-7", "scrollTab", ["tab-1", null, null]);
    const args = browser.lastCall("scrollTab")!.args;
    expect(args[1]).toBeUndefined();
    expect(args[2]).toBeUndefined();
  });

  test("screenshotTab [tabId, null, \"jpeg\"] → port 收到 (tabId, undefined, \"jpeg\")", async () => {
    const browser = new FakeBrowserPort();
    browser.tabs = [tab("tab-1", "agent-7")];
    await scopedBrowserCall(browser, "agent-7", "screenshotTab", ["tab-1", null, "jpeg"]);
    const args = browser.lastCall("screenshotTab")!.args;
    expect(args[1]).toBeUndefined();
    expect(args[2]).toBe("jpeg");
  });
});

describe("ScopedBrowserProxy ③ listTabs 过滤 / getStatus 透传 / 白名单外", () => {
  test("listTabs 只回 owner 维度子集", async () => {
    const browser = new FakeBrowserPort();
    browser.tabs = [tab("tab-1", "agent-7"), tab("tab-2", "main"), tab("tab-3", "agent-7")];
    const result = (await scopedBrowserCall(browser, "agent-7", "listTabs", [])) as readonly TabInfo[];
    expect(result.map((t) => t.tabId)).toEqual(["tab-1", "tab-3"]);
  });

  test("getStatus 透传（观测面无归属收窄）", async () => {
    const browser = new FakeBrowserPort();
    browser.status = { state: "connected", browser: { id: "chrome", label: "Chrome", port: 9222 }, tabCount: 5 };
    const result = await scopedBrowserCall(browser, "agent-7", "getStatus", []);
    expect(result).toEqual(browser.status);
  });

  test.each(["connect", "stop", "reclaimOwner", "onStatusChange", "rmRf"])("白名单外方法 %s → 拒绝", async (method) => {
    const browser = new FakeBrowserPort();
    await expect(scopedBrowserCall(browser, "agent-7", method, [])).rejects.toThrow(/白名单外/);
    expect(browser.calls).toHaveLength(0);
  });
});
