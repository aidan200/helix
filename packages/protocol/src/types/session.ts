/**
 * 会话快照 DTO（契约 §6；F(8).2）。
 *
 * 重连恢复 = 快照 + 增量（AD-16）：握手通过/重连后由 session.snapshot
 * 事件全量下发；首连空会话 = entries 为空数组。前端零权威状态，
 * 投影全量来自快照 + 增量事件。
 */
import type { AgentInstanceDto, AgentStateDto } from "./agent";
import type { MessageEntryDto, SteerSource } from "./chat";
import type { ToolCallEntryDto } from "./tool";
import type { SessionUsageDto, UsageDto } from "./usage";
import type { TaskBatchLedgerDto, WorkItemDto } from "./task";

/** 会话条目：判别式联合，按 `kind` 窄化（message | tool-call | thinking | compaction | error） */
export type EntryDto =
  | MessageEntryDto
  | ToolCallEntryDto
  | ThinkingEntryDto
  | CompactionEntryDto
  | ErrorEntryDto;

/**
 * error 条目（error entry 批，EntryDto 的 error 变体）：引擎/模型失败的
 * 时间轴原位红条数据源。瞬态 engine.error 帧（state.engineError 内存卡）
 * 只服务当页即时反馈；本变体落盘进会话 entries——刷新/切换后错误在出错
 * 轮（turnId）原位可见。非 message kind：不回填 LLM 上下文（TR-45 天然过滤）。
 */
export interface ErrorEntryDto {
  kind: "error";
  id: string;
  /** 实例归属（wire 边界编码：主实例编 legacy "main" 字面，必填位同 thinking/compaction） */
  instanceId: string;
  /** 错误描述（provider 原文透传，领域数据不 i18n——同 engine.error 口径） */
  message: string;
  /** 出错轮次（原位锚：错误属于哪个失败轮） */
  turnId: string;
  createdAt: string;
}

/**
 * thinking 条目（v0.1 新增，EntryDto 的 thinking 变体；AD-3 挂 instanceId）。
 * 流式中间态走 thinking.stream.delta（不落盘）；完成态落本 Entry（text 全文）。
 */
export interface ThinkingEntryDto {
  kind: "thinking";
  id: string;
  instanceId: string;
  /** 全文（完成态） */
  text: string;
  durationMs: number;
  createdAt: string;
}

/**
 * compaction 条目（v0.1 新增，EntryDto 的 compaction 变体；AD-9 可见性同构）。
 * 里程碑折叠条「⇄ 上下文已压缩 N→M」的数据源；摘要调用成本入账（AD-9③）。
 */
export interface CompactionEntryDto {
  kind: "compaction";
  id: string;
  instanceId: string;
  tokensBefore: number;
  /** 压缩后上下文 tokens（原型「340k→20k」的 20k） */
  tokensAfter: number;
  summary: string;
  /** 摘要调用成本（账目不漏，AD-9③） */
  usage: UsageDto;
  createdAt: string;
}

/**
 * 会话清单条目（v0.2 新增，契约 B §1.1）：session.list 响应与
 * session.list_changed 事件的载荷元素，同源同构。
 */
export interface SessionMeta {
  sessionId: string;
  /** 草稿外的既有会话：自动命名（首条用户消息截断 20 字符，Unicode 码点）或后续更名 */
  title: string;
  /** epoch ms；session.list 按此降序 */
  lastActivityAt: number;
  runState: "idle" | "streaming" | "subagent_running";
  /** 注册表内（热）与否（冷） */
  loaded: boolean;
}

/** 未消费 steer 队列项（SessionSnapshotDto.pendingSteer 元素；domain SteerItem 同构）。 */
export interface PendingSteerDto {
  /** 预分配 entry id（D-2 同源：drain 落盘时条目的 id） */
  entryId: string;
  text: string;
  /** 注入来源（缺省 = user 语义） */
  source?: SteerSource;
}

export interface SessionSnapshotDto {
  sessionId: string;
  /** 展示用模型名（P-1 header 模型徽标；T2.3（AD-2）：会话级模型——引擎观测值，缺省回退 SQLite 默认表 + builtin 兜底） */
  model: string;
  agentState: AgentStateDto;
  /** 增量基线序号：快照之后的增量事件续接于此 */
  revision: number;
  /** 会话条目，时间顺序排列（v0/v0.1 全量口径；v0.2 尾窗口径下 daemon 填充 = tail 同源） */
  entries: EntryDto[];
  /** 实例清单（v0.1 新增）：重启恢复卡片/抽屉骨架；缺省 = 未携带（旧剧本兼容） */
  instances?: AgentInstanceDto[];
  /** 账目聚合（v0.1 新增）：重启恢复徽标/popover；缺省 = 未携带（旧剧本兼容） */
  usage?: SessionUsageDto;
  /**
   * 主时间轴尾窗（v0.2 新增，AD-1 尾窗口径，additive）：默认 30 条（G-1）。
   * 尾窗只作用于主时间轴 entry；per-instance channel 分组（instances[].channels）
   * 完整保留不截断（F-14⑤ 硬约束）。缺省 = 未携带（v0/v0.1 旧剧本兼容）。
   */
  tail?: EntryDto[];
  /** 全量计数（v0.2 新增，分页指示用，additive）：缺省 = 未携带 */
  totalEntries?: number;
  /**
   * 尾窗最早 entry id（v0.2 新增，AD-1 分页游标，additive）：loadHistory 首页游标；
   * null = 已含全部历史（禁用加载更早）。缺省 = 未携带。
   */
  tailStartCursor?: string | null;
  /**
   * 未消费 steer 队列（additive）：前端队列坞重建数据源——drain 落盘语义下
   * queued 项不是时间轴条目（不在 entries 里），切换/重连/重启后队列坞从
   * 本字段重建。缺省/空 = 无排队注入（旧剧本兼容）。
   */
  pendingSteer?: PendingSteerDto[];
  /**
   * 会话 thinking 覆盖/生效双位（v0.11 批内补登，thinking 批③ F-8 修复——
   * daemon SessionStateView.thinking 的 wire 面接通）：切换会话/重连/重启
   * 恢复后 UI 与引擎一致（F1.5）。缺省 = 未携带（旧剧本兼容 / 引擎未实现
   * 观测面）；携带时 null = 无覆盖 / 全链不支持不传参。字符串透传（AD-2）。
   */
  thinking?: {
    /** 会话覆盖意图；null = 无覆盖。 */
    override: string | null;
    /** 引擎按当前模型能力解析的生效档；null = 全链不支持（不传参，provider 默认）。 */
    effective: string | null;
  };
  /**
   * 会话模式（P1 会话模式框架 T2，additive；PROTOCOL.md §18）：建会话时
   * 定格（chat.send draft 链 mode 透传落库；此后无写路径——快照只读回带）。
   * 缺省 = 未携带（旧剧本/旧 daemon 兼容，读侧按 "default" 兜底）。
   */
  mode?: string;
  /**
   * 主会话工作台账全行（main-session plan 批，additive）：instanceId 维度
   * = sessionId（主会话 plan 三工具写面落 work_item）；重连/恢复种子——
   * 增量面 = session.plan.changed。携带时 null = 无台账（轻量任务未建）；
   * 缺省 = 未携带（旧 daemon 兼容，读侧保持现值）。
   */
  plan?: WorkItemDto[] | null;
  /** 台账计数摘要（与 plan 同源同 null 语义，服务端组装；缺省 = 未携带）。 */
  ledger?: TaskBatchLedgerDto | null;
}
