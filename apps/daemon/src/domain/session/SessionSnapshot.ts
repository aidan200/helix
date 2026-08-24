import type { EntryData } from "./Entry";
import type { TurnData } from "./Turn";
import type { SteerItem } from "../agent/SteerQueue";
import type { AgentInstanceData } from "../agent/AgentInstance";
import type { ThinkingEntryData } from "./ThinkingEntry";
import type { CompactionEntryData } from "./CompactionEntry";

/**
 * 会话条目数据联合：message（EntryData）/ thinking / compaction
 * 三类变体同树混排（判别键 kind——message 变体无 kind，以 "role" in 判别）。
 */
export type SessionEntryData = EntryData | ThinkingEntryData | CompactionEntryData;

/**
 * 会话快照（architecture.md §3.3，值对象）：domain 聚合的可序列化全量视图。
 *
 * 用途：SessionRepositoryPort.save/restore 的载荷（write-through 持久化对象）、
 * SessionPort.getSnapshot 的重连/恢复推送给前端（AD-16：快照+增量事件）。
 * 纯数据（贫血），充血 ↔ 贫血的转换在 Session.toSnapshot / restoreFrom。
 */
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly createdAt: string;
  /**
   * 主实例 id（T10a 方案 A：`agent-<唯一串>`，会话创建时经 newInstanceId()
   * 分配）。可选——旧快照（列前时代）无本字段 → 恢复侧兜底 legacy "main"
   * （历史行 instance_id="main" 不重写，与该会话数据自闭合）。
   */
  readonly mainInstanceId?: string;
  /** 全量条目（语义单元，不含流式中间态；message/thinking/compaction 混排，每条挂 instanceId，AD-3）。 */
  readonly entries: readonly SessionEntryData[];
  /** 全量轮次。 */
  readonly turns: readonly TurnData[];
  /** 未消费的 steer 队列（重启后仍可注入， ④）。 */
  readonly pendingSteer: readonly SteerItem[];

  // ── 占位字段（结构对齐契约 protocol-v0.1.md §6.2）──

  /**
   * 实例清单（重启恢复卡片/抽屉骨架）。权威源是实例注册表（AgentLifecycle
   * 注册表 / agent_lifecycle 每实例行）——本字段是快照投影位：编排侧
   * （调度器）装配后随聚合 JSON 落盘透传；缺省 = 未携带。
   */
  readonly instances?: readonly AgentInstanceData[];

  /**
   * 会话账目聚合（徽标/popover 数据源）。：UsageLedger 投影真值装配
   *（组合根 getUsage 单点）；形状与契约 SessionUsageDto 对齐。
   */
  readonly usage?: SessionUsageSummary;
}

/**
 * 单次（或累计）用量（契约 §6.2 UsageDto 的 domain 侧镜像：七字段全显式，
 * cost 拍平为 number）。pi 侧 Usage 的防腐提取在 pi-engine mapper。
 */
export interface UsageSummary {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly totalTokens: number;
  readonly cost: number;
}

/** 会话账目聚合：total = 各实例行合计；compaction = 摘要调用小计（AD-9③）。 */
export interface SessionUsageSummary {
  readonly total: UsageSummary;
  readonly compaction: UsageSummary;
}
