import { describe, expect, test } from "bun:test";
import type { StewardToolSpec } from "../../src/application/ports/outbound/StewardToolSpec";
import { projectStewardTools } from "../../src/adapters/driven/steward/StewardToolBridge";

/** 工具桥单测（段B）：中立规格 → pi AgentTool 四参投影。 */
describe("StewardToolBridge：中立规格投影", () => {
  test("T1 四参直映：toolCallId/args/signal 透传 + onUpdate 包装为 AgentToolResult 分量", async () => {
    const seen: { id?: string; args?: unknown; signal?: AbortSignal; updates?: unknown[] } = { updates: [] };
    const spec: StewardToolSpec = {
      name: "probe",
      description: "d",
      parameters: { type: "object" },
      execute: async (args, ctx) => {
        seen.id = ctx.toolCallId;
        seen.args = args;
        seen.signal = ctx.signal;
        ctx.onUpdate?.("增量一");
        return { text: "ok 结果" };
      },
    };
    const [tool] = projectStewardTools([spec]);
    const ac = new AbortController();
    const result = await tool!.execute("call-1", { x: 1 }, ac.signal, (partial) => seen.updates!.push(partial));
    expect(seen.id).toBe("call-1");
    expect(seen.args).toEqual({ x: 1 });
    expect(seen.signal).toBe(ac.signal);
    expect(seen.updates).toEqual([{ content: [{ type: "text", text: "增量一" }], details: {} }]); // pi onUpdate 收结果形状
    expect(result.content).toEqual([{ type: "text", text: "ok 结果" }]);
    expect((result as { isError?: boolean }).isError).not.toBe(true);
  });

  test("T2 isError 透传（不强制——与闸 block 路径的强制 isError 区分面）", async () => {
    const spec: StewardToolSpec = {
      name: "failing",
      description: "d",
      parameters: {},
      execute: async () => ({ text: "用户拒绝", isError: true }),
    };
    const [tool] = projectStewardTools([spec]);
    const result = await tool!.execute("c", {}, undefined, undefined);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result as { content: { text: string }[] }).content[0]!.text).toBe("用户拒绝");
  });

  test("T3 terminate 透传（防火墙）+ onUpdate 缺席安全", async () => {
    const spec: StewardToolSpec = {
      name: "guard",
      description: "d",
      parameters: {},
      execute: async () => ({ text: "终止因", terminate: true }),
    };
    const [tool] = projectStewardTools([spec]);
    const result = (await tool!.execute("c", {}, undefined, undefined)) as { terminate?: boolean };
    expect(result.terminate).toBe(true);
  });

  test("T4 spec 抛错 = pi throw on failure 契约（桥不吞不转——pi agent-loop 原生承接）", async () => {
    const spec: StewardToolSpec = {
      name: "thrower",
      description: "d",
      parameters: {},
      execute: async () => {
        throw new Error("工具体异常");
      },
    };
    const [tool] = projectStewardTools([spec]);
    await expect(tool!.execute("c", {}, undefined, undefined)).rejects.toThrow("工具体异常");
  });
});
