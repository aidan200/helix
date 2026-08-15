/**
 * 会话快照 DTO（契约 §6；F(8).2）。
 *
 * 重连恢复 = 快照 + 增量（AD-16）：握手通过/重连后由 session.snapshot
 * 事件全量下发；首连空会话 = entries 为空数组。前端零权威状态，
 * 投影全量来自快照 + 增量事件。
 */
import type { AgentStateDto } from "./agent";
import type { MessageEntryDto } from "./chat";
import type { ToolCallEntryDto } from "./tool";

/** 会话条目：判别式联合，按 `kind` 窄化（message | tool-call） */
export type EntryDto = MessageEntryDto | ToolCallEntryDto;

export interface SessionSnapshotDto {
  sessionId: string;
  /** 展示用模型名（P-1 header 模型徽标；来自 ~/.helix/config.json 的 model） */
  model: string;
  agentState: AgentStateDto;
  /** 增量基线序号：快照之后的增量事件续接于此 */
  revision: number;
  /** 会话条目，时间顺序排列 */
  entries: EntryDto[];
}
