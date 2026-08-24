/**
 * trace 查询面共享形状（契约 v0.4 §1/§2，iter-20260819-erio T2.1；CL-5 F5.5~F5.7）。
 *
 * trace.query 命令族的结果帧数据形状 + agent.instantiated 快照形状——
 * daemon 组装面与 shell TracePage 消费面共用本包单点定义（AG-13 零平行手写）。
 * 字段结构对齐原型 P-1 mock（SESSIONS[].instances / 事件数组），传输替换为
 * 真实 WS 命令族（review.md「Mock 载体」节）。
 */

/** 时间窗过滤（ISO 8601 毫秒文本，含起含止：ts >= from && ts <= to）。 */
export interface TraceTimeRange {
  from?: string;
  to?: string;
}

/** 分页参数（id 游标，AF-3：domain_events.id AUTOINCREMENT 单调）。 */
export interface TraceQueryPageInput {
  /** 缺省 50；上限鉗制 MAX_PAGE = 200（超限鉗到 200 不报错）。 */
  limit?: number;
  /** id 游标：返回 id < beforeId 的更早页。 */
  beforeId?: number;
}

/** compaction 声明快照（daemon AgentProfile.CompactionSettings 的线形镜像）。 */
export interface TraceCompactionSnapshot {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/**
 * 执行上下文基准快照（agent.instantiated 载荷本体，AD-5）：组装结果全文
 * 而非 profileKind 引用（拼接时代回溯面——快照是「当时注入了什么」的唯一
 * 回溯本体）；SubAgent 无 compaction（随 profile 声明原样携带）。
 */
export interface TraceProfileSnapshot {
  /** 系统提示词组装结果全文。 */
  systemPrompt: string;
  tools: string[];
  /** "provider/model-id"（与 agent.spawned payload.model 同形态）。 */
  model: string;
  compaction?: TraceCompactionSnapshot;
  /** hooks 处理器名清单（装配诊断面）。 */
  hooks?: string[];
}

/** 模型时间线条目（agent.model.changed fold 产物；at = 事件 ts）。 */
export interface TraceModelChange {
  from: string;
  to: string;
  at: string;
}

/** trace 事件行（domain_events 行的线形；原型事件数组同构）。 */
export interface TraceEventRow {
  /** domain_events.id（游标锚，单调自增）。 */
  id: number;
  /** ISO 8601 毫秒文本（= 领域事件 occurredAt）。 */
  ts: string;
  sessionId: string;
  /** 实例 id（DB DEFAULT 'main'，恒有值；T10 起新行 = agent-<唯一串>，历史行字面 "main" = legacy 只读兼容）。 */
  instanceId: string;
  agentKind: "main" | "subagent";
  type: string;
  payload: unknown;
}

/** 实例面板记录（原型 SESSIONS[].instances 同构；daemon 侧 fold 产物）。 */
export interface TraceInstanceRecord {
  instanceId: string;
  agentKind: "main" | "subagent";
  /** instantiated 载荷优先；无快照实例退化 agent.spawned 载荷 / 缺省。 */
  profileKind: string;
  /** 基准模型（快照 model 优先，其次 spawn 透传值；不可得则缺省不携带）。 */
  model?: string;
  /** 生命周期：终态事件决定 completed/failed/killed；无终态 = running。 */
  status: "running" | "completed" | "failed" | "killed";
  /** instantiated / spawned / 首事件 ts（依次退化）。 */
  startedAt?: string;
  /** 终态事件 ts（running 缺省不携带）。 */
  endedAt?: string;
  /** SubAgent 任务（agent.spawned payload.task；主实例缺省）。 */
  task?: string;
  /** 该实例全会话事件计数（COUNT GROUP BY，不受 events 过滤维影响）。 */
  eventCount: number;
  /** 执行上下文基准快照（agent.instantiated 载荷本体）。 */
  snapshot?: TraceProfileSnapshot;
  /** 无 instantiated 事件 = true（降级语义：历史实例页面标注「快照缺失」）。 */
  snapshotMissing: boolean;
  /** 模型时间线（按 ts 升序；无变更缺省不携带）。 */
  modelTimeline?: TraceModelChange[];
  /** 当前生效模型（时间线末条 to；无时间线 = snapshot.model ?? spawn 透传值；不可得缺省）。 */
  currentModel?: string;
}

/**
 * 生效过滤回显（filterEcho，AF-5：并发一致性 = 前端单飞 + 丢弃 filter 不
 * 匹配的迟到结果，不加 requestId）：缺省维归一为 null（区别于「未传」）。
 */
export interface TraceQueryFilterEcho {
  sessionId: string;
  /** null = 全部实例（缺省）；空数组 = 空结果（显式语义）。 */
  instanceIds: string[] | null;
  agentKind: "main" | "subagent" | null;
  /** null = 全部类型（缺省）；空数组 = 空结果。 */
  types: string[] | null;
  timeRange: { from: string | null; to: string | null } | null;
  page: { limit: number; beforeId: number | null };
}
