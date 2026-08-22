import type { EventPublisherPort } from "../../application/ports/outbound/EventPublisherPort";
import type { SessionRegistry } from "../../application/services/SessionRegistry";
import type { SessionService } from "../../application/services/SessionService";
import type { EventStream } from "../../adapters/driving/ws-server/EventStream";
import type { StdoutEventPublisher } from "../../adapters/driving/cli/CliAdapter";
import type { WriteQueue } from "../../adapters/driven/sqlite-session/WriteQueue";
import { MAIN_INSTANCE_ID } from "@helix/protocol";
import { MAIN_AGENT_KIND } from "../../adapters/driven/sqlite-session/WriteQueue";

/**
 * 装配函数 ④ 事件扇出（T2.2，architecture §4.2.1/§4.2.4）：组合根的一部分
 * （AG-02④ 豁免面 infrastructure/assembly/**）。fan-out 发布面由组合根先建
 * （空目标——服务构造期依赖稳定引用），本函数在其后装配六目标。
 */
export interface WireEventFanoutDeps {
  /** fan-out 目标容器（组合根先建的空数组）。 */
  readonly publisherTargets: EventPublisherPort[];
  readonly registry: SessionRegistry;
  readonly sessionService: SessionService;
  readonly eventStream: EventStream;
  readonly writeQueue: WriteQueue;
  readonly stdoutPublisher: StdoutEventPublisher;
}

export function wireEventFanout(deps: WireEventFanoutDeps): void {
  const { registry, sessionService, eventStream, writeQueue, stdoutPublisher } = deps;
  // fan-out 目标装配（序：CLI stdout → CLI 事件回灌（当前会话过滤）→ WS 事件流
  // → 写队列持久化（事件行，行级 session_id 分仓路由）→ 会话投影路由（先事件行
  // 后状态行，同会话仓内 FIFO 保序）→ 清单运行态桥（活动标记 + state_changed）。
  // SubAgent 实例事件（instanceId ≠ main）落行 agent_kind=subagent（四维可查口径）。
  deps.publisherTargets.push(
    stdoutPublisher,
    {
      // CLI 单会话 UX：只回灌当前会话事件（多会话事件经 WS 按订阅分发）
      publish: (event) => {
        if (event.sessionId === registry.currentSessionId()) sessionService.notify(event);
      },
      publishDelta: (delta) => {
        if ((delta.sessionId ?? registry.currentSessionId()) === registry.currentSessionId()) {
          sessionService.notify(delta);
        }
      },
    },
    eventStream,
    {
      // 事件行持久化：行级四维落位（session_id 列 = 事件携带 sessionId——
      // WriteQueue 分仓路由位；agent_kind 按实例维判 main/subagent）
      publish: (event) => {
        void writeQueue.appendEvent(
          event,
          event.instanceId !== undefined && event.instanceId !== MAIN_INSTANCE_ID
            ? "subagent"
            : MAIN_AGENT_KIND,
        );
      },
      publishDelta: () => undefined,
    },
    // 会话投影路由（T2.1 AD-3 + T2.2 多会话）：事件 → 归属会话运行时的投影
    // 消费者（SubAgent Entry 落聚合 + 账本入账 + write-through；卸载会话无
    // 投影——零动作）
    {
      publish: (event) => registry.projectEvent(event),
      publishDelta: () => undefined,
    },
    // 清单运行态桥（T2.2）：活动标记（卸载计时/当前会话轮换）+ runState 变化
    // 推 session.list_changed{state_changed}（注册表内去重）
    {
      publish: (event) => registry.onDomainEvent(event),
      publishDelta: (delta) => registry.touchActivity(delta.sessionId),
    },
  );
}
