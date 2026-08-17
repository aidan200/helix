/**
 * EventStream —— EventPublisherPort 的 WS 实现（driving 侧实现 outbound 的
 * 标准形态，与 CLI 的 StdoutEventPublisher 同构；architecture.md §3.4）。
 * 组合根把本实例作为 fan-out 目标装配（WS 推送显式消费者，AD-3 T2.1）。
 *
 * 领域事件 → 协议事件帧，按会话订阅路由推送（v0.2 AD-4：单连接订阅会话集，
 * 帧按信封 sessionId 分发——多连接可各订各的）；流式 delta →
 * chat.stream.delta / thinking.stream.delta。
 *
 * v0.2 统一信封（T2.1，契约 A §1.2/§2）：EventStream 发出的帧全部章印
 * sessionId（事件侧来自 DomainEvent.sessionId；delta 侧来自 StreamDelta
 * .sessionId，缺省以组合根注入的 defaultSessionId 兜底）+ channel
 * （EVENT_CHANNELS 单点登记；delta 缺省通道 = chat）。
 *
 * 连接投影状态（adapter 层，非业务规则）：
 * - lastTurnId：领域 turn.completed 发布时聚合轮次已收口、事件不带 turnId，
 *   以最近 turn.started 追踪补齐协议帧的 turnId；
 * - toolStartedAt：tool.call.started → result 的 occurredAt 差值 = durationMs
 *   （协议 ToolCallEntryDto 要求，领域事件载荷未携带）。
 */
import type { EventPublisherPort, StreamDelta } from "../../../application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type {
  ChatStreamDeltaEvent,
  EventEnvelope,
  ModelChangedEvent,
  SessionListChangedEvent,
  ThinkingStreamDeltaEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import { domainEventToEnvelope, sessionMetaDto } from "./DtoMapper";
import type { SessionListChange } from "../../../application/ports/inbound/SessionDirectoryPort";

/** 单连接的协议帧发送端（WsServerAdapter 按连接构造，内含 readyState 守卫）。 */
export type FrameSender = (frame: EventEnvelope) => void;

export interface EventStreamDeps {
  /**
   * 缺省会话（v0.2 信封 sessionId 必发纪律的兜底）：生产侧 delta 未携带
   * sessionId 时以此盖章（组合根注入当前单会话 id；多会话 T2.2 起生产侧
   * 全量携带后本兜底退化为防御位）。
   */
  readonly defaultSessionId?: string;
}

/** 单连接投影状态：会话订阅表 + v0.1 实例订阅表（通路语义，不过滤）。 */
interface ConnProjection {
  /** 已订阅会话 id 集（v0.2 per-session 路由，AD-4；空 = 不收任何会话帧）。 */
  readonly sessionIds: Set<string>;
  /** agent.subscribe 登记的实例 id 集（契约 §8-1：v0.1 只记录不过滤，M3 多会话再兑现路由）。 */
  readonly instances: Set<string>;
}

export class EventStream implements EventPublisherPort {
  private readonly connections = new Map<FrameSender, ConnProjection>();
  /** T2.2 多会话：轮次上下文按会话分仓（turn id 序号各会话独立递增）。 */
  private readonly lastTurnIds = new Map<string, string>();
  /** 工具耗时上下文（起止差值）；键 `${sessionId}:${toolCallId}`（跨会话 toolCallId 可重号）。 */
  private readonly toolStartedAt = new Map<string, number>();

  constructor(private readonly deps: EventStreamDeps = {}) {}

  /**
   * 连接认证通过后注册。sessionId = 连接默认订阅的会话（v0 主会话默认订阅
   * 语义保持——握手 welcome 绑定的当前单会话）；缺省不订阅任何会话
   * （显式 session.subscribe 后才开始收帧）。
   */
  attach(sender: FrameSender, sessionId?: string): void {
    const sessionIds = new Set<string>();
    if (sessionId !== undefined) sessionIds.add(sessionId);
    this.connections.set(sender, { sessionIds, instances: new Set() });
  }

  /** 连接关闭/断开后注销。 */
  detach(sender: FrameSender): void {
    this.connections.delete(sender);
  }

  /** session.subscribe（v0.2 AD-4 per-session 语义）：连接订阅指定会话。 */
  subscribeSession(sender: FrameSender, sessionId: string): void {
    this.connections.get(sender)?.sessionIds.add(sessionId);
  }

