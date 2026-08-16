import type {
  InstanceState,
  PersistedDomainState,
  SessionRepositoryPort,
} from "../../src/application/ports/outbound/SessionRepositoryPort";
import type { InstanceClosurePayload } from "../../src/domain/events/DomainEvent";

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
  private readonly closureRecords: {
    sessionId: string;
    agentId: string;
    result: "done" | "failed" | "killed";
    closure: InstanceClosurePayload;
  }[] = [];

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
}
