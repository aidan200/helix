import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as RowMapper from "../../../src/adapters/driven/sqlite-session/rows/RowMapper";
import type { PersistedDomainState } from "../../../src/application/ports/outbound/SessionRepositoryPort";
import { Session } from "../../../src/domain/session/Session";
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
  session.appendUserEntry("第一问", "2024-01-01T00:00:01.000Z");
  const turn = session.beginTurn("e1", "2024-01-01T00:00:02.000Z");
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
