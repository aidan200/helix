/**
 * 会话快照 DTO（契约 §6；F(8).2）。
 *
 * 重连恢复 = 快照 + 增量（AD-16）：握手通过/重连后由 session.snapshot
 * 事件全量下发；首连空会话 = entries 为空数组。前端零权威状态，
 * 投影全量来自快照 + 增量事件。
 */
import type { AgentInstanceDto, AgentStateDto } from "./agent";
import type { MessageEntryDto } from "./chat";
import type { ToolCallEntryDto } from "./tool";
import type { SessionUsageDto, UsageDto } from "./usage";

/** 会话条目：判别式联合，按 `kind` 窄化（message | tool-call | thinking | compaction） */
export type EntryDto =
  | MessageEntryDto
  | ToolCallEntryDto
  | ThinkingEntryDto
  | CompactionEntryDto;

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
  reasoningTokens: number;
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

export interface SessionSnapshotDto {
  sessionId: string;
  /** 展示用模型名（P-1 header 模型徽标；来自 ~/.helix/config.json 的 model） */
  model: string;
  agentState: AgentStateDto;
  /** 增量基线序号：快照之后的增量事件续接于此 */
  revision: number;
  /** 会话条目，时间顺序排列 */
  entries: EntryDto[];
  /** 实例清单（v0.1 新增）：重启恢复卡片/抽屉骨架；缺省 = 未携带（旧剧本兼容） */
  instances?: AgentInstanceDto[];
  /** 账目聚合（v0.1 新增）：重启恢复徽标/popover；缺省 = 未携带（旧剧本兼容） */
  usage?: SessionUsageDto;
}