  /** session.unsubscribe（T2.1 定稿：对称 per-session 退订——见 WsServerAdapter）。 */
  unsubscribeSession(sender: FrameSender, sessionId: string): void {
    this.connections.get(sender)?.sessionIds.delete(sessionId);
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

  /** 观测面：某连接已订阅的会话 id 集（测试/诊断）。 */
  subscribedSessions(sender: FrameSender): readonly string[] {
    const conn = this.connections.get(sender);
    return conn ? [...conn.sessionIds] : [];
  }

  /**
   * 会话清单变化广播（T2.2 AD-4，契约 B §2.1）：session.list_changed 系统
   * 级帧（sessionId = SYSTEM_SESSION_ID）发全部连接——清单是 daemon 级视图，
   * 与连接订阅集无关。
   */
  broadcastListChanged(change: SessionListChange): void {
    const frame: SessionListChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "session",
      type: "session.list_changed",
      payload: {
        kind: change.kind,
        ...(change.sessionId !== undefined ? { sessionId: change.sessionId } : {}),
        ...(change.session !== undefined ? { session: sessionMetaDto(change.session) } : {}),
      },
    };
    this.push(frame);
  }

  /**
   * model.changed 广播（T2.3 AD-2，契约 C §2.1）：运行期换模生效通知——
   * channel=model，信封 sessionId = 目标会话（push 按 per-session 订阅路由：
   * 只有订阅该会话的连接收到）。
   */
  broadcastModelChanged(payload: { sessionId: string; model: string; previous: string; effective: "next-turn" }): void {
    const frame: ModelChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: payload.sessionId,
      channel: "model",
      type: "model.changed",
      payload: { ...payload },
    };
    this.push(frame);
  }

  publish(event: DomainEvent): void {
    const duration = this.takeDuration(event); // 先取差值（内部一并清理起点记录）
    this.trackProjectionContext(event);
    const envelope = domainEventToEnvelope(event, {
      fallbackTurnId: this.lastTurnIds.get(event.sessionId) ?? "",
      ...duration,
    });
    if (envelope === null) return;
    this.push(envelope);
  }

  publishDelta(delta: StreamDelta): void {
    // v0.2 信封章印：sessionId 必发（生产侧携带或 defaultSessionId 兜底）+
    // channel 判别（缺省通道 = chat；thinking 通道同构）
    const sessionId = delta.sessionId ?? this.deps.defaultSessionId;
    if (delta.channel === "thinking") {
      const instanceId = delta.instanceId ?? "main";
      const frame: ThinkingStreamDeltaEvent = {
        v: PROTOCOL_VERSION,
        ...(sessionId !== undefined ? { sessionId } : {}),
        channel: "thinking",
        type: "thinking.stream.delta",
        instanceId,
        payload: { instanceId, delta: delta.delta },
      };
      this.push(frame);
      return;
    }
    const frame: ChatStreamDeltaEvent = {
      v: PROTOCOL_VERSION,
      ...(sessionId !== undefined ? { sessionId } : {}),
      channel: "chat",
      type: "chat.stream.delta",
      // SubAgent 流式：帧携带实例维（前端路由至实例 channel；主实例缺省语义）
      ...(delta.instanceId !== undefined ? { instanceId: delta.instanceId } : {}),
      payload: { messageId: delta.messageId, delta: delta.delta },
    };
    this.push(frame);
  }

  // ── 内部 ────────────────────────────────────────────────────

  /** 维护协议帧填充所需的轮次/工具上下文（先于映射执行；T2.2 按会话分仓）。 */
  private trackProjectionContext(event: DomainEvent): void {
    switch (event.type) {
      case "turn.started":
        this.lastTurnIds.set(event.sessionId, (event.payload as { turnId: string }).turnId);
        break;
      case "tool.call.started":
        this.toolStartedAt.set(
          `${event.sessionId}:${(event.payload as { toolCallId: string }).toolCallId}`,
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
    const key = `${event.sessionId}:${id}`;
    const started = this.toolStartedAt.get(key);
    if (started === undefined) return {};
    this.toolStartedAt.delete(key);
    return { durationMs: Math.max(0, Date.parse(event.occurredAt) - started) };
  }

  /**
   * 按 sessionId 路由分发（v0.2 AD-4）：会话帧只发订阅了该会话的连接；
   * 系统级帧（SYSTEM_SESSION_ID——connection.族 / session.list_changed）发全部
   * 连接（会话无关）；无 sessionId 帧（防御）发全部已订阅连接（兼容读）。
   * 单连接异常不扩散到其他连接（事件流健壮性）。
   */
  private push(frame: EventEnvelope): void {
    for (const [sender, conn] of this.connections) {
      if (
        frame.sessionId !== undefined &&
        frame.sessionId !== SYSTEM_SESSION_ID &&
        !conn.sessionIds.has(frame.sessionId)
      ) {
        continue;
      }
      try {
        sender(frame);
      } catch {
        // 发送失败由该连接自身的 close 流程收尾，此处隔离
      }
    }
  }
}
