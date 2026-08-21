import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createBrowserTool } from "../../src/adapters/driven/tools/web/BrowserTools";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { FakeBrowserPort, type BrowserPortCall } from "../mocks/FakeBrowserPort";

/**
 * T3r 动态族返工：单 browser 工具 + action 参数（用户裁决——11 个 browser_*
 * 独立工具折叠为一个，LLM 显式选 action，无自然语言路由）。unit 断言面：
 * FakeBrowserPort 记录调用，逐 action 断言参数转投 / 返回值透传 / 必填参数
 * 缺失中文错误 / port 抛错 → isError 错误通路；description 四项策略知识断言。
 *
 * 工具层零 CDP 知识——断言面只看 port 方法调用记录（薄转投的机械证明）。
 */

function lastCall(port: FakeBrowserPort, method: string): BrowserPortCall {
  const call = port.lastCall(method);
  expect(call, `fake port 应记录 ${method} 调用`).toBeDefined();
  return call!;
}

/** 经 CoreToolExecutor.execute 走真实执行链（工具异常 → isError 即被测面）。 */
function makeHarness(port: FakeBrowserPort, ownerId = "main"): {
  run: (args: unknown) => Promise<{ content: string; isError: boolean }>;
} {
  const executor = new CoreToolExecutor({ cwd: tmpdir(), browser: port, ownerId });
  let seq = 0;
  return {
    run: (args) =>
      executor.execute({ toolCallId: `tc-browser-${++seq}`, toolName: "browser", args, signal: undefined }),
  };
}

describe("browser action 分发（fake port 调用记录逐 action 断言）", () => {
  test("action=open：url + ownerId 注入（options.ownerId）；返回 {tabId}", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port, "owner-x");
    const result = await run({ action: "open", url: "https://example.com/a" });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "openTab").args).toEqual(["https://example.com/a", "owner-x"]);
    expect(JSON.parse(result.content)).toEqual({ tabId: "tab-new" });
  });

  test("action=open：ownerId 缺省回落 main", async () => {
    const port = new FakeBrowserPort();
    const executor = new CoreToolExecutor({ cwd: tmpdir(), browser: port });
    const result = await executor.execute({
      toolCallId: "tc-open-default",
      toolName: "browser",
      args: { action: "open", url: "https://example.com" },
      signal: undefined,
    });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "openTab").args).toEqual(["https://example.com", "main"]);
  });

  test("action=navigate / back / close：tabId（+url）转投", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const navigated = await run({ action: "navigate", tabId: "tab-1", url: "https://example.com/b" });
    expect(navigated.isError).toBe(false);
    expect(lastCall(port, "navigateTab").args).toEqual(["tab-1", "https://example.com/b"]);
    await run({ action: "back", tabId: "tab-1" });
    expect(lastCall(port, "backTab").args).toEqual(["tab-1"]);
    const closed = await run({ action: "close", tabId: "tab-1" });
    expect(closed.isError).toBe(false);
    expect(lastCall(port, "closeTab").args).toEqual(["tab-1"]);
  });

  test("action=eval：code 转投 evalInTab；返回值 JSON 序列化回投", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const result = await run({ action: "eval", tabId: "tab-1", code: "document.querySelectorAll('tr').length" });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "evalInTab").args).toEqual(["tab-1", "document.querySelectorAll('tr').length"]);
    expect(JSON.parse(result.content)).toEqual({ rows: 3 });
  });

  test("action=click / click_at：selector 转投；结果 JSON 透传", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const clicked = await run({ action: "click", tabId: "tab-1", selector: "#submit" });
    expect(lastCall(port, "clickInTab").args).toEqual(["tab-1", "#submit"]);
    expect(JSON.parse(clicked.content)).toEqual({ clicked: true, tag: "button", text: "提交" });
    const clickedAt = await run({ action: "click_at", tabId: "tab-1", selector: "#file" });
    expect(lastCall(port, "clickAtInTab").args).toEqual(["tab-1", "#file"]);
    expect(JSON.parse(clickedAt.content)).toEqual({ clicked: true, tag: "input", x: 10, y: 20 });
  });

  test("action=set_files：files 数组转投；返回 {success,count}", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const result = await run({
      action: "set_files",
      tabId: "tab-1",
      selector: "input[type=file]",
      files: ["/tmp/a.png", "/tmp/b.png"],
    });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "setFilesInTab").args).toEqual(["tab-1", "input[type=file]", ["/tmp/a.png", "/tmp/b.png"]]);
    expect(JSON.parse(result.content)).toEqual({ success: true, count: 2 });
  });

  test("action=scroll：y/direction 可选转投（缺省 undefined 由 port 定缺省）；返回 {value}", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const withArgs = await run({ action: "scroll", tabId: "tab-1", y: 1200, direction: "up" });
    expect(lastCall(port, "scrollTab").args).toEqual(["tab-1", 1200, "up"]);
    expect(JSON.parse(withArgs.content)).toEqual({ value: "scrolled up 1200px" });
    await run({ action: "scroll", tabId: "tab-1" });
    expect(lastCall(port, "scrollTab").args).toEqual(["tab-1", undefined, undefined]);
  });

  test("action=screenshot：file 必填转投；返回 {saved}", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const result = await run({ action: "screenshot", tabId: "tab-1", file: "/tmp/shot.png" });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "screenshotTab").args).toEqual(["tab-1", "/tmp/shot.png"]);
    expect(JSON.parse(result.content)).toEqual({ saved: "/tmp/shot.png" });
  });

  test("action=status：getStatus() + listTabs() 合并状态与 tab 清单（含 owner/闲置时长）", async () => {
    const port = new FakeBrowserPort();
    port.status = { state: "connected", browser: { id: "b1", label: "Chrome", port: 9222 }, tabCount: 1 };
    port.tabs = [
      { tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "示例", lastAccessed: Date.now() - 5_000 },
    ];
    const { run } = makeHarness(port);
    const result = await run({ action: "status" });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "getStatus")).toBeDefined();
    expect(lastCall(port, "listTabs")).toBeDefined();
    const payload = JSON.parse(result.content);
    expect(payload.status).toEqual({ state: "connected", browser: { id: "b1", label: "Chrome", port: 9222 }, tabCount: 1 });
    expect(payload.tabs).toHaveLength(1);
    expect(payload.tabs[0].tabId).toBe("tab-1");
    expect(payload.tabs[0].ownerId).toBe("main");
    expect(payload.tabs[0].idleMs).toBeGreaterThanOrEqual(5_000);
  });
});

