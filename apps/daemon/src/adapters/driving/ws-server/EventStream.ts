/**
 * EventStream —— EventPublisherPort 的 WS 实现（driving 侧实现 outbound 的
 * 标准形态，与 CLI 的 StdoutEventPublisher 同构；architecture.md §3.4）。
 * 组合根把本实例作为 fan-out 目标装配（WS 推送显式消费者，AD-3）。
 *
 * 领域事件 → 协议事件帧，按会话订阅路由推送（v0.2 AD-4：连接级订阅表，
 * 帧按信封 sessionId 分发——多连接可各订各的；v0.3：订阅表升级为
 * Map<sessionId, tier>，monitor 档按白名单在 push 一处过滤）；流式 delta →
 * chat.stream.delta / thinking.stream.delta。
 *
 * v0.2 统一信封（契约 A §1.2/§2）：EventStream 发出的帧全部章印
 * sessionId（事件侧来自 DomainEvent.sessionId；delta 侧来自 StreamDelta
 * .sessionId，缺省以组合根注入的 defaultSessionId 兜底）+ channel
 * （EVENT_CHANNELS 单点登记；delta 缺省通道 = chat）。
 *
 * 连接投影状态（adapter 层，非业务规则）：
 * - lastTurnId：领域 turn.completed 发布时聚合轮次已收口、事件不带 turnId，
 *   以最近 turn.started 追踪补齐协议帧的 turnId；
 * - toolStartedAt：tool.call.started → result 的 occurredAt 差值 = durationMs
 *   （协议 ToolCallEntryDto 要求，领域事件载荷未携带）；
 * - taskJobs/taskAll（task 批 §8.1）：连接级任务订阅表——task.changed 广播
 *   按订阅 jobId（或通配）过滤投递，断连清表（KgViewer 零推送口径不适用）。
 */
import type { EventPublisherPort, StreamDelta } from "../../../application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type {
  AgentConfigChangedEvent,
  ChatStreamDeltaEvent,
  EventEnvelope,
  ModelChangedEvent,
  SessionListChangedEvent,
  SessionPlanChangedEvent,
  SessionPlanChangedPayload,
  TaskChangedEvent,
  ThinkingChangedEvent,
  ThinkingStreamDeltaEvent,
  WebStatusChangedEvent,
  WebStatusPayload,
  WorkspaceChangedEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import { domainEventToEnvelope, sessionMetaDto } from "./DtoMapper";
import type { SessionListChange } from "../../../application/ports/inbound/SessionDirectoryPort";

/** 单连接的协议帧发送端（WsServerAdapter 按连接构造，内含 readyState 守卫）。 */
export type FrameSender = (frame: EventEnvelope) => void;

export interface EventStreamDeps {
  /**
   * 缺省会话（v0.2 信封 sessionId 必发纪律的兜底）：生产侧 delta 未携带
   * sessionId 时以此盖章（组合根注入当前单会话 id；多会话起生产侧
   * 全量携带后本兜底退化为防御位）。
   */
  readonly defaultSessionId?: string;
  /**
   * agent.spawned 帧 spawn 锚查值（契约 v0.3 §1 规则②）：组合根接
   * SchedulerService.spawnAnchorOf（实例 spawn 时值内存携带）；返回值含 null
   * （流首有效锚），undefined = 未登记（帧不携带锚字段——旧组装点兼容）。
   */
  readonly spawnAnchorFor?: (instanceId: string) => string | null | undefined;
  /**
   * 会话主实例 id 查询（T10a kind 判别读面）：组合根接 backfill.mainInstanceIdFor
   * （registry 闭合后生效）；返回值注入 EventMapContext——条目级归属编码与
   * engine.error 抑制的判别基准；undefined = legacy "main" 判别兜底。
   */
  readonly mainInstanceIdFor?: (sessionId: string) => string | undefined;
}

/** 单连接投影状态：会话订阅 tier 表 + v0.1 实例订阅表 + task 批连接级任务订阅表（§8.1）。 */
interface ConnProjection {
  /** 已订阅会话 → 档位（v0.3，契约 §2.1 连接级 Map 取代 v0.2 Set，Q-2b①：一会话一连接一档）。 */
  readonly sessionTiers: Map<string, SubscriptionTier>;
  /** agent.subscribe 登记的实例 id 集（契约 §8-1：v0.1 只记录不过滤）。 */
  readonly instances: Set<string>;
  /** task.subscribe 登记的 jobId 集（连接级订阅表，task 批 §8.1 机械定义）。 */
  readonly taskJobs: Set<string>;
  /** 无 jobId 订阅全部任务变更（通配档；断连清表随 detach）。 */
  taskAll: boolean;
}

