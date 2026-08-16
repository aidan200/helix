/**
 * EventStream —— EventPublisherPort 的 WS 实现（driving 侧实现 outbound 的
 * 标准形态，与 CLI 的 StdoutEventPublisher 同构；architecture.md §3.4）。
 *
 * 领域事件 → 协议事件帧，推送到全部已连接（且订阅中）的 WS 发送端；
 * 流式 delta → chat.stream.delta。组合根把本实例作为 fan-out 目标装配
 * （与 stdout publisher、SessionService 订阅回灌并列）。
 *
 * 连接投影状态（adapter 层，非业务规则）：
 * - lastTurnId：领域 turn.completed 发布时聚合轮次已收口、事件不带 turnId，
 *   以最近 turn.started 追踪补齐协议帧的 turnId；
 * - toolStartedAt：tool.call.started → result 的 occurredAt 差值 = durationMs
 *   （协议 ToolCallEntryDto 要求，领域事件载荷未携带）。
 */
import type { EventPublisherPort, StreamDelta } from "../../../application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { ChatStreamDeltaEvent, EventEnvelope, ThinkingStreamDeltaEvent } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { domainEventToEnvelope } from "./DtoMapper";

/** 单连接的协议帧发送端（WsServerAdapter 按连接构造，内含 readyState 守卫）。 */
export type FrameSender = (frame: EventEnvelope) => void;

/** 单连接投影状态：会话订阅开关 + v0.1 实例订阅表（通路语义，不过滤）。 */
interface ConnProjection {
  subscribed: boolean;
  /** agent.subscribe 登记的实例 id 集（契约 §8-1：v0.1 只记录不过滤，M3 多会话再兑现路由）。 */
  readonly instances: Set<string>;
}

export class EventStream implements EventPublisherPort {
  private readonly connections = new Map<FrameSender, ConnProjection>();
  private lastTurnId = "";
  private readonly toolStartedAt = new Map<string, number>();

  /** 连接认证通过后注册（默认订阅中——v0 主会话默认订阅）。 */
  attach(sender: FrameSender): void {
    this.connections.set(sender, { subscribed: true, instances: new Set() });
  }

  /** 连接关闭/断开后注销。 */
  detach(sender: FrameSender): void {
    this.connections.delete(sender);
  }

  /** session.subscribe / session.unsubscribe 的通路开关（v0 保通路语义）。 */
  setSubscribed(sender: FrameSender, subscribed: boolean): void {
    const conn = this.connections.get(sender);
    if (conn) conn.subscribed = subscribed;
  }

  /**
   * agent.subscribe / agent.unsubscribe（T2.3，契约 §4/§8-1 通路语义）：
   * 记录实例订阅表，不做事件过滤——全部事件广播携带 instanceId，前端按 id
   * 分流投影；按需过滤路由留 M3 多会话时兑现。
   */
  subscribeInstance(sender: FrameSender, agentId: string): void {
    this.connections.get(sender)?.instances.add(agentId);
  }

  unsubscribeInstance(sender: FrameSender, agentId: string): void {
    this.connections.get(sender)?.instances.delete(agentId);
  }

  /** 观测面：某连接已登记订阅的实例 id 集（测试/诊断）。 */
  subscribedInstances(sender: FrameSender): readonly string[] {
    const conn = this.connections.get(sender);
    return conn ? [...conn.instances] : [];
  }

  publish(event: DomainEvent): void {
    const duration = this.takeDuration(event); // 先取差值（内部一并满理起点记录）
    this.trackProjectionContext(event);
    const envelope = domainEventToEnvelope(event, { fallbackTurnId: this.lastTurnId, ...duration });
    if (envelope === null) return;
    this.push(envelope);
  }

  publishDelta(delta: StreamDelta): void {
    // T3.1：thinking 通道增量 → thinking.stream.delta（instanceId 挂帧与载荷；
    // 同样不落盘，TR-AD-5）；缺省通道保持 chat.stream.delta 原形状
    if (delta.channel === "thinking") {
      const instanceId = delta.instanceId ?? "main";
      const frame: ThinkingStreamDeltaEvent = {
        v: PROTOCOL_VERSION,
        type: "thinking.stream.delta",
        instanceId,
        payload: { instanceId, delta: delta.delta },
      };
      this.push(frame);
      return;
    }
    const frame: ChatStreamDeltaEvent = {
      v: PROTOCOL_VERSION,
      type: "chat.stream.delta",
      payload: { messageId: delta.messageId, delta: delta.delta },
    };
    this.push(frame);
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 维护协议帧填充所需的轮次/工具上下文（先于映射执行）。 */
  private trackProjectionContext(event: DomainEvent): void {
    switch (event.type) {
      case "turn.started":
        this.lastTurnId = (event.payload as { turnId: string }).turnId;
        break;
      case "tool.call.started":
        this.toolStartedAt.set(
          (event.payload as { toolCallId: string }).toolCallId,
          Date.parse(event.occurredAt),
        );
        break;
      default:
        break;
    }
  }

  /** 取出 tool.call.result 的 durationMs（读后即删，防泄漏；非 result 事件无值）。 */
  private takeDuration(event: DomainEvent): { durationMs?: number } {
    if (event.type !== "tool.call.result") return {};
    const id = (event.payload as { toolCallId: string }).toolCallId;
    const started = this.toolStartedAt.get(id);
    if (started === undefined) return {};
    this.toolStartedAt.delete(id);
    return { durationMs: Math.max(0, Date.parse(event.occurredAt) - started) };
  }

  /** 单连接异常不扩散到其他连接（事件流健壮性；v0.1 通路语义：不按 instance 过滤）。 */
  private push(frame: EventEnvelope): void {
    for (const [sender, conn] of this.connections) {
      if (!conn.subscribed) continue;
      try {
        sender(frame);
      } catch {
        // 发送失败由该连接自身的 close 流程收尾，此处隔离
      }
    }
  }
}