describe("browser 必填参数校验（缺失 → 中文错误，经执行链转 isError）", () => {
  const port = new FakeBrowserPort();
  const { run } = makeHarness(port);

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["open", { action: "open" }, "action=open 需要 url 参数"],
    ["navigate 缺 url", { action: "navigate", tabId: "tab-1" }, "action=navigate 需要 url 参数"],
    ["eval 缺 code", { action: "eval", tabId: "tab-1" }, "action=eval 需要 code 参数"],
    ["click 缺 selector", { action: "click", tabId: "tab-1" }, "action=click 需要 selector 参数"],
    ["click_at 缺 selector", { action: "click_at", tabId: "tab-1" }, "action=click_at 需要 selector 参数"],
    ["set_files 缺 files", { action: "set_files", tabId: "tab-1", selector: "input" }, "action=set_files 需要 files 参数"],
    ["screenshot 缺 file", { action: "screenshot", tabId: "tab-1" }, "action=screenshot 需要 file 参数"],
  ];
  for (const [label, args, message] of cases) {
    test(`${label}：${message}`, async () => {
      const result = await run(args);
      expect(result.isError).toBe(true);
      expect(result.content).toContain(message);
    });
  }

  test("tabId 必填（除 open/status）：eval 缺 tabId → 中文错误", async () => {
    const result = await run({ action: "eval", code: "1+1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("action=eval 需要 tabId 参数");
  });

  test("未知 action → 中文错误（列合法枚举）", async () => {
    const result = await run({ action: "hack", tabId: "tab-1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("未知 action");
  });

  test("参数校验失败不触达 port（无调用记录）", async () => {
    const fresh = new FakeBrowserPort();
    const { run: runFresh } = makeHarness(fresh);
    await runFresh({ action: "eval", code: "1+1" });
    expect(fresh.calls.filter((c) => c.method === "evalInTab")).toHaveLength(0);
  });
});

describe("browser 错误通路（port 抛错 → isError 透传）", () => {
  test("port 方法抛错（如 eval 页面内异常）→ isError + 错误文案", async () => {
    const port = new FakeBrowserPort();
    port.failWith.set("evalInTab", new Error("页面内异常：ReferenceError: foo is not defined"));
    const { run } = makeHarness(port);
    const result = await run({ action: "eval", tabId: "tab-1", code: "foo()" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("foo is not defined");
  });
});

describe("browser description 策略知识（单工具承载全部；web-access 灵魂落点）", () => {
  const tool = createBrowserTool(new FakeBrowserPort(), "main");

  test("单工具名锚定 browser；action 枚举恰 11 个", () => {
    expect(tool.name).toBe("browser");
    const actionSchema = (tool.parameters as { properties: { action: { enum: string[] } } }).properties.action;
    expect([...actionSchema.enum].sort()).toEqual(
      ["open", "navigate", "back", "eval", "click", "click_at", "set_files", "scroll", "screenshot", "close", "status"].sort(),
    );
  });

  test("就绪契约：open/navigate 返回不代表目标内容就绪，导航后须 eval 验证 + 15 秒观察窗", () => {
    expect(tool.description).toContain("不代表目标内容已就绪");
    expect(tool.description).toContain("eval");
    expect(tool.description).toContain("15 秒");
  });

  test("eval 知识：JSON.stringify 序列化 / Shadow DOM / iframe 穿透", () => {
    expect(tool.description).toContain("JSON.stringify");
    expect(tool.description).toContain("Shadow DOM");
    expect(tool.description).toContain("iframe");
  });

  test("screenshot 知识：file 必填 + read 工具读图", () => {
    expect(tool.description).toContain("file 必填");
    expect(tool.description).toContain("read");
  });

  test("status 知识：连接状态与 tab 清单（owner/闲置）", () => {
    expect(tool.description).toContain("连接状态");
    expect(tool.description).toContain("owner");
    expect(tool.description).toContain("闲置");
  });
});
