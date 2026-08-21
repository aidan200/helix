import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as RowMapper from "../../../src/adapters/driven/sqlite-session/rows/RowMapper";
import type { AgentLifecycleRow } from "../../../src/adapters/driven/sqlite-session/rows/Rows";
import type { PersistedDomainState } from "../../../src/application/ports/outbound/SessionRepositoryPort";
import { Session } from "../../../src/domain/session/Session";
import type { SessionSnapshot } from "../../../src/domain/session/SessionSnapshot";
import type { SessionUsageSummary } from "../../../src/domain/session/SessionSnapshot";
import type { AgentInstanceData } from "../../../src/domain/agent/AgentInstance";
import { ToolCallRecord } from "../../../src/domain/tools/ToolCallRecord";
import type { DomainEvent } from "../../../src/domain/events/DomainEvent";

/**
 * TP-CL8-5（U+A 半）：贫血/充血转换归属——
 * ① RowMapper 往返等价：PersistedDomainState ↔ 行模型（充血↔贫血转换在 adapter）；
 * ② DomainEvent ↔ domain_events 行往返（payload JSON 保持语义）；
 * ③ 模型隔离：domain/ 不 import adapters（含 rows/ 贫血模型）。
 */
function richState(): PersistedDomainState {
  const session = Session.create("s-rm", "2024-01-01T00:00:00.000Z");
  session.appendUserEntry("第一问", "2024-01-01T00:00:01.000Z");  const turn = session.beginTurn("e1", "2024-01-01T00:00:02.000Z");
  session.appendAssistantEntry("第一答", "2024-01-01T00:00:03.000Z");
  session.completeTurn("2024-01-01T00:00:04.000Z");
  void turn;
  const steerTurn = session.beginTurn("e2", "2024-01-01T00:00:05.000Z");
  session.applySteer("运行中注入", "2024-01-01T00:00:06.000Z"); // pendingSteer 非空
  void steerTurn;

  const completed = ToolCallRecord.create("tc-1", "bash", { command: "echo hi" });
  completed.markRunning("2024-01-01T00:00:07.000Z");
  completed.complete("hi", "2024-01-01T00:00:08.000Z");
  const failed = ToolCallRecord.create("tc-2", "read", { path: "/x" });
  failed.markRunning("2024-01-01T00:00:09.000Z");
  failed.fail("no such file", "2024-01-01T00:00:10.000Z");
  const running = ToolCallRecord.create("tc-3", "grep", { pattern: "a" });
  running.markRunning("2024-01-01T00:00:11.000Z");

  return {
    session: session.toSnapshot(),
    agentState: "steering",
    toolCalls: [completed.toData(), failed.toData(), running.toData()],
  };
}

