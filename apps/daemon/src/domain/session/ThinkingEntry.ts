import { DomainError } from "../DomainError";

/**
 * ThinkingEntry —— thinking 完成态条目（architecture.md §3，契约 §6.1）。
 *
 * 流式中间态（token 级 thinking delta）不是条目、不落盘（TR-AD-5）；
 * 一个完成态 thinking 块（pi thinking_start→thinking_end）落一条。
 * durationMs = thinking_start→end 墙钟差（ClockPort 侧计时，编排层挂）；
 * reasoningTokens 取该 turn message_end usage.reasoning（本 turn 关联）。
 * instanceId 归属同 Entry（AD-3；主实例固定 "main"）。
 */
export interface ThinkingEntryData {
  readonly kind: "thinking";
  readonly id: string;
  readonly instanceId: string;
  /** 全文（完成态）。 */
  readonly text: string;
  readonly durationMs: number;
  readonly reasoningTokens: number;
  readonly createdAt: string;
}

export class ThinkingEntry {
  private constructor(private readonly data: ThinkingEntryData) {}

  static create(data: ThinkingEntryData): ThinkingEntry {
    if (data.text.trim() === "") {
      throw new DomainError(`thinking 条目 ${data.id} 内容不能为空（空文本不是语义单元）`);
    }
    if (typeof data.instanceId !== "string" || data.instanceId.trim() === "") {
      throw new DomainError(`thinking 条目 ${data.id} 缺少实例归属 instanceId`);
    }
    if (!Number.isFinite(data.durationMs) || data.durationMs < 0) {
      throw new DomainError(`thinking 条目 ${data.id} durationMs 非法（${data.durationMs}）`);
    }
    return new ThinkingEntry({ ...data, durationMs: Math.floor(data.durationMs) });
  }

  /** 条目 id（快照计数器重建用；只读观测面）。 */
  get id(): string {
    return this.data.id;
  }

  toData(): ThinkingEntryData {
    return { ...this.data };
  }
}
