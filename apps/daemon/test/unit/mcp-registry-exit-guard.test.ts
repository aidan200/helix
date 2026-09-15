import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * McpRegistry onExit 身份守卫（code-review 低危，对齐 CdpConnectionManager
 * M3 close 身份守卫先例）：
 *
 * - 结构断言：addServer 的 onExit 闭包捕获 client 本体并做
 *   `servers.get(name)?.client === client` 身份比对——同名 server 移除重加后，
 *   旧 client 的迟到 onExit 不得触碰新 entry（误降级/误写 lastError）。
 * - 真体行为面（旧 client onExit 时新 entry 恰好 running 且 ready=false 的
 *   竞态窗口）需注入式 McpClient 才可确定性复现——registry 构造期直接
 *   new McpClient（无注入面），本文件以结构断言钉住守卫不回归；行为语义
 *   由 cdp-connection-manager M3 用例族（同款守卫模式）交叉覆盖。
 */

const src = readFileSync(
  path.join(import.meta.dir, "..", "..", "src", "adapters", "driven", "mcp", "McpRegistry.ts"),
  "utf8",
);

describe("McpRegistry onExit 身份守卫（code-review 低危）", () => {
  test("结构：onExit 闭包捕获 client 本体 + 注册表身份比对（M3 先例对齐）", () => {
    // onExit 闭包体在 addServer 内——截取 onExit 回调段做判据
    const onExitIdx = src.indexOf("onExit: (code) => {");
    expect(onExitIdx).toBeGreaterThan(0);
    const guardIdx = src.indexOf("current?.client !== client", onExitIdx);
    expect(guardIdx).toBeGreaterThan(onExitIdx);
    const body = src.slice(onExitIdx, src.indexOf("},", guardIdx));
    // 守卫先行 return：迟到 onExit（同名新 entry 已就位）整体 no-op
    expect(body).toContain("if (current?.client !== client) return;");
  });

  test("结构：entry 的 client 来自闭包捕获的本体（非二次 servers.get 产物）", () => {
    // addServer 内 client 先构造为局部 const，entry 引用同一本体——
    // 身份比对才有意义（entry.client === 闭包捕获 client）
    const addServerIdx = src.indexOf("async addServer(");
    const addServerBody = src.slice(addServerIdx, src.indexOf("async discover("));
    expect(addServerBody).toMatch(/const client = new McpClient\(config, \{/);
    expect(addServerBody).toMatch(/client,\n/);
  });
});
