import type {
  AgentLifecycleRowData,
  ClosureRecordData,
  DomainEventQuery,
  InstanceState,
  PersistedDomainState,
  SessionMetadataRow,
  SessionRepositoryPort,
} from "../../src/application/ports/outbound/SessionRepositoryPort";
import type { DomainEvent, InstanceClosurePayload } from "../../src/domain/events/DomainEvent";

/**
 * InMemorySessionRepository —— SessionRepositoryPort 的内存假实现
 * （test/mocks，架构 §3.2：与生产 adapter 同接口不同实现，不进 src/）。
 * 真实 SQLite 落地（WAL + 单写队列）在 T1.8（SqliteSessionRepository）。
 */
export class InMemorySessionRepository implements SessionRepositoryPort {
  private readonly store = new Map<string, PersistedDomainState>();
  /** agent_lifecycle 投影行（内存记录，T2.1；键 `${sessionId}/${instanceId}`）。 */
  private readonly lifecycles = new Map<string, InstanceState>();
  /** closure 记录行（内存追加，T2.3；报告文件假实现同目录落盘）。 */
  private closureRecords: {
    sessionId: string;
    agentId: string;
    result: "done" | "failed" | "killed";
    closure: InstanceClosurePayload;
  }[] = [];

  /** 事件流内存副本（T2.4 读面兼容：生产链事件经 WriteQueue 落盘不经本 mock，
   *  此处仅存测试显式注入的事件，供 queryEvents 过滤）。 */
  private events: DomainEvent[] = [];

  async save(state: PersistedDomainState): Promise<void> {
    this.store.set(state.session.sessionId, structuredClone(state));
  }

  async saveAgentLifecycle(sessionId: string, instanceId: string, state: InstanceState): Promise<void> {
    this.lifecycles.set(`${sessionId}/${instanceId}`, state);
  }

  async saveClosureRecord(
    sessionId: string,
    agentId: string,
    result: "done" | "failed" | "killed",
    closure: InstanceClosurePayload,
  ): Promise<void> {
    this.closureRecords.push({ sessionId, agentId, result, closure: { ...closure } });
  }

  async saveReportFile(reportPath: string, content: string): Promise<void> {
    // 假实现同样落盘（测试可断言文件产物；无 SQLite 语义，无原子性承诺）
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, content, "utf8");
  }

  /** 观测面：closure 记录（测试断言用）。 */
  recordedClosures(): readonly { sessionId: string; agentId: string; result: string; closure: InstanceClosurePayload }[] {
    return this.closureRecords;
  }

  async restore(sessionId: string): Promise<PersistedDomainState | undefined> {
    const snap = this.store.get(sessionId);
    return snap ? structuredClone(snap) : undefined;
  }

  async listSessionIds(): Promise<string[]> {
    return [...this.store.keys()];
  }

  /** T2.2 元数据读面：title 推导源 = 快照首条 user entry（真实仓 json_extract 对位）。 */
  async listSessionMetadata(): Promise<readonly SessionMetadataRow[]> {
    const rows: SessionMetadataRow[] = [];
    for (const state of this.store.values()) {
      const first = state.session.entries.find((e): e is (typeof e) & { role?: string; text?: string } => "role" in e);
      rows.push({
        sessionId: state.session.sessionId,
        createdAt: state.session.createdAt,
        updatedAt: state.session.entries.at(-1)?.createdAt ?? state.session.createdAt,
        firstUserText: first?.role === "user" ? ((first as { text: string }).text ?? null) : null,
      });
    }
    return rows;
  }

  /** T2.2 会话删除：内存仓同步清行。 */
  async deleteSession(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
    for (const key of [...this.lifecycles.keys()]) {
      if (key.startsWith(`${sessionId}/`)) this.lifecycles.delete(key);
    }
    this.closureRecords = this.closureRecords.filter((r) => r.sessionId !== sessionId);
    this.events = this.events.filter((e) => e.sessionId !== sessionId);
  }

  async queryAgentLifecycles(sessionId: string): Promise<readonly AgentLifecycleRowData[]> {
    return [...this.lifecycles]
      .filter(([key]) => key.startsWith(`${sessionId}/`))
      .map(([key, state]) => ({
        instanceId: key.slice(sessionId.length + 1),
        state,
        updatedAt: new Date(0).toISOString(),
      }));
  }

  queryClosureRecords(sessionId: string, agentId?: string): readonly ClosureRecordData[] {
    return this.closureRecords
      .filter((r) => r.sessionId === sessionId && (agentId === undefined || r.agentId === agentId))
      .map((r, i) => ({
        agentId: r.agentId,
        result: r.result,
        status: r.closure.status,
        summary: r.closure.summary,
        reportPath: r.closure.reportPath ?? null,
        findings: r.closure.findings ?? null,
        taskId: r.closure.taskId ?? null,
        createdAt: new Date(i).toISOString(),
      }));
  }

  queryEvents(query: DomainEventQuery = {}): readonly DomainEvent[] {
    return this.events.filter(
      (e) =>
        (query.sessionId === undefined || e.sessionId === query.sessionId) &&
        (query.instanceId === undefined || (e.instanceId ?? "main") === query.instanceId) &&
        (query.type === undefined || e.type === query.type) &&
        (query.since === undefined || e.occurredAt >= query.since) &&
        (query.until === undefined || e.occurredAt <= query.until),
    );
  }

  /** 测试辅助：事件注入（生产链不走；queryEvents 消费用的数据源）。 */
  pushEvents(events: readonly DomainEvent[]): void {
    this.events.push(...events.map((e) => ({ ...e })));
  }
}
