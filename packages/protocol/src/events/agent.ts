import type { EventFrame } from "../envelope";
import type { ClosureDto } from "../types/agent";
import type { TraceProfileSnapshot } from "../types/trace";

// ── v0.1 新增 payload：编排生命周期族（契约 protocol-v0.1.md §5.1；AD-7） ──

/** agent.spawned：spawn 工具秒回出卡（不等执行，AD-8 异步交付） */
export interface AgentSpawnedPayload {
  agentId: string;
  task: string;
  profileKind: string;
  /** "provider/model-id"；未声明时缺省继承当前模型（AD-6） */
  model?: string;
  /**
   * spawn 锚（v0.3 新增，契约 v0.3 §1）：spawn 时刻聚合内最后一条 main/
   * compaction entry 的 id（无 → null = 流首）。与快照 instances 清单同源
   * 同值；缺省不携带 = 主实例。
   */
  anchorEntryId?: string | null;
}

/** agent.queued：超限 FIFO 入队（AD-7②）；position 随出队递减重发 */
export interface AgentQueuedPayload {
  agentId: string;
  position: number;
}

/** agent.started：出队/预算内直跑（卡片 running 态） */
export interface AgentStartedPayload {
  agentId: string;
}

/** agent.stalled：idle 超阈值无事件增量（AD-7④ 警示不自动杀；可再次发生，非状态迁移） */
export interface AgentStalledPayload {
  agentId: string;
  idleMs: number;
}

/** agent.completed：自然收口 done（closure 同源卡片/抽屉，AD-8） */
export interface AgentCompletedPayload {
  agentId: string;
  closure: ClosureDto;
}

/** agent.failed：崩溃/异常收口 failed（closure.status="failed"） */
export interface AgentFailedPayload {
  agentId: string;
  error: string;
  closure: ClosureDto;
}

/** agent.killed：用户 kill 收口（closure.status="failed"，lifecycle terminated） */
export interface AgentKilledPayload {
  agentId: string;
  closure: ClosureDto;
}

// ── v0.4 新增 payload：trace 命令族 + agent 执行上下文面（契约 v0.4 §1/§2/§3；iter-20260819-erio T2.1） ──

/**
 * agent.instantiated：实例化时刻 profile 快照落盘（AD-5；执行上下文卡数据源）。
 * **只落盘不广播**（AF-6：DtoMapper 无 case → default → null；协议登记供
 * trace.query 结果 payload 类型化与守护一致性）。
 */
export interface AgentInstantiatedPayload {
  instanceId: string;
  profileKind: string;
  /**
   * SubAgent spawn 解析的 thinkingLevel 快照（v0.11 新增，thinking 批④，
   * AD-4④）：自身 profile 槽位 > 兜底 medium（AD-6），spawn 时刻确定、
   * trace 可复盘（AD-1 语义红线，与模型快照同构）。字符串透传（AD-2）。
   */
  thinkingLevel: string;
  profileSnapshot: TraceProfileSnapshot;
}

/**
 * agent.model.changed：运行期换模的模型时间线落盘（AD-6；from/to 与
 * model.changed 广播帧 previous/model 同源同值）。**只落盘不广播**（同 AF-6）。
 */
export interface AgentModelChangedPayload {
  instanceId: string;
  /** 旧模型标识（"provider/model-id"）。 */
  from: string;
  /** 新模型标识。 */
  to: string;
}

// ── v0.6 新增 payload：agent.config 族（M6 T3 智能体配置页；契约 v0.6 §2） ──

/**
 * agent.config.list.result 块：单 kind 三类资源配置现值。
 * tools/skills 含全集 + 启停态（缺省无记录 = 启用）；diagnostics = 扫描诊断
 * （坏文件上抛不炸）；model 槽位未设 = null（JSON 序列化面钉死 null 非
 * undefined——字段不丢）。tools 行 snippet = 一句话说明（daemon
 * ToolPromptSnippets 注册表同源，M6 T4 批内补登；注册表外名 = 空串）。
 */
export interface AgentConfigProfileBlock {
  profileKind: "main-session" | "subagent-worker";
  tools: ReadonlyArray<{ name: string; enabled: boolean; snippet: string }>;
  skills: ReadonlyArray<{
    name: string;
    description: string;
    filePath: string;
    /** 来源层：user（~/.helix/skills）/ project（工作区 .helix/skills）/ builtin（daemon 随仓 resources/skills，v0.8）。 */
    source: "user" | "project" | "builtin";
    enabled: boolean;
  }>;
  /** 扫描诊断（code/message/path/source；SkillScanner 域形状同构）。 */
  diagnostics: ReadonlyArray<{ code: string; message: string; path: string; source: "user" | "project" | "builtin" }>;
  /** model 槽位现值（未设 = null）。 */
  model: string | null;
  /**
   * thinking 槽位现值（v0.11 批内补登，thinking 批 AD-6 配置资源扩维，
   * iter-20260823-6ps5 T1.3）：未配置 = null（同 model 槽位 JSON 面钉死
   * null 非 undefined）；已配置 = pi-ai ThinkingLevel 字符串透传（AD-2，
   * helix 不维护第二份档位枚举）。留空 = 未配置 → SubAgent 解析链回落
   * 兜底 medium（AD-1）。
   */
  thinkingLevel: string | null;
}