describe("TP-CL8-5：RowMapper 往返等价", () => {
  test("① PersistedDomainState → 行 → PersistedDomainState 深等价（四类状态）", () => {
    const state = richState();
    const rows = RowMapper.persistedStateToRows(state);
    const back = RowMapper.rowsToPersistedState(rows.session, rows.lifecycle, rows.steer, rows.toolCalls);

    expect(back.session).toEqual(state.session); // 会话聚合（Entry 树/轮次/pendingSteer）
    expect(back.agentState).toBe(state.agentState); // agent 生命周期
    expect(back.toolCalls).toEqual(state.toolCalls); // 工具调用记录（含 running/failed/completed 三态）
    // steer 队列类在快照 pendingSteer 内往返
    expect(back.session.pendingSteer).toEqual([{ entryId: "e3", text: "运行中注入" }]);
  });

  test("② DomainEvent → 行 → DomainEvent 等价（payload JSON 往返）", () => {
    const event: DomainEvent = {
      type: "tool.call.result",
      sessionId: "s-rm",
      turnId: "t1",
      payload: { toolCallId: "tc-1", toolName: "bash", isError: false, result: "hi" },
      occurredAt: "2024-01-01T00:00:08.000Z",
    };
    const row = RowMapper.domainEventToRow(event, "main");
    expect(row.session_id).toBe("s-rm");
    expect(row.agent_kind).toBe("main");
    expect(row.type).toBe("tool.call.result");
    expect(row.ts).toBe(event.occurredAt);
    expect(JSON.parse(row.payload)).toEqual(event.payload);

    const back = RowMapper.rowToDomainEvent(row);
    expect(back.type).toBe(event.type);
    expect(back.sessionId).toBe(event.sessionId);
    expect(back.payload).toEqual(event.payload);
    expect(back.occurredAt).toBe(event.occurredAt);
  });

  test("③ 重建后行为延续：restoreFrom 快照可继续开新轮（计数器不回卷）", () => {
    const state = richState();
    const rows = RowMapper.persistedStateToRows(state);
    const back = RowMapper.rowsToPersistedState(rows.session, rows.lifecycle, rows.steer, rows.toolCalls);
    const session = Session.restoreFrom(back.session);
    // 收口恢复出的 open turn 后可继续对话
    session.interruptTurn("2024-01-01T00:09:00.000Z");
    const entry = session.appendUserEntry("重启后新问", "2024-01-01T00:09:01.000Z");
    expect(entry.id).toBe("e4"); // 计数器从数据推导，不回卷
  });

  test("T9 图片：user Entry images 经 session_state JSON 列往返不丢（持久化一致性专项）", () => {    const session = Session.create("s-img", "2024-01-01T00:00:00.000Z");
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    session.appendUserEntry("看图", "2024-01-01T00:00:01.000Z", [dataUrl, dataUrl]);
    const rows = RowMapper.persistedStateToRows({
      session: session.toSnapshot(),
      agentState: "idle",
      toolCalls: [],
    });
    // entries 为 JSON 文本列——images 字段序列化在线格式内
    const rawEntries = JSON.parse(rows.session.entries) as { images?: string[] }[];
    expect(rawEntries[0]?.images).toEqual([dataUrl, dataUrl]);
    // 往返等价：解析回 PersistedDomainState 后 images 原样保留
    const back = RowMapper.rowsToPersistedState(rows.session, rows.lifecycle, rows.steer, rows.toolCalls);
    expect(back.session.entries[0]).toMatchObject({ role: "user", text: "看图", images: [dataUrl, dataUrl] });
    // restoreFrom 重建聚合同样携带（RestoreService 投影重建链）
    const restored = Session.restoreFrom(back.session);
    expect(restored.entryList()[0]).toMatchObject({ images: [dataUrl, dataUrl] });
  });

  test("T9 图片：ToolCallRecord images 经 tool_calls.images JSON 列往返不丢（持久化一致性专项）", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const withImages = ToolCallRecord.create("tc-img", "browser", { action: "screenshot" });
    withImages.markRunning("2024-01-01T00:00:07.000Z");
    withImages.complete('{"saved":"/tmp/s.png"}', "2024-01-01T00:00:08.000Z", [dataUrl]);
    const withoutImages = ToolCallRecord.create("tc-plain", "bash", { command: "echo hi" });
    withoutImages.markRunning("2024-01-01T00:00:09.000Z");
    withoutImages.complete("hi", "2024-01-01T00:00:10.000Z");

    const session = Session.create("s-timg", "2024-01-01T00:00:00.000Z");
    const rows = RowMapper.persistedStateToRows({
      session: session.toSnapshot(),
      agentState: "idle",
      toolCalls: [withImages.toData(), withoutImages.toData()],
    });
    // images 列 = data URL 数组 JSON 文本；无图记录 = null
    const imgRow = rows.toolCalls.find((t) => t.id === "tc-img");
    const plainRow = rows.toolCalls.find((t) => t.id === "tc-plain");
    expect(imgRow?.images).toBe(JSON.stringify([dataUrl]));
    expect(plainRow?.images).toBeNull();

    // 往返等价：images 原样恢复；无图记录不带字段（线格式保持旧形状）
    const back = RowMapper.rowsToPersistedState(rows.session, rows.lifecycle, rows.steer, rows.toolCalls);
    expect(back.toolCalls.find((t) => t.id === "tc-img")?.images).toEqual([dataUrl]);
    expect(back.toolCalls.find((t) => t.id === "tc-plain")?.images).toBeUndefined();
    // ToolCallRecord.restore 重建后 toData 同源（恢复→再持久化幂等）
    const restoredRecord = ToolCallRecord.restore(back.toolCalls[0]!);
    expect(restoredRecord.toData().images).toEqual([dataUrl]);
  });
});

