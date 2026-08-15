import type { SessionRepositoryPort } from "../ports/outbound/SessionRepositoryPort";
import type { ClockPort } from "../ports/outbound/ClockPort";
import type { AgentLifecycleState } from "../../domain/agent/AgentLifecycle";
import type { ToolCallRecordData } from "../../domain/tools/ToolCallRecord";
import { Session } from "../../domain/session/Session";

/**
 * RestoreService —— 重启恢复（architecture.md §3.4 / §5.4，F(8).2）。
 *
 * 【业务语义】daemon 重启后读盘（SessionRepositoryPort）重建领域聚合
 * （Session.restoreFrom），交组合根注入 ChatService；快照经 SessionPort
 * （SessionService.getSnapshot）可推前端——「重启 daemon 后重连同样成立」
 * 是迭代验收口径的最后一环（WS 通路 T1.6 并行接线，接口对齐即可）。
 *
 * 【悬挂收口】重启时不可能有引擎 run 在飞：快照中残留的 open turn
 * （generating/toolRunning）一律收口为 interrupted——崩溃丢当前流、
 * 恢复到最后一致里程碑（AD-16 §5.3：半截流式本就未落盘，已完成条目保留）。
 *
 * 【恢复语义边界】agent 生命周期不回注（进程重启自然从 idle 起，库内
 * 最后状态仅作观测/trace）；未消费 steer 随快照 pendingSteer 保留在
 * 队列中（不自动重放到引擎——v0 无回放触发点，数据面已完整）。
 */
export interface RestoreServiceDeps {
  readonly repository: SessionRepositoryPort;
  readonly clock: ClockPort;
}

export interface RestoredDomainState {
  /** 重建后的会话聚合（open turn 已收口，可直接续对话）。 */
  readonly session: Session;
  /** 停机前最后持久化的生命周期状态（观测/trace 用，不回注进程）。 */
  readonly agentState: AgentLifecycleState;
  /** 历史工具调用记录（注入 ChatService 延续工具历史）。 */
  readonly toolCalls: readonly ToolCallRecordData[];
}

export class RestoreService {
  constructor(private readonly deps: RestoreServiceDeps) {}

  /**
   * 恢复最近一次持久化的会话；无持久化（首启）返回 undefined，
   * 调用方（组合根）据此新建会话。
   */
  async restoreLatest(): Promise<RestoredDomainState | undefined> {
    const ids = await this.deps.repository.listSessionIds();
    const latest = ids.at(-1);
    if (!latest) return undefined;
    const state = await this.deps.repository.restore(latest);
    if (!state) return undefined;
    const session = Session.restoreFrom(state.session);
    if (session.openTurn) {
      session.interruptTurn(this.deps.clock.now()); // 悬挂收口：重启无 run 在飞
    }
    return { session, agentState: state.agentState, toolCalls: state.toolCalls };
  }
}
