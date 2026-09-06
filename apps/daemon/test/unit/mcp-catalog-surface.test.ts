import { describe, expect, test } from "bun:test";
import type { McpRegistry } from "../../src/adapters/driven/mcp/McpRegistry";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { buildMcpCatalogSurface } from "../../src/infrastructure/assembly/mcpCatalogSurface";

/**
 * MCP catalog 闭包群（code-review M5 切片，assembly/mcpCatalogSurface）：
 * - ① onMcpDiscover 的 publish catch 兑底（M5 修复本体）：publish 经
 *   resourceEvents.publish → Promise.all 汇聚 refreshAssembly（含技能扫描
 *   fs IO）——reject 不得成 unhandled rejection（对齐 container.ts mcp 状态
 *   回调先例，mcp-ws ③ 实证同机制）；
 * - ② 物化集登记 + main-session 活跃 runtime 同步直改 setTools（切片后
 *   晚绑 getter 注入面语义不变）；
 * - ③ catalog 静态回落（registry 缺席 = 零 MCP 形态恒静态声明面）。
 */

function silentTicks(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("MCP catalog 闭包群（mcpCatalogSurface，code-review M5）", () => {
  test("onMcpDiscover：publish reject 被 catch 兑底——零 unhandled rejection + 物化集照常登记", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const surface = buildMcpCatalogSurface({
        mcpRegistry: undefined,
        effectiveToolsOf: () => [],
        hotRuntimes: () => [],
        publishResourceChanged: () => Promise.reject(new Error("refreshAssembly 模拟失败（关库窗口）")),
      });
      // 不抛同步错；reject 走 catch 兑底（未修复时 void promise → unhandledRejection）
      surface.onMcpDiscover("subagent-worker", "fs", ["fs__read", "fs__write"]);
      await silentTicks();
      expect(unhandled).toEqual([]);
      expect(surface.materializedMcp.get("subagent-worker")).toEqual(new Set(["fs__read", "fs__write"]));
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("onMcpDiscover：publish 同步返回 void（非 Promise）同样兑底不炸", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const surface = buildMcpCatalogSurface({
        mcpRegistry: undefined,
        effectiveToolsOf: () => [],
        hotRuntimes: () => [],
        publishResourceChanged: () => undefined, // PublishResourceChanged = void | Promise<void>
      });
      surface.onMcpDiscover("orchestrator", "fs", ["fs__read"]);
      await silentTicks();
      expect(unhandled).toEqual([]);
      expect(surface.materializedMcp.get("orchestrator")).toEqual(new Set(["fs__read"]));
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("onMcpDiscover：main-session 同步直改活跃 runtime setTools（读 effective 现值，晚绑 getter 注入面）", () => {
    const applied: (readonly string[])[] = [];
    const surface = buildMcpCatalogSurface({
      mcpRegistry: undefined,
      effectiveToolsOf: (kind) => (kind === "main-session" ? ["read", "grep", "fs__read"] : []),
      hotRuntimes: () => [
        { chatService: { setTools: (tools) => applied.push(tools) } },
        { chatService: { setTools: (tools) => applied.push(tools) } },
      ],
      publishResourceChanged: () => undefined,
    });
    surface.onMcpDiscover("main-session", "fs", ["fs__read"]);
    expect(applied).toEqual([
      ["read", "grep", "fs__read"],
      ["read", "grep", "fs__read"],
    ]);
    expect(surface.materializedMcp.get("main-session")).toEqual(new Set(["fs__read"]));
  });

  test("catalog 静态回落：registry 缺席时 toolsCatalog/effectiveToolsCatalog = profile 静态声明面，mcpServersOf 恒空", () => {
    const surface = buildMcpCatalogSurface({
      mcpRegistry: undefined,
      effectiveToolsOf: () => [],
      hotRuntimes: () => [],
      publishResourceChanged: () => undefined,
    });
    expect(surface.toolsCatalog("main-session")).toBe(MainSessionProfile.tools);
    expect(surface.toolsCatalog("subagent-worker")).toBe(SubAgentProfile.tools);
    expect(surface.effectiveToolsCatalog("main-session")).toBe(MainSessionProfile.tools);
    expect(surface.mcpServersOf("main-session")).toEqual([]);
    expect(surface.toolSnippetOf("fs__read")).toBeUndefined();
  });

  test("effectiveToolsCatalog：deferred server（缺省）具体工具剔除，代 meta 名 + 物化集 union", () => {
    const fakeRegistry = {
      discoveredTools: () => [
        { server: "fs", definition: { name: "read", description: "读文件", inputSchema: {} } },
        { server: "fs", definition: { name: "write", description: "写文件", inputSchema: {} } },
      ],
      listConfigs: () => [{ name: "fs", command: "npx" }], // deferred 缺省 = true
      toolsOf: () => [],
      getStatuses: () => [],
    } as unknown as McpRegistry;
    const surface = buildMcpCatalogSurface({
      mcpRegistry: fakeRegistry,
      effectiveToolsOf: () => [],
      hotRuntimes: () => [],
      publishResourceChanged: () => undefined,
    });
    // 物化前：静态全集 + meta 名（具体工具不进初始生效集）
    expect(surface.effectiveToolsCatalog("main-session")).toEqual([...MainSessionProfile.tools, "fs__discover"]);
    // discover 物化后：物化名进生效集 union（meta 保留）
    surface.onMcpDiscover("main-session", "fs", ["fs__read"]);
    expect(surface.effectiveToolsCatalog("main-session")).toEqual([...MainSessionProfile.tools, "fs__discover", "fs__read"]);
    // catalog 全集保持全量（页面展示 + toggle 域）
    expect(surface.toolsCatalog("main-session")).toEqual([...MainSessionProfile.tools, "fs__read", "fs__write"]);
  });
});