/** 订阅档位（契约 v0.3 §2.1，Q-2b②）：full = 全量（缺省既有语义）；monitor = 白名单 3 事件。 */
export type SubscriptionTier = "full" | "monitor";

/**
 * monitor 档白名单（Q-2a 消息档，契约 v0.3 §2.2 机械定义，**唯一出处**）：
 * monitor 档连接只放行以下 3 个 session 订阅面事件类型；过滤判定唯一位于
 * EventStream.push（不散落 service/DtoMapper/WsServerAdapter，TR-AD-23③）。
 */
export const MONITOR_TIER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "chat.turn.started",
  "chat.turn.completed",
  "chat.message.completed",
]);

export class EventStream implements EventPublisherPort {
  private readonly connections = new Map<FrameSender, ConnProjection>();
  /** 多会话：轮次上下文按会话分仓（turn id 序号各会话独立递增）。 */
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
    const sessionTiers = new Map<string, SubscriptionTier>();
    if (sessionId !== undefined) sessionTiers.set(sessionId, "full"); // 握手默认档 = full（既有语义不变）
    this.connections.set(sender, { sessionTiers, instances: new Set(), taskJobs: new Set(), taskAll: false });
  }

  /** 连接关闭/断开后注销（tier 表随连接销毁即丢——daemon 不持跨连接状态，TR-AD-23③）。 */
  detach(sender: FrameSender): void {
    this.connections.delete(sender);
  }

  /**
   * session.subscribe（v0.2 AD-4 per-session 语义 + v0.3 档位）：连接订阅
   * 指定会话；tier 缺省 full（契约 §2.1）。重复 subscribe 换 tier = 幂等更新
   * （Map.set 覆盖语义天然幂等，不报错无副作用）。
   */
  subscribeSession(sender: FrameSender, sessionId: string, tier: SubscriptionTier = "full"): void {
    this.connections.get(sender)?.sessionTiers.set(sessionId, tier);
  }

  /** session.unsubscribe（定稿：对称 per-session 退订——见 WsServerAdapter）。 */
  unsubscribeSession(sender: FrameSender, sessionId: string): void {
    this.connections.get(sender)?.sessionTiers.delete(sessionId);
  }

  /**
   * agent.subscribe / agent.unsubscribe（契约 §4/§8-1 通路语义）：
   * 记录实例订阅表，不做事件过滤——全部事件广播携带 instanceId，前端按 id
   * 分流投影；按需过滤路由后续兑现。
   */
  subscribeInstance(sender: FrameSender, agentId: string): void {
    this.connections.get(sender)?.instances.add(agentId);
  }

  unsubscribeInstance(sender: FrameSender, agentId: string): void {
    this.connections.get(sender)?.instances.delete(agentId);
  }

  /**
   * task.subscribe / task.unsubscribe（task 批 §8.1 连接级订阅表，机械定义）：
   * subscribe 携带 jobId → 加入集合；缺省 → 通配全部任务变更。
   * unsubscribe 携带 jobId → 移除该订阅；缺省 → 清空订阅集与通配档
   *（对称语义）。断连清表（detach 随连接销毁）。sender 必须为 attach 注册
   * 的同一发送端（握手后 ws.data.sender）。
   */
  subscribeTask(sender: FrameSender, jobId?: string): void {
    const conn = this.connections.get(sender);
    if (conn === undefined) return;
    if (jobId === undefined) conn.taskAll = true;
    else conn.taskJobs.add(jobId);
  }

  unsubscribeTask(sender: FrameSender, jobId?: string): void {
    const conn = this.connections.get(sender);
    if (conn === undefined) return;
    if (jobId === undefined) {
      conn.taskAll = false;
      conn.taskJobs.clear();
    } else conn.taskJobs.delete(jobId);
  }

  /** 观测面：某连接已登记订阅的实例 id 集（测试/诊断）。 */
  subscribedInstances(sender: FrameSender): readonly string[] {
    const conn = this.connections.get(sender);
    return conn ? [...conn.instances] : [];
  }

  /** 观测面：某连接已订阅的会话 id 集（测试/诊断）。 */
  subscribedSessions(sender: FrameSender): readonly string[] {
    const conn = this.connections.get(sender);
    return conn ? [...conn.sessionTiers.keys()] : [];
  }

  /**
   * 会话清单变化广播（AD-4，契约 B §2.1）：session.list_changed 系统
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
   * model.changed 广播（AD-2，契约 C §2.1）：运行期换模生效通知——
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

  /**
   * thinking.changed 广播（thinking 批①，契约 v0.11 §17.11；broadcastModelChanged
   * 同构）：运行期 thinking 覆盖生效通知——channel=thinking，信封 sessionId =
   * 目标会话（push 按 per-session 订阅路由）；payload = override/effective 双位。
   */
  broadcastThinkingChanged(payload: { sessionId: string; override: string | null; effective: string | null }): void {
    const frame: ThinkingChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: payload.sessionId,
      channel: "thinking",
      type: "thinking.changed",
      payload: { override: payload.override, effective: payload.effective },
    };
    this.push(frame);
  }

  /**
   * agent.config.changed 广播（v0.6）：资源配置变更通知——
   * daemon 级全局配置（信封 sessionId = SYSTEM_SESSION_ID → 全连接下发，
   * 与 broadcastListChanged 同构；订阅无关）。skills/tools 同构；model 型
   * name = 模型 id 或 null（clear）；thinking 型（v0.11 补登）name = 档位
   * 字符串或 null（clear）。
   */
  broadcastAgentConfigChanged(payload: {
    profileKind: "main-session" | "subagent-worker" | "orchestrator" | "subagent-kg-writer" | "subagent-code-reviewer"; // R7 系统槽位批扩四值；D5 扩第五值（system kind 仅槽位型广播）
    resourceType: "tool" | "skill" | "model" | "thinking";
    name: string | null;
    enabled: boolean;
  }): void {
    const frame: AgentConfigChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "agent",
      type: "agent.config.changed",
      payload: { ...payload },
    };
    this.push(frame);
  }

  /**
   * web.status.changed 广播（v0.7）：CDP 连接状态变更
   * 通知——daemon 级全局（信封 sessionId = SYSTEM_SESSION_ID → 全连接下发，
   * 与 broadcastAgentConfigChanged 同构；订阅无关）。payload 与
   * web.status.result 同形状含 tabs（组合根 onStatusChange 接线经
   * handlers/web.ts webStatusPayloadOf 组装喂入）。
   */
  broadcastWebStatusChanged(payload: WebStatusPayload): void {
    const frame: WebStatusChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "web",
      type: "web.status.changed",
      payload,
    };
    this.push(frame);
  }

  /**
   * workspace_changed 广播（W1 绑定闭环）：绑定变更通知——daemon 级
   * 全局（信封 sessionId = SYSTEM_SESSION_ID → 全连接下发，与
   * broadcastWebStatusChanged 同构；订阅无关）。open 成功/同 root 幂等
   * 重开均广播一次（前端各域刷新对齐依据）。
   */
  broadcastWorkspaceChanged(payload: { root: string }): void {
    const frame: WorkspaceChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "workspace",
      type: "workspace_changed",
      payload: { root: payload.root },
    };
    this.push(frame);
  }

  /**
   * session.plan.changed 广播（main-session plan 批）：主会话工作台账变更
   * 通知——channel=session，信封 sessionId = 台账归属会话（broadcastModelChanged
   * 同构：push 按 per-session 订阅路由，只有订阅该会话的连接收到）。触发面
   * = 主会话 plan 三工具执行成功（装配层包装发布，不入 WorkLedgerService）；
   * payload 由 sessionPlanPayloadOf 单源组装（plan 行 + ledger 计数摘要）。
   */
  broadcastPlanChanged(payload: SessionPlanChangedPayload): void {
    const frame: SessionPlanChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: payload.sessionId,
      channel: "session",
      type: "session.plan.changed",
      payload,
    };
    this.push(frame);
  }

  /**
   * task.changed 广播（task 批 O-7 逐迁移轻负载）：daemon 级全局帧（信封
   * sessionId = SYSTEM_SESSION_ID、channel = notification），但投递按连接级
   * 任务订阅表过滤（订阅该 jobId 或通配才收）——不经 push 的会话订阅路由
   *（任务无会话维），与 session 级广播分道。单连接异常不扩散（push 同口径）。
   * 触发面：生命周期命令成功（handlers/task.ts）；stage/batch 级迁移归编排
   * 侧 T2.2 经本通路。
   */
  broadcastTaskChanged(payload: {
    jobId: string;
    changed: "job" | "stage" | "batch" | "work_item";
    status?: string;
    /** W2-D R13：job 终态同步提示（pending_sync 命中时随行——人读文案直渲，kg DTO summary 同规）。 */
    syncHint?: string;
  }): void {
    const frame: TaskChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "notification",
      type: "task.changed",
      payload: { ...payload },
    };
    for (const [sender, conn] of this.connections) {
      if (!conn.taskAll && !conn.taskJobs.has(payload.jobId)) continue;
      try {
        sender(frame);
      } catch {
        // 发送失败由该连接自身的 close 流程收尾，此处隔离
      }
    }
  }

  publish(event: DomainEvent): void {
    const duration = this.takeDuration(event); // 先取差值（内部一并清理起点记录）
    this.trackProjectionContext(event);
    // 契约 v0.3 §1：agent.spawned 帧锚点 enrichment——spawn 时值查调度器
    // 内存携带面（领域事件载荷不携带，不落 domain_events；E-AgentInstance 禁忌）
    const spawnAnchor =
      event.type === "agent.spawned" && event.instanceId !== undefined
        ? this.deps.spawnAnchorFor?.(event.instanceId)
        : undefined;
    const envelope = domainEventToEnvelope(event, {
      fallbackTurnId: this.lastTurnIds.get(event.sessionId) ?? "",
      ...duration,
      ...(spawnAnchor !== undefined ? { spawnAnchor } : {}),
      // T10a kind 判别基准（装配缺省/未热会话 → undefined = legacy 判别）
      mainInstanceId: this.deps.mainInstanceIdFor?.(event.sessionId),
    });
    if (envelope === null) return;
    this.push(envelope);
  }

  publishDelta(delta: StreamDelta): void {
    // v0.2 信封章印：sessionId 必发（生产侧携带或 defaultSessionId 兜底）+
    // channel 判别（缺省通道 = chat；thinking 通道同构）
    const sessionId = delta.sessionId ?? this.deps.defaultSessionId;
    // M13：sessionId 与 defaultSessionId 均缺省 → 丢弃该 delta 不发帧
    //（无 sessionId 帧在 push 面放行全部连接——广播串话事故面）
    if (sessionId === undefined) return;
    if (delta.channel === "thinking") {
      // T10a/T10d wire 归属编码一致性：thinking delta 载荷/信封 instanceId 与
      // thinking.completed 的 entry.instanceId 同一编码——主实例归一 legacy
      // “main”（wireMainAware 同规），否则 shell thinkingStreams 槽位键与
      // completed 清除键错位（hex vs "main"），think-live/cursor 永挂（R4 实锤）。
      const raw = delta.instanceId;
      const mainId = sessionId !== undefined ? this.deps.mainInstanceIdFor?.(sessionId) : undefined;
      const isMain = raw === undefined || raw === mainId || raw === "main";
      const instanceId = isMain ? "main" : raw!;
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

  /** 维护协议帧填充所需的轮次/工具上下文（先于映射执行，按会话分仓）。 */
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
   * 连接（会话无关，不受 tier 影响）；无 sessionId 帧（防御）发全部已订阅连接
   * （兼容读）。
   * v0.3 档位过滤（契约 §2.2，唯一判定单点）：session 订阅面事件按连接
   * 查 tier——full 全量；monitor 只放行 MONITOR_TIER_EVENT_TYPES 白名单 3 类型。
   * 单连接异常不扩散到其他连接（事件流健壮性）。
   */
  private push(frame: EventEnvelope): void {
    for (const [sender, conn] of this.connections) {
      if (frame.sessionId !== undefined && frame.sessionId !== SYSTEM_SESSION_ID) {
        const tier = conn.sessionTiers.get(frame.sessionId);
        if (tier === undefined) continue; // 未订阅该会话
        if (tier === "monitor" && !MONITOR_TIER_EVENT_TYPES.has(frame.type)) continue; // monitor 档白名单
      }
      try {
        sender(frame);
      } catch {
        // 发送失败由该连接自身的 close 流程收尾，此处隔离
      }
    }
  }
}