describe("TP-CL8-5（A 半）：模型隔离", () => {
  test("domain/ 不 import adapters（贫血 rows 模型不进 domain）", () => {
    const domainRoot = path.join(import.meta.dir, "..", "..", "..", "src", "domain");
    const offenders: string[] = [];
    for (const rel of readdirSync(domainRoot, { recursive: true }) as string[]) {
      if (!rel.endsWith(".ts")) continue;
      const src = readFileSync(path.join(domainRoot, rel), "utf8");
      if (src.includes("/adapters/") || src.includes("/rows/")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

/** TR-AD-14（iter-20260816-uzvg T1.2）：instanceId 新列往返与旧行兜底。 */
describe("F1.7：instanceId 新列 RowMapper 往返（TR-AD-14）", () => {
  test("① DomainEvent 带 instanceId → 行带 agent_instance_id；缺省 → main（缺省=主实例）", () => {
    const sub: DomainEvent = {
      type: "message.completed",
      sessionId: "s-rm",
      instanceId: "agent-3",
      turnId: "t1",
      payload: { entryId: "e9" },
      occurredAt: "2024-01-01T00:00:08.000Z",
    };
    const subRow = RowMapper.domainEventToRow(sub, "subagent");
    expect(subRow.agent_instance_id).toBe("agent-3");

    const main = { ...sub, instanceId: undefined };
    const mainRow = RowMapper.domainEventToRow(main, "main");
    expect(mainRow.agent_instance_id).toBe("main"); // O-3/O-4：缺省回填主实例固定 id
  });

  test("② 行 → 事件：agent_instance_id 往返；旧行无列值 → fromRow 兜底 main", () => {
    const row = {
      session_id: "s-rm",
      agent_kind: "main",
      agent_instance_id: "agent-3",
      type: "tool.call.result",
      payload: JSON.stringify({ toolCallId: "tc-1" }),
      ts: "2024-01-01T00:00:08.000Z",
    };
    const back = RowMapper.rowToDomainEvent(row);
    expect(back.instanceId).toBe("agent-3");

    // 旧行（升级前写入，无 agent_instance_id 值）：fromRow 默认值兜底（TR-AD-14）
    const legacyRow = { ...row, agent_instance_id: undefined } as unknown as typeof row;
    expect(RowMapper.rowToDomainEvent(legacyRow).instanceId).toBe("main");
  });

  test("③ agent_lifecycle 复合 PK 行：toRow 写 main 实例行；旧单列行 → 兜底 main", () => {
    const state = richState();
    const rows = RowMapper.persistedStateToRows(state);
    expect(rows.lifecycle.instance_id).toBe("main"); // 主会话状态投影到 main 实例行

    // 旧行形状（v0 单列 PK 时代）：无 instance_id 列值 → 兜底 main
    const back = RowMapper.rowsToPersistedState(
      rows.session,
      { session_id: "s-rm", state: "idle", updated_at: "2024-01-01T00:00:00.000Z" } as unknown as AgentLifecycleRow,
      [],
      [],
    );
    expect(back.agentState).toBe("idle");
  });

  test("④ tool_calls.instance_id：toRow 写 main；旧行无列值 → 兜底 main", () => {
    const state = richState();
    const rows = RowMapper.persistedStateToRows(state);
    expect(rows.toolCalls.every((t) => t.instance_id === "main")).toBe(true);

    const back = RowMapper.rowsToPersistedState(
      rows.session,
      rows.lifecycle,
      [],
      rows.toolCalls.map((t) => ({ ...t, instance_id: undefined }) as unknown as typeof t),
    );
    expect(back.toolCalls).toHaveLength(3); // 兜底不丢行（instance_id 由默认值补齐）
  });

  test("⑤ 快照占位字段 instances/usage：形状对齐契约 §6.2，不阻断聚合重建（装配与落盘归 T2.x）", () => {
    const state = richState();
    const usage: SessionUsageSummary = {
      total: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 10, totalTokens: 160, cost: 0.5 },
      compaction: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 25, cost: 0.1 },
    };
    const instances: readonly AgentInstanceData[] = [
      { instanceId: "main", kind: "main", profileKind: "main-session", sessionId: "s-rm", state: "running", createdAt: "2024-01-01T00:00:00.000Z" },
      { instanceId: "agent-1", kind: "subagent", profileKind: "subagent-worker", sessionId: "s-rm", state: "done", createdAt: "2024-01-01T00:00:05.000Z" },
    ];
    const snapshot: SessionSnapshot = { ...state.session, instances, usage };

    // 占位字段在快照上合法携带；聚合重建不受影响（Entry 树带 instanceId 可查）
    const restored = Session.restoreFrom(snapshot);
    expect(restored.entryList().every((e) => e.instanceId === "main")).toBe(true);
    expect(restored.entryList().map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    // T1.2 边界：instances 清单的权威投影在 agent_lifecycle 每实例行；快照装配/落盘由 T2.x 接
  });
});
