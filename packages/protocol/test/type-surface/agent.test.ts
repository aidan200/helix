/**
 * agent 族：编排生命周期 7 事件 payload、spawn 锚点增量帧与 instances DTO 快照面（CL-1）。
 */
import { describe, expect, test } from "bun:test";
import type { AgentInstanceDto, AgentSpawnedPayload, EventEnvelope } from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { v01Events } from "./samples/v01";
import { instanceAnchored, instanceMainNoAnchor, spawnedAnchored, spawnedStreamHead } from "./samples/v03";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
type _AgentFamily = Expect<
  Equal<
    TypeOfChannel<"agent">,
    | "agent.spawned"
    | "agent.queued"
    | "agent.started"
    | "agent.stalled"
    | "agent.completed"
    | "agent.failed"
    | "agent.killed"
    | "agent.instantiated"
    | "agent.model.changed"
    | "agent.config.changed"
    | "agent.config.list.result"
    | "agent.config.set_enabled.result"
  >
>;

// CL-1 spawn 锚点：可选 string | null（null = 流首有效值；缺省 = 主实例不携带）
type _InstanceAnchorOptional = Expect<
  Equal<AgentInstanceDto["anchorEntryId"], string | null | undefined>
>;

type _SpawnedAnchorOptional = Expect<
  Equal<AgentSpawnedPayload["anchorEntryId"], string | null | undefined>
>;

describe("agent：编排族样例帧与 spawn 锚点（源 TP-v0.1-① / TP-v0.3-①）", () => {
  test("编排族 7 事件 payload 字段结构正确", () => {
    const byType = new Map(v01Events.map((e) => [e.type, e] as const));

    const spawned = byType.get("agent.spawned");
    expect(
      spawned?.type === "agent.spawned" && spawned.payload.profileKind,
    ).toBe("subagent-worker");

    const queued = byType.get("agent.queued");
    expect(queued?.type === "agent.queued" && queued.payload.position).toBe(2);

    const stalled = byType.get("agent.stalled");
    expect(stalled?.type === "agent.stalled" && stalled.payload.idleMs).toBe(330_000);

    const completed = byType.get("agent.completed");
    expect(
      completed?.type === "agent.completed" && completed.payload.closure.status,
    ).toBe("done");
    expect(
      completed?.type === "agent.completed" && completed.payload.closure.reportPath,
    ).toBeNull();

    const failed = byType.get("agent.failed");
    expect(
      failed?.type === "agent.failed" && failed.payload.error,
    ).toBe("provider 5xx");

    const killed = byType.get("agent.killed");
    expect(
      killed?.type === "agent.killed" && killed.payload.closure.status,
    ).toBe("failed");
  });

  test("CL-1 anchorEntryId：agent.spawned 增量帧携带锚（string / null 流首）", () => {
    expect(spawnedAnchored.channel).toBe("agent");
    expect(
      spawnedAnchored.type === "agent.spawned" && spawnedAnchored.payload.anchorEntryId,
    ).toBe("e12");
    expect(
      spawnedStreamHead.type === "agent.spawned" && spawnedStreamHead.payload.anchorEntryId,
    ).toBeNull(); // null = 流首锚点（有效值，非缺失）
  });

  test("CL-1 anchorEntryId：instances DTO 快照面同源供给（主实例缺省不携带）", () => {
    expect(instanceAnchored.anchorEntryId).toBe("e12");
    expect(instanceMainNoAnchor.anchorEntryId).toBeUndefined(); // kind=main：无卡片无锚
    expect(instanceMainNoAnchor.kind).toBe("main");
  });

});
