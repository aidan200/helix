import type { PersistedDomainState, SessionRepositoryPort } from "../../src/application/ports/outbound/SessionRepositoryPort";

/**
 * InMemorySessionRepository —— SessionRepositoryPort 的内存假实现
 * （test/mocks，架构 §3.2：与生产 adapter 同接口不同实现，不进 src/）。
 * 真实 SQLite 落地（WAL + 单写队列）在 T1.8（SqliteSessionRepository）。
 */
export class InMemorySessionRepository implements SessionRepositoryPort {
  private readonly store = new Map<string, PersistedDomainState>();

  async save(state: PersistedDomainState): Promise<void> {
    this.store.set(state.session.sessionId, structuredClone(state));
  }

  async restore(sessionId: string): Promise<PersistedDomainState | undefined> {
    const snap = this.store.get(sessionId);
    return snap ? structuredClone(snap) : undefined;
  }

  async listSessionIds(): Promise<string[]> {
    return [...this.store.keys()];
  }
}
