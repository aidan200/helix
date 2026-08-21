import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createBrowserTools } from "../../src/adapters/driven/tools/web/BrowserTools";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { FakeBrowserPort, type BrowserPortCall } from "../mocks/FakeBrowserPort";

/**
 * T3 动态族工具（browser_* 十一工具薄转投）unit：FakeBrowserPort 记录调用，
 * 断言参数转投 / 返回值透传 / 错误通路（port 抛错 → CoreToolExecutor isError）
 * 三通路；ownerId 注入（browser_open 的 owner 归属）与 screenshot file 必填
 * 错误透传（port 层抛错原样转出）。
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
  run: (toolName: string, args: unknown) => Promise<{ content: string; isError: boolean }>;
} {
  const executor = new CoreToolExecutor({ cwd: tmpdir(), browser: port, ownerId });
  let seq = 0;
  return {
    run: (toolName, args) =>
      executor.execute({ toolCallId: `tc-browser-${++seq}`, toolName, args, signal: undefined }),
  };
}

describe("browser_* 参数转投（fake port 调用记录断言）", () => {
  test("browser_open：url + ownerId 注入（options.ownerId）；返回 {tabId}", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port, "owner-x");
    const result = await run("browser_open", { url: "https://example.com/a" });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "openTab").args).toEqual(["https://example.com/a", "owner-x"]);
    expect(JSON.parse(result.content)).toEqual({ tabId: "tab-new" });
  });

  test("browser_open：ownerId 缺省回落 main", async () => {
    const port = new FakeBrowserPort();
    const executor = new CoreToolExecutor({ cwd: tmpdir(), browser: port });
    const result = await executor.execute({
      toolCallId: "tc-open-default",
      toolName: "browser_open",
      args: { url: "https://example.com" },
      signal: undefined,
    });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "openTab").args).toEqual(["https://example.com", "main"]);
  });

  test("browser_navigate / browser_back / browser_close：tabId（+url）转投", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const navigated = await run("browser_navigate", { tabId: "tab-1", url: "https://example.com/b" });
    expect(navigated.isError).toBe(false);
    expect(lastCall(port, "navigateTab").args).toEqual(["tab-1", "https://example.com/b"]);
    await run("browser_back", { tabId: "tab-1" });
    expect(lastCall(port, "backTab").args).toEqual(["tab-1"]);
    const closed = await run("browser_close", { tabId: "tab-1" });
    expect(closed.isError).toBe(false);
    expect(lastCall(port, "closeTab").args).toEqual(["tab-1"]);
  });

  test("browser_eval：code 转投 evalInTab；返回值 JSON 序列化回投", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const result = await run("browser_eval", { tabId: "tab-1", code: "document.querySelectorAll('tr').length" });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "evalInTab").args).toEqual(["tab-1", "document.querySelectorAll('tr').length"]);
    expect(JSON.parse(result.content)).toEqual({ rows: 3 });
  });

  test("browser_click / browser_click_at：selector 转投；结果 JSON 透传", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const clicked = await run("browser_click", { tabId: "tab-1", selector: "#submit" });
    expect(lastCall(port, "clickInTab").args).toEqual(["tab-1", "#submit"]);
    expect(JSON.parse(clicked.content)).toEqual({ clicked: true, tag: "button", text: "提交" });
    const clickedAt = await run("browser_click_at", { tabId: "tab-1", selector: "#file" });
    expect(lastCall(port, "clickAtInTab").args).toEqual(["tab-1", "#file"]);
    expect(JSON.parse(clickedAt.content)).toEqual({ clicked: true, tag: "input", x: 10, y: 20 });
  });

  test("browser_set_files：files 数组转投；返回 {success,count}", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const result = await run("browser_set_files", {
      tabId: "tab-1",
      selector: "input[type=file]",
      files: ["/tmp/a.png", "/tmp/b.png"],
    });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "setFilesInTab").args).toEqual(["tab-1", "input[type=file]", ["/tmp/a.png", "/tmp/b.png"]]);
    expect(JSON.parse(result.content)).toEqual({ success: true, count: 2 });
  });

  test("browser_scroll：y/direction 可选转投（缺省 undefined 由 port 定缺省）；返回 {value}", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const withArgs = await run("browser_scroll", { tabId: "tab-1", y: 1200, direction: "up" });
    expect(lastCall(port, "scrollTab").args).toEqual(["tab-1", 1200, "up"]);
    expect(JSON.parse(withArgs.content)).toEqual({ value: "scrolled up 1200px" });
    await run("browser_scroll", { tabId: "tab-1" });
    expect(lastCall(port, "scrollTab").args).toEqual(["tab-1", undefined, undefined]);
  });

  test("browser_screenshot：file 必填转投；返回 {saved}", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const result = await run("browser_screenshot", { tabId: "tab-1", file: "/tmp/shot.png" });
    expect(result.isError).toBe(false);
    expect(lastCall(port, "screenshotTab").args).toEqual(["tab-1", "/tmp/shot.png"]);
    expect(JSON.parse(result.content)).toEqual({ saved: "/tmp/shot.png" });
  });

  test("browser_status：无参 → getStatus() + listTabs() 合并状态与 tab 清单（含 owner/闲置时长）", async () => {
    const port = new FakeBrowserPort();
    port.status = { state: "connected", browser: { id: "b1", label: "Chrome", port: 9222 }, tabCount: 1 };
    port.tabs = [
      { tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "示例", lastAccessed: Date.now() - 5_000 },
    ];
    const { run } = makeHarness(port);
    const result = await run("browser_status", {});
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

describe("browser_* 错误通路（port 抛错 → isError 透传）", () => {
  test("browser_screenshot 缺 file：port 层抛错原样透传为 isError", async () => {
    const port = new FakeBrowserPort();
    const { run } = makeHarness(port);
    const result = await run("browser_screenshot", { tabId: "tab-1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file");
  });

  test("port 方法抛错（如 eval 页面内异常）→ isError + 错误文案", async () => {
    const port = new FakeBrowserPort();
    port.failWith.set("evalInTab", new Error("页面内异常：ReferenceError: foo is not defined"));
    const { run } = makeHarness(port);
    const result = await run("browser_eval", { tabId: "tab-1", code: "foo()" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("foo is not defined");
  });
});

describe("browser_* description 策略知识（web-access 灵魂落点）", () => {
  const tools = createBrowserTools(new FakeBrowserPort(), "main");
  const byName = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `缺少工具 ${name}`).toBeDefined();
    return tool!;
  };

  test("恰 11 个工具，名集合锚定", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "browser_open",
        "browser_navigate",
        "browser_back",
        "browser_eval",
        "browser_click",
        "browser_click_at",
        "browser_set_files",
        "browser_scroll",
        "browser_screenshot",
        "browser_close",
        "browser_status",
      ].sort(),
    );
  });

  test("browser_open/browser_navigate 含就绪契约（导航后须 eval 验证 + 15 秒观察窗）", () => {
    for (const name of ["browser_open", "browser_navigate"]) {
      const description = byName(name).description;
      expect(description).toContain("browser_eval");
      expect(description).toContain("15 秒");
      expect(description).toContain("不代表目标内容已就绪");
    }
  });

  test("browser_eval 含 JSON.stringify / Shadow DOM / iframe 穿透知识", () => {
    const description = byName("browser_eval").description;
    expect(description).toContain("JSON.stringify");
    expect(description).toContain("Shadow DOM");
    expect(description).toContain("iframe");
  });

  test("browser_screenshot 含 file 必填 + read 工具读图知识", () => {
    const description = byName("browser_screenshot").description;
    expect(description).toContain("file 必填");
    expect(description).toContain("read");
  });

  test("browser_status 含连接状态与 tab 清单（owner/闲置）说明", () => {
    const description = byName("browser_status").description;
    expect(description).toContain("连接状态");
    expect(description).toContain("owner");
    expect(description).toContain("闲置");
  });
});
