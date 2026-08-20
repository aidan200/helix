import type { EventFrame } from "../envelope";
import type {
  CompactionEntryDto,
  ThinkingEntryDto,
} from "../types/session";
import type { UsageDto } from "../types/usage";

// ── v0.1 新增 payload：通道族（契约 protocol-v0.1.md §5.2；AD-3/AD-9） ──

/** thinking.stream.delta：thinking 流式增量（中间态不落盘，TR-AD-5） */
export interface ThinkingStreamDeltaPayload {
  instanceId: string;
  delta: string;
}

/** thinking.completed：thinking 完成落 Entry */
export interface ThinkingCompletedPayload {
  entry: ThinkingEntryDto;
}

/**
 * compaction.completed：compaction 完成（含 usage，AD-9③）。
 * v0.2 additive（契约 A §4-4，OI 收口）：`tailKept` / `filesCompacted`
 * 尾部/文件计数（命名定稿）；缺省 = 未携带（v0/v0.1 帧兼容）。
 */
export interface CompactionCompletedPayload {
  entry: CompactionEntryDto;
  /** 压缩后保留的尾部条目数（尾窗口径对账） */
  tailKept?: number;
  /** 纳入压缩的上下文文件数 */
  filesCompacted?: number;
}

/** usage.recorded：turn 完成 / compaction 摘要调用完成（流式中不发，AD-4） */
export interface UsageRecordedPayload {
  instanceId: string;
  usage: UsageDto;
  source: "turn" | "compaction";
}

// ── v0.1 新增信封（契约 protocol-v0.1.md §5） ──

export interface ThinkingStreamDeltaEvent
  extends EventFrame<ThinkingStreamDeltaPayload> {
  channel?: "thinking";
  type: "thinking.stream.delta";
}
export interface ThinkingCompletedEvent
  extends EventFrame<ThinkingCompletedPayload> {
  channel?: "thinking";
  type: "thinking.completed";
}
export interface CompactionCompletedEvent
  extends EventFrame<CompactionCompletedPayload> {
  channel?: "compaction";
  type: "compaction.completed";
}
export interface UsageRecordedEvent extends EventFrame<UsageRecordedPayload> {
  channel?: "usage";
  type: "usage.recorded";
}
