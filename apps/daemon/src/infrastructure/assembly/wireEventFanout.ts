import type { EventPublisherPort, StreamDelta } from "../../application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type { SessionRegistry } from "../../application/services/SessionRegistry";
import type { SessionService } from "../../application/services/SessionService";
import type { EventStream } from "../../adapters/driving/ws-server/EventStream";
import type { StdoutEventPublisher } from "../../adapters/driving/cli/CliAdapter";
import type { WriteQueue } from "../../adapters/driven/sqlite-session/WriteQueue";
import { MAIN_AGENT_KIND } from "../../adapters/driven/sqlite-session/WriteQueue";
import { TASK_SESSION_PREFIX } from "../../application/services/task/TaskOrchestratorService";

/**
 * 装配函数 ④ 事件扇出（architecture §4.2.1/§4.2.4）：组合根的一部分
 * （AG-02④ 豁免面 infrastructure/assembly/**）。
 *
 * fan-out 发布面（FanoutPublisher）由组合根先构造——服务构造期（scheduler/
 * ChatService 族）依赖稳定引用；本函数在其后装配七目标（⑤ 链 A 新增
 * task-park-bridge）。**带名注册表序
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
 * 逐目标异常隔离（code-review M32）：任一 target 抛错不得中断后续目标
 *（含事件行落盘与会话投影）——单消费者异常不得放大为全局断流。
 */
export class FanoutPublisher implements EventPublisherPort {
  private readonly named: NamedFanoutTarget[] = [];

  constructor(private readonly logger?: { warn(message: string): void }) {}

  /** 带名注册表（wireEventFanout 装配后不再变更；测试断言语义序的读面）。 */
  get targets(): readonly NamedFanoutTarget[] {
    return this.named;
  }

  /** 目标注册（仅 wireEventFanout 使用——装配期一次性）。 */
  add(target: NamedFanoutTarget): void {
    this.named.push(target);
  }

  publish(event: DomainEvent): void {
    for (const { name, target } of this.named) {
      try {
        target.publish(event);
      } catch (err) {
        this.logger?.warn(`fanout publish 目标 ${name} 异常（已隔离，后续目标照常）：${(err as Error).message}`);
      }
    }
  }

  publishDelta(delta: StreamDelta): void {
    for (const { name, target } of this.named) {
      try {
        target.publishDelta(delta);
      } catch (err) {
        this.logger?.warn(`fanout publishDelta 目标 ${name} 异常（已隔离，后续目标照常）：${(err as Error).message}`);
      }
    }
  }
}

/**
 * 任务域实例挂起/恢复可见性桥（⑤ 链 A）：task:* 会话的 agent.parked /
 * agent.resumed 领域事件 → broadcastTaskChanged(changed=batch)——驱动任务页
 * 重拉 detail（批次行状态保持 running，实例 parked 态经 DTO instanceState
 * 透出）。chat 域挂起（链 C）不触发任务推送（会话前缀判别）。
 */
export function taskParkBridgeTarget(
  eventStream: Pick<EventStream, "broadcastTaskChanged">,
): EventPublisherPort {
  return {
    publish: (event) => {
      if (event.type !== "agent.parked" && event.type !== "agent.resumed") return;
      if (!event.sessionId.startsWith(TASK_SESSION_PREFIX)) return;
      eventStream.broadcastTaskChanged({
        jobId: event.sessionId.slice(TASK_SESSION_PREFIX.length),
        changed: "batch",
      });
    },
    publishDelta: () => undefined,
  };
}

/**
 * stopped 是 per-process 停机事实（非会话持久里程碑）：daemon 每次 shutdown
 * 的 sealAll 会对每个热会话各发一条 agent.state.changed{stopped}，且
 * RestoreService「生命周期不回注（进程重启自然从 idle 起）」使下次 shutdown
 * 又 idle→stopped 再发一条——append-only domain_events 跨重启累积冗余 stopped
 * 行（R-停止事件冗余）。故 stopped 只广播、不落 domain_events 事件行；
 * running/idle/steering/aborting 是真实逐 turn 迁移，保留落盘。
 */
export function isStoppedStateChange(event: DomainEvent): boolean {
  if (event.type !== "agent.state.changed") return false;
  return (event.payload as { state?: string } | undefined)?.state === "stopped";
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
  publisher.add({ name: "task-park-bridge", target: taskParkBridgeTarget(eventStream) });
  publisher.add({
    name: "event-row-persistence",
    // 事件行持久化：行级四维落位（session_id 列 = 事件携带 sessionId——
    // WriteQueue 分仓路由位；agent_kind 按实例维判 main/subagent——kind 判别
    // 单点（T10a）：该会话主实例 id / legacy "main" / 缺省均判 main）
    target: {
      publish: (event) => {
        // stopped 是 per-process 停机事实，只广播不落 domain_events（R-停止事件冗余）
        if (isStoppedStateChange(event)) return;
        void writeQueue.appendEvent(
          event,
          registry.isMainInstance(event.sessionId, event.instanceId)
            ? MAIN_AGENT_KIND
            : "subagent",
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
