import type { EventFrame } from "../envelope";
import type { ClosureDto, ProfileKind, ReadableProfileKind, SystemProfileKind } from "../types/agent";
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

/** agent.started：出队/预算内直跑（卡片 running 态）；startedAtMs = 真实执行时长锚点（epoch ms） */
export interface AgentStartedPayload {
  agentId: string;
  startedAtMs: number;
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

// ── park/resume 批新增 payload（设计稿 park-resume §5；additive 广播帧） ──

/** 挂起原因枚举：user=用户/主 agent 主动挂起；taskPause=任务暂停链（后续波次接线）。 */
export type ParkReasonDto = "user" | "taskPause";

/** agent.parked：实例挂起（非终态——不写 closure、不触发收口链；PARK 标记确认上行时广播） */
export interface AgentParkedPayload {
  agentId: string;
  reason: ParkReasonDto;
  /** 挂起时刻（ISO 8601）。 */
  parkedAt: string;
  /** PARK 标记摘要（progress/next；子进程上报，缺席不携带）。 */
  summary?: { progress: string; next: string };
}

/** agent.resumed：挂起实例恢复（预算内直恢复时广播；排队恢复空位后广播）。startedAtMs = 新段起点；elapsedMs = park 结算后的累计基线（挂起期不计）。 */
export interface AgentResumedPayload {
  agentId: string;
  startedAtMs: number;
  elapsedMs: number;
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
   * AD-4④）：自身 profile 槽位（无兜底——未配置 = 默认关，iter-20260823
   * 后续批补登改可选），spawn 时刻确定、trace 可复盘（AD-1 语义红线，
   * 与模型快照同构）。字符串透传（AD-2）。
   */
  thinkingLevel?: string;
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
  /** 配置单元 kind（T2.2 additive 扩第三值：任务编排主 agent——读面透传；
   *  写面（set_enabled）仍两值——编排工具配置 UI 归后续迭代）。 */
  profileKind: ReadableProfileKind;
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
   * helix 不维护第二份档位枚举）。留空 = 未配置 → SubAgent 默认关
   *（无兜底，AD-1）。
   */
  thinkingLevel: string | null;
}

/** agent.config.list.result：配置读面回执（点对点；全局命令）。 */
export interface AgentConfigListResultPayload {
  /** 携带 profileKind 请求 = 单块；缺省 = 两块（main-session 在前，序固定）。 */
  profiles: readonly AgentConfigProfileBlock[];
  /**
   * 只读系统派生块（agent-roster 批 additive：可见不可编辑）：缺省全量请求
   * 时携带（orchestrator 在前序固定）；单 kind 过滤请求不携带。旧客户端
   * 可选字段不感知（零破坏）。
   */
  system?: readonly AgentConfigSystemBlock[];
}

/** 只读系统派生块工具行（纯展示：name + 一句话 snippet；无启停位——
 *  清单即生效集/声明全集）。 */
export interface AgentConfigSystemToolRow {
  name: string;
  /** 工具一句话说明（daemon ToolPromptSnippets 注册表同源；注册表外名 = 空串）。 */
  snippet: string;
}

/**
 * agent.config.list.result 只读系统派生块：orchestrator / subagent-kg-writer
 * 元信息（agent-roster 批 additive）。可见不可编辑——写面对只读 kind 恒拒
 * （connection.error code=agent.config.read_only，连接保持）。工具清单从
 * 真实 profile 派生：orchestrator = 声明全集（toolsCatalog 同源）；
 * kg-writer = subagent-worker 当前生效集 + pinnedTools（kg-update 恒在，
 * 随 worker toggle 动态跟随——派生面无自有状态）。
 */
export interface AgentConfigSystemBlock {
  /** 系统派生 kind（不在写面枚举：orchestrator 系统形态；kg-writer 装配端派生）。 */
  profileKind: SystemProfileKind;
  /** 工具清单（纯展示；orchestrator = 声明全集，kg-writer = worker 生效集 + pinned）。 */
  tools: ReadonlyArray<AgentConfigSystemToolRow>;
  /** 派生说明位：kg-writer = 派生自 subagent-worker（工具集跟随 worker）；orchestrator 不携带。 */
  derivedFrom?: "subagent-worker";
  /** 派生面恒在工具（kg-writer = ["kg-update"]；orchestrator 不携带）。 */
  pinnedTools?: readonly string[];
  /**
   * 模型槽位现值（R7 系统槽位批 additive）：未配置 = null（跟随全局默认模型，
   * 两级链与可编辑 kind 同构——不联动 worker 槽位）。仅槽位型可写
   * （set_enabled resourceType=model）；tool/skill 启停写面对 system kind 恒拒。
   */
  model?: string | null;
  /**
   * thinking 槽位现值（R7 additive）：未配置 = null（跟随全局默认推理强度，
   * 未配全局 → 默认关）。同 model 仅槽位型可写。
   */
  thinkingLevel?: string | null;
}

/**
 * agent.config.changed：资源配置变更广播（daemon 级全局配置——信封
 * sessionId = SYSTEM_SESSION_ID，订阅无关全连接下发；skills/tools 同构，
 * model 型 name = 模型 id 或 null（clear））。
 */
export interface AgentConfigChangedPayload {
  /** 配置单元 kind（写面五值 ProfileKind：system kind 仅 model/thinking 槽位变更广播）。 */
  profileKind: ProfileKind;
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

/**
 * agent.base_prompt.get.result：base 段系统提示词读面回执（点对点；全局
 * 命令）。basePrompt = profile 静态声明 prompt 全文（三段组装第①段；
 * 工具/技能两段为运行期动态拼入不在本面——观察生效全量提示词走 trace
 * 快照面）。
 */
export interface AgentBasePromptGetResultPayload {
  profileKind: ProfileKind;
  basePrompt: string;
}

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

// ── park/resume 批新增信封（挂 agent 族广播帧） ──

/** agent.parked：实例挂起（非终态；卡片 parked 形态归后续波次，本批登记数据面） */
export interface AgentParkedEvent extends EventFrame<AgentParkedPayload> {
  channel?: "agent";
  type: "agent.parked";
}
/** agent.resumed：挂起实例恢复（同一实例同一会话从断点继续） */
export interface AgentResumedEvent extends EventFrame<AgentResumedPayload> {
  channel?: "agent";
  type: "agent.resumed";
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

/** agent.base_prompt.get.result：base 段系统提示词读面回执（点对点；信封 sessionId = SYSTEM_SESSION_ID）。 */
export interface AgentBasePromptGetResultEvent extends EventFrame<AgentBasePromptGetResultPayload> {
  channel?: "agent";
  type: "agent.base_prompt.get.result";
}
