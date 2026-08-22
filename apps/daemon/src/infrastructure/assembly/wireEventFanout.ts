import type { EventPublisherPort, StreamDelta } from "../../application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type { SessionRegistry } from "../../application/services/SessionRegistry";
import type { SessionService } from "../../application/services/SessionService";
import type { EventStream } from "../../adapters/driving/ws-server/EventStream";
import type { StdoutEventPublisher } from "../../adapters/driving/cli/CliAdapter";
import type { WriteQueue } from "../../adapters/driven/sqlite-session/WriteQueue";
import { MAIN_AGENT_KIND } from "../../adapters/driven/sqlite-session/WriteQueue";
import { MAIN_INSTANCE_ID } from "@helix/protocol";

/**
 * 装配函数 ④ 事件扇出（architecture §4.2.1/§4.2.4）：组合根的一部分
 * （AG-02④ 豁免面 infrastructure/assembly/**）。
 *
 * fan-out 发布面（FanoutPublisher）由组合根先构造——服务构造期（scheduler/
 * ChatService 族）依赖稳定引用；本函数在其后装配六目标。**带名注册表序
 * 即语义唯一权威**（断言面）——重排一行即断言红。
 */
export interface NamedFanoutTarget {
  /** 目标名（语义可读可断言；注册表序 = 派发序 = 语义序）。 */
  readonly name: string;
  readonly target: EventPublisherPort;
}

/**
 * fan-out 发布面：先构造（空注册表）后装配目标的稳定引用。
 * 派发为同步顺序 for 循环（无 await）——注册表数组序即执行序。
 */
export class FanoutPublisher implements EventPublisherPort {
  private readonly named: NamedFanoutTarget[] = [];

  /** 带名注册表（wireEventFanout 装配后不再变更；测试断言语义序的读面）。 */
  get targets(): readonly NamedFanoutTarget[] {
    return this.named;
  }

  /** 目标注册（仅 wireEventFanout 使用——装配期一次性）。 */
  add(target: NamedFanoutTarget): void {
    this.named.push(target);
  }

  publish(event: DomainEvent): void {
    for (const { target } of this.named) target.publish(event);
  }

  publishDelta(delta: StreamDelta): void {
    for (const { target } of this.named) target.publishDelta(delta);
  }
}

export interface WireEventFanoutDeps {
  readonly registry: SessionRegistry;
  readonly sessionService: SessionService;
  readonly eventStream: EventStream;
  readonly writeQueue: WriteQueue;
  readonly stdoutPublisher: StdoutEventPublisher;
}

/**
 * fan-out 六目标装配（序：CLI stdout → CLI 事件回灌（当前会话过滤）→ WS 事件流
 * → 写队列持久化（事件行，行级 session_id 分仓路由）→ 会话投影路由（**先事件行
 * 后状态行**，同会话仓内 FIFO 保序）→ 清单运行态桥（活动标记 + state_changed）。
 * SubAgent 实例事件（instanceId ≠ main）落行 agent_kind=subagent（四维可查口径）。
 */
export function wireEventFanout(publisher: FanoutPublisher, deps: WireEventFanoutDeps): void {
  const { registry, sessionService, eventStream, writeQueue, stdoutPublisher } = deps;
  publisher.add({ name: "cli-stdout", target: stdoutPublisher });
  publisher.add({
    name: "cli-current-session-feedback",
    // CLI 单会话 UX：只回灌当前会话事件（多会话事件经 WS 按订阅分发）
    target: {
      publish: (event) => {
        if (event.sessionId === registry.currentSessionId()) sessionService.notify(event);
      },
      publishDelta: (delta) => {
        if ((delta.sessionId ?? registry.currentSessionId()) === registry.currentSessionId()) {
          sessionService.notify(delta);
        }
      },
    },
  });
  publisher.add({ name: "ws-event-stream", target: eventStream });
  publisher.add({
    name: "event-row-persistence",
    // 事件行持久化：行级四维落位（session_id 列 = 事件携带 sessionId——
    // WriteQueue 分仓路由位；agent_kind 按实例维判 main/subagent）
    target: {
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
  });
  publisher.add({
    name: "session-projection",
    // 会话投影路由（AD-3 + 多会话）：事件 → 归属会话运行时的投影
    // 消费者（SubAgent Entry 落聚合 + 账本入账 + write-through；卸载会话无
    // 投影——零动作）
    target: {
      publish: (event) => registry.projectEvent(event),
      publishDelta: () => undefined,
    },
  });
  publisher.add({
    name: "directory-runstate-bridge",
    // 清单运行态桥：活动标记（卸载计时/当前会话轮换）+ runState 变化
    // 推 session.list_changed{state_changed}（注册表内去重）
    target: {
      publish: (event) => registry.onDomainEvent(event),
      publishDelta: (delta) => registry.touchActivity(delta.sessionId),
    },
  });
}
