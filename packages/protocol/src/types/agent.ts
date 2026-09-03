import type { EntryDto } from "./session";
import type { UsageDto } from "./usage";

/**
 * Profile kind 单点定义（code-review M54 收敛：原五值字面量联合在
 * commands.ts/events/agent.ts 四处内联重复，新增 kind 需同步 5+ 处）。
 * - ProfileKind：写面五值（set_enabled/base_prompt.get 等写面命令枚举）；
 * - ReadableProfileKind：agent.config.list 用户面 profile 块读面三值；
 * - SystemProfileKind：系统派生块读面三值（orchestrator/kg-writer/reviewer）。
 */
export type ProfileKind =
  | "main-session"
  | "subagent-worker"
  | "orchestrator"
  | "subagent-kg-writer"
  | "subagent-code-reviewer";

/** 读面用户 profile 块 kind 三值（ProfileKind 的读面子集）。 */
export type ReadableProfileKind = "main-session" | "subagent-worker" | "orchestrator";

/** 系统派生块 kind 三值（不在写面枚举语义：orchestrator 系统形态 + 两派生 kind）。 */
export type SystemProfileKind = "orchestrator" | "subagent-kg-writer" | "subagent-code-reviewer";

/**
 * Agent 生命周期状态（契约 §6；AD-17.5：前端显示贫血 DTO）。
 *
 * 由 agent.state.changed 事件、connection.welcome、SessionSnapshotDto 携带。
 * 状态机转换规则属 T1.6/T1.7 契约（重连状态机见集成契约 §8）。
 */
export type AgentStateDto = "idle" | "running" | "steering" | "aborting" | "stopped";

// ── v0.1 新增（契约 protocol-v0.1.md §5.3/§6.2；iter-20260816-uzvg T1.1） ──

/**
 * 实例收口记录（AD-8：closure 双通道；结构承接 v1）。
 *
 * 三个终态事件（agent.completed/failed/killed）与终态实例（快照
 * instances[].closure）同源同构——前端卡片/抽屉 closure 卡共用。
 * **全字段必发纪律**（test-design §4.3）：可选字段缺失时显式发 `null`，
 * 不允许字段缺席（类型层为 `?: ... | null`，线格式由 daemon 保证必发）。
 */
export interface ClosureDto {
  status: "done" | "failed";
  summary: string;
  /** 任务报告落盘路径；缺失字段显式 null */
  reportPath?: string | null;
  /** v2 kg 自动落账重生长时接；本迭代透传 */
  findings?: unknown[] | null;
  taskId?: string | null;
}

/**
 * 实例状态（编排四态 + cancelled + parked）。
 * cancelled 仅重启恢复时 queued 收口使用（AD-10），运行期不产生；
 * parked（park/resume 批）= 活着但不干活（非终态：进程驻留、上下文原封、
 * 零 token；resume 复活同一实例）。
 */
export type InstanceState = "queued" | "running" | "parked" | "done" | "failed" | "cancelled";

/**
 * 实例清单条目（SessionSnapshotDto.instances 载体；重启恢复卡片/抽屉骨架）。
 * 主实例与 SubAgent 同构（AD-3 AgentInstance 一等概念），区别仅 kind/profileKind。
 */
export interface AgentInstanceDto {
  /** 实例标识（AD-3；T10 统一）：全实例 = agent-<唯一串>（main/subagent 由 kind 承载；历史字面 "main" = legacy 只读兼容） */
  instanceId: string;
  kind: "main" | "subagent";
  /** profile 标识（如 "main-session" / "subagent-worker"） */
  profileKind: string;
  state: InstanceState;
  task?: string;
  /** "provider/model-id"（AD-6 缺省继承当前模型） */
  model?: string;
  /** 仅 state=queued 携带（队列位次，随出队递减） */
  queuedPosition?: number;
  createdAt: string;
  /** 累计执行毫秒（park/终态结算基线；不含当前 running 段——防 restore 双计；additive） */
  elapsedMs?: number;
  /** 当前 running 段起点（epoch ms；queued/parked/终态不携带；additive） */
  startedAtMs?: number;
  /** 终态实例（done/failed）携带；其余不携带 */
  closure?: ClosureDto;
  /** 该实例累计（popover 行数据） */
  usage?: UsageDto;
  /**
   * per-instance channel 完整历史（v0.2 新增，AD-1 硬约束，additive）：
   * **不随主时间轴尾窗截断**——SubAgent 及主实例非主时间轴 channel 的
   * 历史按实例分组完整保留（F-14⑤）。缺省 = 未携带（旧剧本兼容）。
   */
  channels?: InstanceChannelHistory;
  /**
   * spawn 锚（v0.3 新增，契约 v0.3 §1，Q-1a）：卡片插入位的权威 entry id
   * （复用 EntryDto.id 体系）。daemon 组装期权威计算（派生值不持久化，无
   * 第二事实源）；快照组装面与 agent.spawned 增量帧同源供给。
   * null = 流首锚点（有效值：实例首条 Entry 之前无 main/compaction entry，
   * 卡片渲染流首）；缺省不携带 = 主实例（kind=main，无卡片无锚）。
   */
  anchorEntryId?: string | null;
}

/** 实例通道历史分组（AgentInstanceDto.channels 载体；EntryDto 归 kind 分组） */
export interface InstanceChannelHistory {
  thinking?: EntryDto[];
  messages?: EntryDto[];
  tools?: EntryDto[];
}
