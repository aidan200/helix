import { DomainError } from "../DomainError";
// 实例归属常量：domain 内部值锚点（AG-02；线上权威导出在 @helix/protocol，
// 双源相等性由 protocol-import.test.ts 守护）
import { MAIN_INSTANCE_ID } from "../agent/AgentInstance";

/**
 * 工具调用记录（architecture.md §3.3）：pending→running→completed/failed。
 *
 * 状态迁移是业务规则：未 running 不可完成/失败；终态（completed/failed）不可再迁移。
 * 结果/错误在迁移时附加（complete/fail 一步完成状态与数据落地）。
 */
export type ToolCallStatus = "pending" | "running" | "completed" | "failed";

/** 工具调用记录的可序列化只读视图（快照/持久化载荷，贫血形状）。 */
export interface ToolCallRecordData {
  readonly id: string;
  readonly toolName: string;
  readonly args: unknown;
  /** 实例归属（T2.1 AD-3）：缺省 = 主实例（旧载荷/旧行前向兼容）；SubAgent = agent-N。 */
  readonly instanceId?: string;
  readonly status: ToolCallStatus;
  readonly result?: string;
  readonly error?: string;
  /** 工具结果附带图片（T9 下行）：base64 data URL 数组（如截图）；缺省 = 无图。 */
  readonly images?: readonly string[];
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export class ToolCallRecord {
  private constructor(
    readonly id: string,
    readonly toolName: string,
    readonly args: unknown,
    private readonly instanceId: string,
    private _status: ToolCallStatus,
    private _result?: string,
    private _error?: string,
    private _images?: readonly string[],
    private _startedAt?: string,
    private _endedAt?: string,
  ) {}

  static create(id: string, toolName: string, args: unknown, instanceId: string = MAIN_INSTANCE_ID): ToolCallRecord {
    return new ToolCallRecord(id, toolName, args, instanceId, "pending");
  }

  /** 从持久化数据重建（恢复路径：不算状态迁移，直接置位；行为与终态一致）。 */
  static restore(data: ToolCallRecordData): ToolCallRecord {
    return new ToolCallRecord(
      data.id,
      data.toolName,
      data.args,
      data.instanceId ?? MAIN_INSTANCE_ID,
      data.status,
      data.result,
      data.error,
      data.images,
      data.startedAt,
      data.endedAt,
    );
  }

  get status(): ToolCallStatus {
    return this._status;
  }
  get result(): string | undefined {
    return this._result;
  }
  get error(): string | undefined {
    return this._error;
  }
  get startedAt(): string | undefined {
    return this._startedAt;
  }
  get endedAt(): string | undefined {
    return this._endedAt;
  }

  /** pending→running。 */
  markRunning(startedAt?: string): void {
    this.expect("pending", "markRunning");
    this._status = "running";
    this._startedAt = startedAt;
  }

  /** running→completed，附加结果（images 可选：T9 下行工具截图 data URL）。 */
  complete(result: string, endedAt?: string, images?: readonly string[]): void {
    this.expect("running", "complete");
    this._status = "completed";
    this._result = result;
    this._images = images;
    this._endedAt = endedAt ?? new Date().toISOString();
  }

  /** running→failed，附加错误。 */
  fail(error: string, endedAt?: string): void {
    this.expect("running", "fail");
    this._status = "failed";
    this._error = error;
    this._endedAt = endedAt ?? new Date().toISOString();
  }

  private expect(from: ToolCallStatus, op: string): void {
    if (this._status !== from) {
      throw new DomainError(
        `工具调用 ${this.id}（${this.toolName}）非法状态迁移：${op} 要求 ${from}，当前 ${this._status}`,
      );
    }
  }

  /** 快照用：只读数据。 */
  toData(): ToolCallRecordData {
    return {
      id: this.id,
      toolName: this.toolName,
      args: this.args,
      // T2.1：行级归属透传（主实例缺省省略——线格式保持 v0/v0.1 形状）
      ...(this.instanceId !== MAIN_INSTANCE_ID ? { instanceId: this.instanceId } : {}),
      status: this._status,
      result: this._result,
      error: this._error,
      // T9 下行：工具结果附带图片（缺省省略——线格式保持旧形状）
      ...(this._images !== undefined && this._images.length > 0 ? { images: [...this._images] } : {}),
      startedAt: this._startedAt,
      endedAt: this._endedAt,
    };
  }
}
