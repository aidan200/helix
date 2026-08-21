import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { FakeBrowserPort } from "../mocks/FakeBrowserPort";

/**
 * T3r 动态族返工 integration：单 browser 工具 + action 参数（用户裁决——
 * 11 个 browser_* 独立工具折叠为一个）。CoreToolExecutor 条件注册
 *（orchestration 先例）+ main 全集装配走通（FakeBrowserPort 记录桩）。
 *
 * ① 无 options.browser → "browser" 不在注册表（resolveTools 抛错）；
 *    SubAgent 子进程形态（ChildMain 只传 cwd）不受影响——本测试即该形态的
 *    机械证明（P0-1 决策：子进程无动态族）。
 * ② 有 options.browser → 单名 "browser" 注册；resolveTools(MainSessionProfile.tools)
 *    全集 11 名一次装配成功（组合根 engineFor 同款接线：browser + ownerId）；
 * ③ execute(browser status) 经真实执行链走通（fake port getStatus+listTabs）。
 */

describe("CoreToolExecutor 条件注册（options.browser 先例 = orchestration）", () => {
  test("① 无 browser（SubAgent 子进程形态）：\"browser\" 不在注册表", () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir() });
    expect(() => executor.resolveTools(["browser"]), "browser 不应注册").toThrow(/不在注册表/);
    // 静态族与内置五工具仍在（条件注册只影响动态族）
    expect(executor.resolveTools(["bash", "read", "write", "edit", "grep", "web_search", "web_fetch"])).toHaveLength(7);
  });

  test("② 有 browser：单名注册；main 全集 11 名一次装配成功", () => {
    // 组合根 engineFor 同款接线：orchestration（会话门面）+ browser + ownerId
    const orchestration = {
      spawn: (task: string) => ({ status: "rejected", error: `测试桩不 spawn：${task}` }) as const,
      send: () => ({ delivered: false, detail: "测试桩不投递" }),
      status: () => [],
      kill: () => ({ killed: false, error: "测试桩不 kill" }),
    };
    const executor = new CoreToolExecutor({
      cwd: tmpdir(),
      orchestration,
      browser: new FakeBrowserPort(),
      ownerId: "main",
    });
    expect(MainSessionProfile.tools).toHaveLength(11); // 10 既有 + 动态族单 browser
    const resolved = executor.resolveTools(MainSessionProfile.tools);
    expect(resolved.map((t) => t.name)).toEqual([...MainSessionProfile.tools]);
    expect(resolved.some((t) => t.name === "browser"), "browser 应装配").toBe(true);
  });
});

describe("装配后 execute 走通（fake port）", () => {
  test("③ action=status：idle 状态 + 空 tab 清单经执行链返回", async () => {
    const executor = new CoreToolExecutor({ cwd: tmpdir(), browser: new FakeBrowserPort(), ownerId: "main" });
    const result = await executor.execute({
      toolCallId: "tc-t3r-status",
      toolName: "browser",
      args: { action: "status" },
      signal: undefined,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ status: { state: "idle", tabCount: 0 }, tabs: [] });
  });

  test("④ action=open 经执行链转投（ownerId 缺省 main）", async () => {
    const port = new FakeBrowserPort();
    const executor = new CoreToolExecutor({ cwd: tmpdir(), browser: port, ownerId: "main" });
    const result = await executor.execute({
      toolCallId: "tc-t3r-open",
      toolName: "browser",
      args: { action: "open", url: "https://example.com" },
      signal: undefined,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ tabId: "tab-new" });
    expect(port.lastCall("openTab")?.args).toEqual(["https://example.com", "main"]);
  });
});
