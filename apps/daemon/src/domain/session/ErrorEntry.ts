import { DomainError } from "../DomainError";

/**
 * ErrorEntry —— 引擎/模型失败的错误条目（error entry 批：时间轴原位红条
 * 的数据源）。
 *
 * 轮次失败收尾时落一条（先落错误条目再收口——open turn 内追加不违反
 * 轮次不变式 TR-25）：turnId = 出错轮（原位锚）；message = provider 原文
 * 透传（领域数据不 i18n，与 engine.error 事件同口径）；instanceId 归属
 * 同 Entry（AD-3）。与 engine.error 领域事件并存：engine.error 是瞬态
 * 可观测事件（trace 链），本条目是落盘的展示面里程碑——刷新/切换后经
 * 快照 entries 原位可见。
 *
 * 非 message kind：恢复回填（seedMessagesOf，TR-45）天然不回填 LLM 上下文
 * （失败是展示面里程碑，不是对话历史）。
 */
export interface ErrorEntryData {
  readonly kind: "error";
  readonly id: string;
  readonly instanceId: string;
  /** 错误描述（provider 原文透传）。 */
  readonly message: string;
  /** 出错轮次（原位锚：错误属于哪个失败轮）。 */
  readonly turnId: string;
  readonly createdAt: string;
}

export class ErrorEntry {
  private constructor(private readonly data: ErrorEntryData) {}

  static create(data: ErrorEntryData): ErrorEntry {
    if (data.message.trim() === "") {
      throw new DomainError(`error 条目 ${data.id} message 不能为空（空文本不是语义单元）`);
    }
    if (typeof data.instanceId !== "string" || data.instanceId.trim() === "") {
      throw new DomainError(`error 条目 ${data.id} 缺少实例归属 instanceId`);
    }
    if (typeof data.turnId !== "string" || data.turnId.trim() === "") {
      throw new DomainError(`error 条目 ${data.id} 缺少出错轮次 turnId（原位锚）`);
    }
    return new ErrorEntry({ ...data });
  }

  /** 条目 id（快照计数器重建用；只读观测面）。 */
  get id(): string {
    return this.data.id;
  }

  toData(): ErrorEntryData {
    return { ...this.data };
  }
}
