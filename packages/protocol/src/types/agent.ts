import type { UsageDto } from "./usage";

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
 * 实例状态（编排四态 + cancelled）。
 * cancelled 仅重启恢复时 queued 收口使用（AD-10），运行期不产生。
 */
export type InstanceState = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * 实例清单条目（SessionSnapshotDto.instances 载体；重启恢复卡片/抽屉骨架）。
 * 主实例与 SubAgent 同构（AD-3 AgentInstance 一等概念），区别仅 kind/profileKind。
 */
export interface AgentInstanceDto {
  /** 实例标识（AD-3）：主实例固定 "main"；SubAgent = "agent-N" */
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
  /** 终态实例（done/failed）携带；其余不携带 */
  closure?: ClosureDto;
  /** 该实例累计（popover 行数据） */
  usage?: UsageDto;
}
