import { DomainError } from "../DomainError";

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
  readonly status: ToolCallStatus;
  readonly result?: string;
  readonly error?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export class ToolCallRecord {
  private constructor(
    readonly id: string,
    readonly toolName: string,
    readonly args: unknown,
    private _status: ToolCallStatus,
    private _result?: string,
    private _error?: string,
    private _startedAt?: string,
    private _endedAt?: string,
  ) {}

  static create(id: string, toolName: string, args: unknown): ToolCallRecord {
    return new ToolCallRecord(id, toolName, args, "pending");
  }

  /** 从持久化数据重建（恢复路径：不算状态迁移，直接置位；行为与终态一致）。 */
  static restore(data: ToolCallRecordData): ToolCallRecord {
    return new ToolCallRecord(
      data.id,
      data.toolName,
      data.args,
      data.status,
      data.result,
      data.error,
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

  /** running→completed，附加结果。 */
  complete(result: string, endedAt?: string): void {
    this.expect("running", "complete");
    this._status = "completed";
    this._result = result;
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
      status: this._status,
      result: this._result,
      error: this._error,
      startedAt: this._startedAt,
      endedAt: this._endedAt,
    };
  }
}
