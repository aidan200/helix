import { DomainError } from "../DomainError";

/**
 * ThinkingEntry —— thinking 完成态条目（architecture.md §3，契约 §6.1）。
 *
 * 流式中间态（token 级 thinking delta）不是条目、不落盘（TR-AD-5）；
 * 一个完成态 thinking 块（pi thinking_start→thinking_end）落一条，
 * thinking_end 到达即落账即广播（T35：不暂存等 message_end——块结束是
 * 实时事实，不等账目收口；CAND-35 方向②）。
 * durationMs = thinking_start→end 墙钟差（ClockPort 侧计时，编排层挂）。
 * instanceId 归属同 Entry（AD-3；主实例固定 "main"）。
 *
 * reasoningTokens 已退役（CAND-35）：原设计把 message 级 usage.reasoning
 * 冗余挂到块上（同消息多块共享同值、abort 轮零占位混同——语义歧义），
 * 且其「随条目一次落账」把 thinking.completed 绑架到 message_end。token
 * 账目唯一权威源 = usage.recorded 事件流（message_end、message 级，与
 * pi/厂商标准一致）；思考折叠条不再显示 token 消耗。旧快照/事件流载荷
 * 中的 reasoningTokens 字段经 create 显式挑字段自然净化（恢复往返瘦身）。
 */
export interface ThinkingEntryData {
  readonly kind: "thinking";
  readonly id: string;
  readonly instanceId: string;
  /** 全文（完成态）。 */
  readonly text: string;
  readonly durationMs: number;
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
    // 显式挑字段（T35）：旧库快照/事件流载荷含已退役的 reasoningTokens——
    // 逐字段拣选使恢复往返自动净化多余键，不让退役字段经重放回渗。
    return new ThinkingEntry({
      kind: "thinking",
      id: data.id,
      instanceId: data.instanceId,
      text: data.text,
      durationMs: Math.floor(data.durationMs),
      createdAt: data.createdAt,
    });
  }

  /** 条目 id（快照计数器重建用；只读观测面）。 */
  get id(): string {
    return this.data.id;
  }

  toData(): ThinkingEntryData {
    return { ...this.data };
  }
}
