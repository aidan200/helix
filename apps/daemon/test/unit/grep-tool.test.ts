import { describe, expect, test } from "bun:test";
import type { ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { globToRegExp } from "../../src/adapters/driven/tools/grep/contract";
import { createGrepTool } from "../../src/adapters/driven/tools/grep/GrepTool";

/**
 * TP-CL5-2（U）：grep 工具门面的 framework-free 面——
 * ① globToRegExp（glob 路径过滤唯一实现源，contract.ts）纯函数矩阵；
 * ② unavailable 定格的响亮失败（deps 无 rgPath → execute 抛明确错误文案，
 *    零 spawn 零 fs——失败发生在任何后端调用之前）。
 * rg 真实检索行为锚在 integration 侧（grep-contract.test.ts golden fixture）。
 */

describe("globToRegExp（路径过滤的实现核）", () => {
  test("* 跨目录（grep --include 语义）、? 单字符、其余字面量转义", () => {
    expect(globToRegExp("*.ts").test("src/alpha.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("root.txt")).toBe(false);
    expect(globToRegExp("a?c.ts").test("abc.ts")).toBe(true);
    expect(globToRegExp("a?c.ts").test("ac.ts")).toBe(false);
    expect(globToRegExp("v1.0.txt").test("v1x0.txt")).toBe(false); // . 被转义为字面量
    expect(globToRegExp("v1.0.txt").test("v1.0.txt")).toBe(true);
  });
});

describe("grep 门面 unavailable 定格：响亮失败", () => {
  const fakeContext = {} as ExecutionToolContext; // 响亮失败先于任何 context 消费

  test("缺省 deps（无 rgPath）→ 抛明确错误：含原因与修复指引，不静默", async () => {
    const tool = createGrepTool();
    await expect(
      tool.execute("tc-1", { pattern: "x", path: "." }, undefined, undefined, fakeContext),
    ).rejects.toThrow(/grep 工具不可用/);
  });

  test("unavailableReasons 透传进错误文案（启动定格原因对 agent 可见）", async () => {
    const tool = createGrepTool({ unavailableReasons: ["bundle：HELIX_RG_PATH 未注入或为空", "config：未配置 rgPath"] });
    try {
      await tool.execute("tc-1", { pattern: "x", path: "." }, undefined, undefined, fakeContext);
      expect.unreachable("应抛响亮失败");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("HELIX_RG_PATH 未注入");
      expect(msg).toContain("config.json 配置 rgPath"); // 修复指引
      expect(msg).toContain("fetch-rg"); // 开发者修复路径
    }
  });
});
