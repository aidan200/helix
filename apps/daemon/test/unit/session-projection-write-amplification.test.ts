import { describe, expect, test } from "bun:test";
import { SessionProjection } from "../../src/application/services/SessionProjection";
import { Session } from "../../src/domain/session/Session";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { SessionRepositoryPort, PersistedDomainState } from "../../src/application/ports/outbound/SessionRepositoryPort";
import type { ToolCallRecordData, ToolCallKind } from "../../src/domain/tools/ToolCallRecord";

/**
 * P1 写放大增量化（2026-11-11 087cc66e 事故回归锚）：write-through 每领域
 * 事件全量落盘（session_state 行 + steer 清空重插 + tool_calls 清空重插
 * 4420 行含 34MB images）——风暴 4 分钟 7026 事件 × 全量 = 数百 GB 写放大，
 * disk I/O error 76+ 次的直接推手。
 *
 * 增量语义：
 * 1. 主线/SubAgent 工具事件 → 单行 upsert（recordToolCall 通道），不触发
 *    全量 saveState；images 随行落盘；
 * 2. usage.recorded → 账本内存入账即可（持久化走事件行重放——恢复链
 *    restoreUsageLedger），不触发全量 saveState；
 * 3. agent.state.changed → 单行 lifecycle upsert，不触发全量 saveState；
 * 4. 条目追加/轮次/steer 类事件（message.completed 等）→ 保留全量
 *    saveState（保守默认：未知事件类型不跳过）。
 *
 * 用例锚定五层：
 * 1. 主线工具事件增量：started/result → recordToolCall 两行 upsert + 零 saveState；
 * 2. usage.recorded 跳过：零 saveState、零 recordToolCall；
 * 3. agent.state.changed 走 lifecycle 单行：saveAgentLifecycle 调 + 零 saveState；
 * 4. message.completed 保守重写：saveState 恰一次（entries 追加面不丢）；
 * 5. SubAgent 工具事件同增量：recordToolCall 调 + 不触发全量。
 */

class CountingRepository implements SessionRepositoryPort {
  saveCalls: PersistedDomainState[] = [];
  toolCallUpserts: { sessionId: string; record: ToolCallRecordData & { readonly kind: ToolCallKind } }[] = [];
  lifecycleUpserts: { sessionId: string; instanceId: string; state: string }[] = [];
  stored: PersistedDomainState | undefined;

  async save(state: PersistedDomainState): Promise<void> {
    this.saveCalls.push(state);
    this.stored = state;
  }
  async recordToolCall(sessionId: string, record: ToolCallRecordData & { readonly kind: ToolCallKind }): Promise<void> {
    this.toolCallUpserts.push({ sessionId, record });
  }
  async saveAgentLifecycle(sessionId: string, instanceId: string, state: string): Promise<void> {
    this.lifecycleUpserts.push({ sessionId, instanceId, state });
  }
  async restore(_sessionId: string): Promise<PersistedDomainState | undefined> {
    return this.stored;
  }
  async listSessionIds(): Promise<string[]> {
    return [];
  }
  async listSessionMetadata(): Promise<never[]> {
    return [];
  }
  async readSessionTail(): Promise<undefined> {
    return undefined;
  }
  async readSessionTitle(): Promise<undefined> {
    return undefined;
  }
  async deleteSession(): Promise<void> {}
  async queryAgentLifecycles(): Promise<never[]> {
    return [];
  }
  async queryOrphanInstanceLifecycles(): Promise<never[]> {
    return [];
  }
  async saveClosureRecord(): Promise<void> {}
  async saveReportFile(): Promise<void> {}
  queryClosureRecords(): never[] {
    return [];
  }
  async appendEvent(): Promise<void> {}
  queryEvents(): never[] {
    return [];
  }
  async markPendingSync(): Promise<void> {}
  async markPendingSyncNotified(): Promise<void> {}
  async queryPendingSyncSessions(): Promise<never[]> {
    return [];
  }
  async recordThinkingOverride(): Promise<void> {}
  hasSuccessfulWriteToolCall(): boolean {
    return false;
  }
  async savePendingSync(): Promise<void> {}
  queryUnnotifiedPendingSync(): never[] {
    return [];
  }
}

