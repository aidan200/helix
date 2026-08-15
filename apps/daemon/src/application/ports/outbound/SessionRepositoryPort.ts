import type { SessionSnapshot } from "../../../domain/session/SessionSnapshot";

/**
 * 领域状态持久化出口端口（outbound，architecture.md §3.4 / §5.2）。
 *
 * write-through 单写队列的出口：service 在里程碑后 save 快照（领域状态整体）；
 * 恢复时 restore。本任务（T1.4）用 InMemory 假实现（test/mocks），
 * 真实 SQLite 落地在 T1.8（sqlite-session 适配器 + WriteQueue）。
 * 本文件只有接口定义（AG-01）。
 */
export interface SessionRepositoryPort {
  /** 保存会话快照（幂等覆盖，同 sessionId）。 */
  save(snapshot: SessionSnapshot): Promise<void>;
  /** 按 id 读取快照；不存在返回 undefined。 */
  restore(sessionId: string): Promise<SessionSnapshot | undefined>;
  /** 已持久化的会话 id 列表（恢复入口用，按创建序）。 */
  listSessionIds(): Promise<string[]>;
}
