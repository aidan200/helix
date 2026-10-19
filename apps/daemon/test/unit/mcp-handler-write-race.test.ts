/**
 * 评审 F2 #11：mcp 三写命令（add/update/remove）都是「读配置快照 → 整段替换落盘」。
 * update/remove 的快照取值在 run() 外（handler 同步段），落盘 await 期间到达的第二条
 * 写命令仍读到旧快照 —— 后写覆盖前写，先到达的修改被静默丢弃（add 侧注释自认 TOCTOU，
 * update/remove 同窗口且无注解）。
 *
 * 断言面：并发两条 update 落盘后，最后一次整段替换必须同时含两处修改。
 */
import { describe, expect, test } from "bun:test";

import { handleMcpServersRemove, handleMcpServersUpdate } from "../../src/adapters/driving/ws-server/handlers/mcp";
import type { McpCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import type { McpServerConfig as McpServerConfigInput } from "../../src/adapters/driven/mcp/types";

interface Rig {
  configs: McpServerConfigInput[];
  savedLists: McpServerConfigInput[][];
  errors: string[];
  update(payload: Record<string, unknown>): void;
  remove(payload: Record<string, unknown>): void;
  /** 等写链落定（含 handler 内部 async 尾段）。 */
  settle(): Promise<void>;
}

/** saveMcpServers 落盘延迟窗口（拉长以暴露并发交错）。 */
const SAVE_DELAY_MS = 10;

function rig(): Rig {
  const configs: McpServerConfigInput[] = [
    { name: "alpha", command: "run-alpha" },
    { name: "beta", command: "run-beta" },
    { name: "gamma", command: "run-gamma" },
  ];
  const savedLists: McpServerConfigInput[][] = [];
  const errors: string[] = [];
  const mkCtx = (type: string, payload: Record<string, unknown>): McpCommandContext =>
    ({
      ws: { data: {} },
      type,
      payload,
      mcp: {
        listConfigs: () => configs.map((c) => ({ ...c })),
        getStatuses: () => [],
        // 更新内存配置（模拟 registry：addServer 为同名覆盖语义）
        addServer: async (config: McpServerConfigInput) => {
          const i = configs.findIndex((c) => c.name === config.name);
          if (i >= 0) configs[i] = { ...config };
          else configs.push({ ...config });
          return { name: config.name, state: "running", toolCount: 0 };
        },
        removeServer: (name: string) => {
          const i = configs.findIndex((c) => c.name === name);
          if (i >= 0) configs.splice(i, 1);
          return true;
        },
        testServer: async () => [],
        toolsOf: () => [],
      },
      saveMcpServers: async (servers: readonly McpServerConfigInput[]) => {
        await new Promise((r) => setTimeout(r, SAVE_DELAY_MS));
        savedLists.push(servers.map((s) => ({ ...s })));
      },
      commandError: (_type: string, _code: string, message: string) => {
        errors.push(message);
      },
      rawSender: () => ({}) as never,
      sendNow: () => {},
    }) as unknown as McpCommandContext;
  return {
    configs,
    savedLists,
    errors,
    update: (payload) => handleMcpServersUpdate(mkCtx("mcp.servers.update", payload)),
    remove: (payload) => handleMcpServersRemove(mkCtx("mcp.servers.remove", payload)),
    settle: () => new Promise((r) => setTimeout(r, SAVE_DELAY_MS * 6)),
  };
}

describe("mcp 写命令并发整段替换（评审 F2 #11）", () => {
  test("并发两条 update：后写不得覆盖前写（两处修改都落盘）", async () => {
    const r = rig();
    r.update({ name: "alpha", command: "run-alpha-v2" });
    r.update({ name: "beta", command: "run-beta-v2" });
    await r.settle();

    expect(r.errors).toEqual([]);
    const last = r.savedLists[r.savedLists.length - 1]!;
    const byName = new Map(last.map((c) => [c.name, c.command]));
    expect(byName.get("alpha")).toBe("run-alpha-v2");
    expect(byName.get("beta")).toBe("run-beta-v2");
    expect(byName.get("gamma")).toBe("run-gamma"); // 未触及的行保持
  });

  test("并发 update + remove：删除不得被 update 的旧快照复活", async () => {
    const r = rig();
    r.update({ name: "alpha", command: "run-alpha-v2" });
    r.remove({ name: "beta" });
    await r.settle();

    expect(r.errors).toEqual([]);
    const last = r.savedLists[r.savedLists.length - 1]!;
    expect(last.map((c) => c.name)).toEqual(["alpha", "gamma"]);
    expect(last.find((c) => c.name === "alpha")!.command).toBe("run-alpha-v2");
  });
});
