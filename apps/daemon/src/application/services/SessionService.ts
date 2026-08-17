import type { SessionPort, SessionStateView, SessionStreamEvent } from "../ports/inbound/SessionPort";
import type { AgentLifecycleState } from "../../domain/agent/AgentLifecycle";

/**
 * SessionService —— 会话状态入口（architecture.md §3.4）。
 *
 * 【业务语义】重连/重启恢复的取数面：前端（或 CLI）先拿全量快照
 * （getSnapshot），再消费增量事件流（subscribe）——「快照 + 增量」
 * 是 AD-16 的恢复公式，前端纯投影不自带权威状态。
 *
 * 【接线方式】ChatService 是聚合的编排持有者（单一写路径），本服务
 * 只读共享同一聚合（组合根注入访问器），自身不产生状态变更；
 * 事件流由组合根把 EventPublisherPort 的 fan-out 回灌到 notify()
 * （CLI stdout publisher 与本服务订阅者并列，互不感知）。
 */
export interface SessionServiceDeps {
  /**
   * 取当前会话快照视图（T2.2 多会话：组合根注入注册表当前会话组装面
   * SessionRegistry——聚合/工具记录/实例清单/账目整体取数）。当前会话冷
   * （被空闲卸载）时抛错——同步读面仅限热会话（CLI/既有测试路径），异步
   * 读面走 SessionDirectoryPort.getSessionView（懒加载）。
   */
  readonly getView: () => SessionStateView;
  /** 取 agent 生命周期状态（同上，共享 ChatService 的生命周期事实）。 */
  readonly getAgentState: () => AgentLifecycleState;
}

export class SessionService implements SessionPort {
  private readonly listeners = new Set<(event: SessionStreamEvent) => void>();

  constructor(private readonly deps: SessionServiceDeps) {}

  getSnapshot(): SessionStateView {
    return this.deps.getView();
  }

  subscribe(listener: (event: SessionStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 事件回灌点（组合根接线用）：EventPublisherPort fan-out 在发布事件时
   * 调用本方法，把领域事件/流式增量分发给全部订阅者。
   * 订阅者异常不阻断其他订阅者（事件流健壮性）。
   */
  notify(event: SessionStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不扩散（后续 WS 侧自带错误隔离，此处保守兜底）
      }
    }
  }

  /** 观测面：agent 生命周期当前状态（快照伴随状态）。 */
  get agentState(): AgentLifecycleState {
    return this.deps.getAgentState();
  }
}
