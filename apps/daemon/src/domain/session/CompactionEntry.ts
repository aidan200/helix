import { DomainError } from "../DomainError";
import type { UsageSummary } from "./SessionSnapshot";

/**
 * CompactionEntry —— 上下文压缩里程碑条目（architecture.md §3，契约 §6.1；
 * 原型「⇄ 上下文已压缩 340k→20k」折叠条的数据源）。
 *
 * turn 边界压缩完成时落一条：tokensAfter 为压缩后 estimateContextTokens
 * 复算值；usage 为摘要调用成本（账目不漏，AD-9③——provider 未报时零值
 * 占位，仍入账保持账目行完整）。instanceId 归属同 Entry（AD-3）。
 */
export interface CompactionEntryData {
  readonly kind: "compaction";
  readonly id: string;
  readonly instanceId: string;
  readonly tokensBefore: number;
  /** 压缩后上下文 tokens（复算值）。 */
  readonly tokensAfter: number;
  readonly summary: string;
  /** 摘要调用量（七字段；provider 未报时零值占位）。 */
  readonly usage: UsageSummary;
  readonly createdAt: string;
}

export class CompactionEntry {
  private constructor(private readonly data: CompactionEntryData) {}

  static create(data: CompactionEntryData): CompactionEntry {
    if (data.summary.trim() === "") {
      throw new DomainError(`compaction 条目 ${data.id} summary 不能为空`);
    }
    if (typeof data.instanceId !== "string" || data.instanceId.trim() === "") {
      throw new DomainError(`compaction 条目 ${data.id} 缺少实例归属 instanceId`);
    }
    if (!Number.isFinite(data.tokensBefore) || !Number.isFinite(data.tokensAfter)) {
      throw new DomainError(`compaction 条目 ${data.id} token 计数非法（${data.tokensBefore}→${data.tokensAfter}）`);
    }
    return new CompactionEntry({ ...data });
  }

  /** 条目 id（快照计数器重建用；只读观测面）。 */
  get id(): string {
    return this.data.id;
  }

  toData(): CompactionEntryData {
    return { ...this.data };
  }
}
