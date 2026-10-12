import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "../../src/adapters/driven/tools/vendor/pi-harness";
import { createAgentSpawnTool } from "../../src/adapters/driven/tools/agent/AgentOrchestrationTools";
import type { AgentOrchestrationPort, SpawnOutcome } from "../../src/application/ports/inbound/AgentOrchestrationPort";

/**
 * agent_spawn 派发原子化参数面（batchId additive）：
 * - batchId 携带 → 透传编排口 options.batchId；回执携 wiring 结果；
 * - 编排口不接线（非任务会话）→ 回执 batchIdIgnored:true 明示忽略；
 * - 不携带 batchId → 行为与历史完全一致（回执无 wiring/batchIdIgnored 键）。
 */

interface Recorded {
  readonly task: string;
  readonly options?: { writes?: string; batchId?: string };
}

function rig(outcome: SpawnOutcome): {
  tool: ReturnType<typeof createAgentSpawnTool>;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const orchestration = {
    spawn: (task: string, _profileKind?: string, _reportIntervalMs?: number, options?: { writes?: any; batchId?: string }) => {
      calls.push({ task, options });
      return outcome;
    },
    send: () => ({ delivered: false, detail: "" }),
    status: () => [],
    inspect: () => null,
    kill: () => ({ killed: true as const }),
    park: () => ({ parked: true as const }),
    resume: () => ({ resumed: true as const, queued: false as const }),
  } as unknown as AgentOrchestrationPort;
  return { tool: createAgentSpawnTool(orchestration), calls };
}

function run(tool: ReturnType<typeof createAgentSpawnTool>, params: Record<string, unknown>) {
  return tool.execute("call-1", params as never, undefined as never, undefined as never, undefined as never, BACKGROUND_CONTEXT);
}

function resultJson(result: Awaited<ReturnType<typeof run>>): Record<string, unknown> {
  const first = result.content[0] as { type: string; text?: string } | undefined;
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
}

describe("agent_spawn 参数面（派发原子化 batchId）", () => {
  test("schema：batchId 可选（在 properties、不在 required）", () => {
    const { tool } = rig({ status: "run", agentId: "agent-1" });
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("batchId");
    expect(params.required).toEqual(["task"]);
  });

  test("携带 batchId → 透传 options.batchId，回执含 wiring 落章结果", async () => {
    const { tool, calls } = rig({ status: "run", agentId: "agent-1", wiring: { status: "dispatched" } });
    const body = resultJson(await run(tool, { task: "干活", batchId: "batch-9" }));
    expect(calls[0]!.options).toEqual({ writes: undefined, batchId: "batch-9" });
    expect(body.agentId).toBe("agent-1");
    expect(body.spawned).toBe(true);
    expect(body.wiring).toEqual({ status: "dispatched" });
    expect(body.batchIdIgnored).toBeUndefined();
  });

  test("converted-failed 接线 → 回执携 note（重派提示）", async () => {
    const { tool } = rig({
      status: "run",
      agentId: "agent-1",
      wiring: { status: "converted-failed", retryScheduled: true },
    });
    const body = resultJson(await run(tool, { task: "干活", batchId: "batch-9" }));
    expect(body.wiring).toEqual({ status: "converted-failed", retryScheduled: true });
    expect(String(body.note)).toContain("引擎将自动重派");
  });

  test("携带 batchId 但编排口未接线（非任务会话）→ 回执 batchIdIgnored:true", async () => {
    const { tool } = rig({ status: "run", agentId: "agent-1" });
    const body = resultJson(await run(tool, { task: "干活", batchId: "batch-9" }));
    expect(body.batchIdIgnored).toBe(true);
    expect(body.wiring).toBeUndefined();
  });

  test("不携带 batchId → 行为不变（回执无 wiring/batchIdIgnored 键）", async () => {
    const { tool, calls } = rig({ status: "run", agentId: "agent-1" });
    const body = resultJson(await run(tool, { task: "干活" }));
    expect(calls[0]!.options?.batchId).toBeUndefined();
    expect(body.wiring).toBeUndefined();
    expect(body.batchIdIgnored).toBeUndefined();
    expect(body).toEqual({ agentId: "agent-1", spawned: true, queued: false });
  });

  test("queued 形态回执保持排队语义（position + wiring 并存）", async () => {
    const { tool } = rig({ status: "queued", agentId: "agent-2", position: 3, wiring: { status: "dispatched" } });
    const body = resultJson(await run(tool, { task: "干活", batchId: "batch-9" }));
    expect(body).toMatchObject({ agentId: "agent-2", queued: true, position: 3, wiring: { status: "dispatched" } });
  });
});
