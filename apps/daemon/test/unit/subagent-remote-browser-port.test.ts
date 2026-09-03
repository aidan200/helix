import { describe, expect, test } from "bun:test";
import { RemoteBrowserPort } from "../../src/adapters/driven/subagent/child/RemoteBrowserPort";
import type { ChildOutboundLine, ToolResponseLine } from "../../src/adapters/driven/subagent/transport/wire";

/**
 * H-3②：RemoteBrowserPort 单测（BrowserPort 进程外实现——子进程侧）。
 *
 * 覆盖面：
 * - 12 白名单方法映射（method/args 逐字段 + 尾缺省参裁undefined——JSON null 不越线）；
 * - reqId 递增 + 乱序回执关联（pending map）；
 * - 超时拒绝 + 迟到回执忽略；
 * - ok:false 回执 → 中文错误透传拒绝；
 * - rejectAll 退出清场（在飞全拒 + 后到回执静默）；
 * - 管理面 4 方法本地安全 noop（不上 wire——共享连接/他人 tab 不归子进程管）。
 */

type ToolReq = Extract<ChildOutboundLine, { type: "tool-req" }>;

function makePort(opts: { timeoutMs?: number } = {}) {
  const sent: ToolReq[] = [];
  const port = new RemoteBrowserPort("agent-1", (line) => {
    if (line.type !== "tool-req") throw new Error(`非 tool-req 行越线：${line.type}`);
    sent.push(line);
  }, opts.timeoutMs);
  const respond = (reqId: number, res: { ok: true; value: unknown } | { ok: false; error: string }): void =>
    port.handleResponse({ type: "tool-res", reqId, ...res } as ToolResponseLine);
  return { port, sent, respond };
}

describe("RemoteBrowserPort ② 12 方法映射（method/args 逐字段）", () => {
  test("全量映射表：帧形状正确 + ok 回执值透传", async () => {
    const { port, sent, respond } = makePort();
    const cases: readonly { invoke: () => Promise<unknown>; method: string; args: readonly unknown[]; value: unknown }[] = [
      { invoke: () => port.openTab("https://x.example", "agent-1"), method: "openTab", args: ["https://x.example", "agent-1"], value: { tabId: "tab-9" } },
      { invoke: () => port.navigateTab("tab-9", "https://y.example"), method: "navigateTab", args: ["tab-9", "https://y.example"], value: null },
      { invoke: () => port.backTab("tab-9"), method: "backTab", args: ["tab-9"], value: null },
      { invoke: () => port.evalInTab("tab-9", "1+1"), method: "evalInTab", args: ["tab-9", "1+1"], value: 2 },
      { invoke: () => port.clickInTab("tab-9", "#btn"), method: "clickInTab", args: ["tab-9", "#btn"], value: { clicked: true } },
      { invoke: () => port.clickAtInTab("tab-9", "#file"), method: "clickAtInTab", args: ["tab-9", "#file"], value: { clicked: true, x: 1, y: 2 } },
      { invoke: () => port.setFilesInTab("tab-9", "input[type=file]", ["/tmp/a.png"]), method: "setFilesInTab", args: ["tab-9", "input[type=file]", ["/tmp/a.png"]], value: { success: true, count: 1 } },
      { invoke: () => port.scrollTab("tab-9"), method: "scrollTab", args: ["tab-9", null, null], value: { value: "scrolled down 3000px" } },
      { invoke: () => port.scrollTab("tab-9", 500, "up"), method: "scrollTab", args: ["tab-9", 500, "up"], value: { value: "scrolled up 500px" } },
      // H9：定长占位——y 缺省 direction 给定时不许稀疏（direction 落 y 位事故）
      { invoke: () => port.scrollTab("tab-9", undefined, "bottom"), method: "scrollTab", args: ["tab-9", null, "bottom"], value: { value: "scrolled to bottom" } },
      { invoke: () => port.screenshotTab("tab-9"), method: "screenshotTab", args: ["tab-9", null, null], value: { saved: "/tmp/s.png" } },
      // H9：file 缺省 format 给定时同样定长占位
      { invoke: () => port.screenshotTab("tab-9", undefined, "jpeg"), method: "screenshotTab", args: ["tab-9", null, "jpeg"], value: { saved: "/tmp/s.png" } },
      { invoke: () => port.screenshotTab("tab-9", "/tmp/s.png", "jpeg"), method: "screenshotTab", args: ["tab-9", "/tmp/s.png", "jpeg"], value: { saved: "/tmp/s.png" } },
      { invoke: () => port.closeTab("tab-9"), method: "closeTab", args: ["tab-9"], value: null },
      { invoke: () => port.getStatus(), method: "getStatus", args: [], value: { state: "connected", tabCount: 1 } },
      { invoke: () => port.listTabs(), method: "listTabs", args: [], value: [{ tabId: "tab-9", ownerId: "agent-1", url: "u", title: "t", lastAccessed: 1 }] },
    ];
    for (const [i, c] of cases.entries()) {
      const p = c.invoke();
      const frame = sent.at(-1)!;
      expect(frame).toEqual({ type: "tool-req", instanceId: "agent-1", reqId: i + 1, method: c.method, args: c.args });
      respond(frame.reqId, { ok: true, value: c.value });
      expect(await p).toEqual(c.value);
    }
    expect(sent).toHaveLength(cases.length); // 每调用恰好一帧
  });
});