/** agent.config.list.result：配置读面回执（点对点；全局命令）。 */
export interface AgentConfigListResultPayload {
  /** 携带 profileKind 请求 = 单块；缺省 = 两块（main-session 在前，序固定）。 */
  profiles: readonly AgentConfigProfileBlock[];
}

/**
 * agent.config.changed：资源配置变更广播（daemon 级全局配置——信封
 * sessionId = SYSTEM_SESSION_ID，订阅无关全连接下发；skills/tools 同构，
 * model 型 name = 模型 id 或 null（clear））。
 */
export interface AgentConfigChangedPayload {
  profileKind: "main-session" | "subagent-worker";
  /** thinking = v0.11 批内补登（thinking 槽位，AD-6；与 model 同为槽位语义非启停）。 */
  resourceType: "tool" | "skill" | "model" | "thinking";
  /** tools/skills = 资源名；model = 模型 id 或 null（clear）；thinking = 档位字符串或 null（clear）。 */
  name: string | null;
  /** tool/skill = 新启停态；model/thinking = true（槽位已设）/ false（槽位已清）。 */
  enabled: boolean;
}

/**
 * agent.config.set_enabled.result：启停写面回执（点对点；全局命令）。
 * skipped 的 reason 区分回执形态：unknown-name（tool/skill 名不在全集，
 * 不落库）/ unknown-model（model 型不在合并目录，ModelService.setModel
 * 先例）等。
 */
export type AgentConfigSetEnabledResultPayload =
  | { status: "applied" }
  | { status: "skipped"; reason: string };

// ── v0.1 新增信封（契约 protocol-v0.1.md §5） ──

export interface AgentSpawnedEvent extends EventFrame<AgentSpawnedPayload> {
  channel?: "agent";
  type: "agent.spawned";
}
export interface AgentQueuedEvent extends EventFrame<AgentQueuedPayload> {
  channel?: "agent";
  type: "agent.queued";
}
export interface AgentStartedEvent extends EventFrame<AgentStartedPayload> {
  channel?: "agent";
  type: "agent.started";
}
export interface AgentStalledEvent extends EventFrame<AgentStalledPayload> {
  channel?: "agent";
  type: "agent.stalled";
}
export interface AgentCompletedEvent extends EventFrame<AgentCompletedPayload> {
  channel?: "agent";
  type: "agent.completed";
}
export interface AgentFailedEvent extends EventFrame<AgentFailedPayload> {
  channel?: "agent";
  type: "agent.failed";
}
export interface AgentKilledEvent extends EventFrame<AgentKilledPayload> {
  channel?: "agent";
  type: "agent.killed";
}

// ── v0.4 新增信封（契约 v0.4；iter-20260819-erio T2.1） ──

/** agent.instantiated：实例化快照（只落盘不广播；登记供类型化/守护，AF-6） */
export interface AgentInstantiatedEvent extends EventFrame<AgentInstantiatedPayload> {
  channel?: "agent";
  type: "agent.instantiated";
}
/** agent.model.changed：模型时间线落盘事件（只落盘不广播；同上） */
export interface AgentModelChangedEvent extends EventFrame<AgentModelChangedPayload> {
  channel?: "agent";
  type: "agent.model.changed";
}

// ── v0.6 新增信封（M6 T3；agent.config 族——channel 挂 agent 族）──

/** agent.config.list.result：配置读面回执（点对点；信封 sessionId = SYSTEM_SESSION_ID）。 */
export interface AgentConfigListResultEvent extends EventFrame<AgentConfigListResultPayload> {
  channel?: "agent";
  type: "agent.config.list.result";
}
/** agent.config.changed：配置变更广播（daemon 级全局；信封 sessionId = SYSTEM_SESSION_ID）。 */
export interface AgentConfigChangedEvent extends EventFrame<AgentConfigChangedPayload> {
  channel?: "agent";
  type: "agent.config.changed";
}
/** agent.config.set_enabled.result：启停写面回执（点对点；全局命令）。 */
export interface AgentConfigSetEnabledResultEvent extends EventFrame<AgentConfigSetEnabledResultPayload> {
  channel?: "agent";
  type: "agent.config.set_enabled.result";
}
