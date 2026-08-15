import type { SessionRepositoryPort } from "../ports/outbound/SessionRepositoryPort";
import { Session } from "../../domain/session/Session";

/**
 * RestoreService —— 重启恢复（architecture.md §3.4 / §5.4）。
 *
 * 【业务语义】daemon 重启后读盘重建会话聚合（Session.restoreFrom），
 * 交组合根注入 ChatService，随后快照推前端——「重启 daemon 后重连
 * 同样成立」是迭代验收口径的最后一环。
 *
 * 【本任务边界（T1.4 骨架）】恢复主链路（最近会话 → 快照 → 重建聚合）
 * 已就位；完整恢复语义（悬挂操作收口、未消费 steer 注入回放、
 * 与 T1.8 SQLite 单写队列联测）按计划归 T1.8。
 */
export interface RestoreServiceDeps {
  readonly repository: SessionRepositoryPort;
}

export class RestoreService {
  constructor(private readonly deps: RestoreServiceDeps) {}

  /**
   * 恢复最近一次持久化的会话；无持久化（首启）返回 undefined，
   * 调用方（组合根）据此新建会话。
   */
  async restoreLatest(): Promise<Session | undefined> {
    const ids = await this.deps.repository.listSessionIds();
    const latest = ids.at(-1);
    if (!latest) return undefined;
    const snapshot = await this.deps.repository.restore(latest);
    if (!snapshot) return undefined;
    return Session.restoreFrom(snapshot);
  }
}