function makeProjection(sessionId = "s-write-amp"): { projection: SessionProjection; repo: CountingRepository; session: Session } {
  const session = Session.restoreFrom({
    sessionId,
    createdAt: new Date(0).toISOString(),
    entries: [],
    turns: [],
    pendingSteer: [],
    mainInstanceId: "agent-main-1",
    mode: "chat",
  } as never);
  const repo = new CountingRepository();
  const projection = new SessionProjection({
    repository: repo as never,
    getSession: () => session,
    getMainState: () => ({ agentState: "idle" as const, toolCalls: [] }),
  });
  return { projection, repo, session };
}

function ev(type: DomainEvent["type"], payload: unknown, over?: Partial<DomainEvent>): DomainEvent {
  return { type, sessionId: "s-write-amp", payload, occurredAt: new Date(0).toISOString(), ...over } as DomainEvent;
}

describe("SessionProjection 写放大增量化（P1）", () => {
  test("主线工具事件 → recordToolCall 两行 upsert，零全量 saveState（风暴回归锚）", () => {
    const { projection, repo } = makeProjection();
    projection.publish(
      ev("tool.call.started", { toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } }, { turnId: "t1" }),
    );
    projection.publish(
      ev("tool.call.result", { toolCallId: "tc-1", toolName: "bash", isError: false, result: "ok", images: ["data:image/png;base64,AAA"] }, { turnId: "t1" }),
    );

    expect(repo.toolCallUpserts.length).toBe(2);
    expect(repo.toolCallUpserts[0]!.record.status).toBe("running");
    expect(repo.toolCallUpserts[1]!.record.status).toBe("completed");
    expect(repo.toolCallUpserts[1]!.record.images).toEqual(["data:image/png;base64,AAA"]);
    expect(repo.saveCalls.length).toBe(0); // 核心：不触发全量
  });

  test("usage.recorded → 零 saveState 零 recordToolCall（账本内存即可）", () => {
    const { projection, repo } = makeProjection();
    projection.publish(
      ev("usage.recorded", { instanceId: "agent-main-1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, source: "turn" }, { turnId: "t1" }),
    );
    expect(repo.saveCalls.length).toBe(0);
    expect(repo.toolCallUpserts.length).toBe(0);
    expect(projection.usageSummary().total.input).toBe(1); // 账本确实入账
  });

  test("agent.state.changed → saveAgentLifecycle 单行，零 saveState", () => {
    const { projection, repo } = makeProjection();
    projection.publish(ev("agent.state.changed", { state: "running" }));
    expect(repo.lifecycleUpserts).toEqual([{ sessionId: "s-write-amp", instanceId: "agent-main-1", state: "running" }]);
    expect(repo.saveCalls.length).toBe(0);
  });

  test("message.completed（主线）→ 保留全量 saveState 恰一次（entries 追加面保守不丢）", () => {
    const { projection, repo } = makeProjection();
    projection.publish(
      ev("message.completed", { entryId: "e-1", role: "assistant", text: "回复", isSteer: false }, { turnId: "t1" }),
    );
    expect(repo.saveCalls.length).toBe(1);
  });

  test("SubAgent 工具事件同增量（内存记录 + 行 upsert，不触发全量）", () => {
    const { projection, repo } = makeProjection();
    projection.publish(
      ev("tool.call.started", { toolCallId: "tc-sub-1", toolName: "bash", args: {} }, { turnId: "t1", instanceId: "agent-2" }),
    );
    projection.publish(
      ev("tool.call.result", { toolCallId: "tc-sub-1", toolName: "bash", isError: true, result: "boom" }, { turnId: "t1", instanceId: "agent-2" }),
    );
    expect(repo.toolCallUpserts.length).toBe(2);
    expect(repo.toolCallUpserts[1]!.record.status).toBe("failed");
    expect(repo.saveCalls.length).toBe(0);
  });
});