describe("RemoteBrowserPort ② reqId 关联与回执三路", () => {
  test("乱序回执按 reqId 正确关联", async () => {
    const { port, sent, respond } = makePort();
    const p1 = port.openTab("https://a", "agent-1");
    const p2 = port.openTab("https://b", "agent-1");
    expect(sent[0]!.reqId).toBe(1);
    expect(sent[1]!.reqId).toBe(2);
    respond(2, { ok: true, value: { tabId: "tab-b" } }); // 后发的先回
    expect(await p2).toEqual({ tabId: "tab-b" });
    respond(1, { ok: true, value: { tabId: "tab-a" } });
    expect(await p1).toEqual({ tabId: "tab-a" });
  });

  test("ok:false → 拒绝并透传 daemon 中文错误文案", async () => {
    const { port, respond } = makePort();
    const p = port.closeTab("tab-x");
    respond(1, { ok: false, error: "tab tab-x 不属于实例 agent-1（或不存在）" });
    await expect(p).rejects.toThrow("tab tab-x 不属于实例 agent-1（或不存在）");
  });

  test("超时拒绝 + 迟到回执静默忽略", async () => {
    const { port, respond } = makePort({ timeoutMs: 20 });
    const p = port.openTab("https://slow", "agent-1");
    await expect(p).rejects.toThrow(/转发超时/);
    respond(1, { ok: true, value: { tabId: "tab-late" } }); // 迟到：pending 已清，静默
  });

  test("未知 reqId 回执静默忽略（不炸）", () => {
    const { port } = makePort();
    port.handleResponse({ type: "tool-res", reqId: 999, ok: true, value: null });
  });
});

describe("RemoteBrowserPort ② 退出清场与管理面 noop", () => {
  test("rejectAll：在飞全拒（reason 透传）+ 后到回执静默", async () => {
    const { port, respond } = makePort({ timeoutMs: 60_000 });
    const p1 = port.openTab("https://a", "agent-1");
    const p2 = port.listTabs();
    port.rejectAll("子进程退出清场");
    await expect(p1).rejects.toThrow("子进程退出清场");
    await expect(p2).rejects.toThrow("子进程退出清场");
    respond(1, { ok: true, value: null }); // 清场后回执静默
    respond(2, { ok: true, value: [] });
  });

  test("管理面 4 方法本地安全 noop（零 wire 帧）", async () => {
    const { port, sent } = makePort();
    await port.connect(); // noop：连接归 daemon（lazy connect 由 daemon 侧首发调用拉起）
    const unsub = port.onStatusChange(() => undefined);
    expect(typeof unsub).toBe("function");
    unsub();
    await port.stop();
    await port.reclaimOwner("agent-1");
    expect(sent).toHaveLength(0); // 管理面不上 wire（有意收窄，H-3 裁决 4）
  });
});
