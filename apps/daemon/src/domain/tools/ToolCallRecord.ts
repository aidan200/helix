import { DomainError } from "../DomainError";
// 实例归属 legacy 缺省（"main" 字面只读兼容：restore 旧载荷/旧行无
// instanceId 时回填；create 强制显式传参——新记录归属由调用方携带）
import { LEGACY_MAIN_INSTANCE_ID } from "../agent/AgentInstance";

/**
 * 工具调用记录（architecture.md §3.3）：pending→running→completed/failed。
 *
 * 状态迁移是业务规则：未 running 不可完成/失败；终态（completed/failed）不可再迁移。
 * 结果/错误在迁移时附加（complete/fail 一步完成状态与数据落地）。
 */
export type ToolCallStatus = "pending" | "running" | "completed" | "failed";

const TOOL_CALL_STATUSES: readonly ToolCallStatus[] = ["pending", "running", "completed", "failed"];

/**
 * 工具调用形态判别（tool_calls 监控 kind 列）：main=主会话 / subagent=SubAgent
 * / steward=管家。
 *
 * 为什么存在：T10a 后会话主实例 id 改为 agent-<唯一串>（与 SubAgent 同形态），
 * 按 instance_id 形态无法区分主会话与 SubAgent 工具行；steward 工具行此前
 * 全不入账（只有 domain_events loop.tool.* 轨迹）。监控/复盘/画像查询需要
 * 形态判别一列定音，不再靠 id 前缀启发式。
 */
export type ToolCallKind = "main" | "subagent" | "steward";

/**
 * 形态推导（legacy 载荷/旧行兜底）：instanceId 缺省或 legacy "main" → main；
 * 等于会话主实例 id（T10a 后主实例亦为 agent-<唯一串>）→ main；其余 → subagent。
 * （历史无 steward 行——该形态在 kind 列引入后才有直书入账，不参与推导。）
 */
export function deriveToolCallKind(instanceId?: string, mainInstanceId?: string | null): ToolCallKind {
  if (instanceId === undefined || instanceId === LEGACY_MAIN_INSTANCE_ID) return "main";
  if (mainInstanceId !== undefined && mainInstanceId !== null && instanceId === mainInstanceId) return "main";
  return "subagent";
}

/** 工具调用记录的可序列化只读视图（快照/持久化载荷，贫血形状）。 */
export interface ToolCallRecordData {
  readonly id: string;
  readonly toolName: string;
  readonly args: unknown;
  /** 实例归属（AD-3）：缺省 = 主实例（旧载荷/旧行前向兼容，legacy "main"）；SubAgent = agent-<唯一串>。 */
  readonly instanceId?: string;
  /** 形态判别（监控 kind）：缺省 = 旧载荷/旧行（读面经 deriveToolCallKind 推导）。 */
  readonly kind?: ToolCallKind;
  readonly status: ToolCallStatus;
  readonly result?: string;
  readonly error?: string;
  /** 工具结果附带图片（下行）：base64 data URL 数组（如截图）；缺省 = 无图。 */
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
    readonly kind: ToolCallKind,
    private _status: ToolCallStatus,
    private _result?: string,
    private _error?: string,
    private _images?: readonly string[],
    private _startedAt?: string,
    private _endedAt?: string,
  ) {}

  static create(id: string, toolName: string, args: unknown, instanceId: string, kind: ToolCallKind): ToolCallRecord {
    return new ToolCallRecord(id, toolName, args, instanceId, kind, "pending");
  }

  /** 从持久化数据重建（恢复路径：不算状态迁移，直接置位；行为与终态一致）。
   *  mainInstanceId 可选：旧载荷无 kind 时的形态推导判据（主实例 agent 形态 id
   *  与 SubAgent 同形态，需会话主 id 对照才能判 main）。 */
  static restore(data: ToolCallRecordData, mainInstanceId?: string | null): ToolCallRecord {
    // 态集校验对齐 AgentInstance.restore：脏行（status 词表外）在重建点拒绝，
    // 不让后续一切状态迁移恒抛（早暴露早定位）
    if (!(TOOL_CALL_STATUSES as readonly string[]).includes(data.status)) {
      throw new DomainError(`工具调用 ${data.id}（${data.toolName}）状态非法：${String(data.status)}`);
    }
    return new ToolCallRecord(
      data.id,
      data.toolName,
      data.args,
      data.instanceId ?? LEGACY_MAIN_INSTANCE_ID,
      data.kind ?? deriveToolCallKind(data.instanceId, mainInstanceId),
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

  /** running→completed，附加结果（images 可选： 下行工具截图 data URL）。 */
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
      // 行级归属透传：legacy "main" 缺省省略（旧形状保持）；新会话主实例
      // id（agent-<唯一串>）与 SubAgent id 恒显式携带（T10a 方案 A）
      ...(this.instanceId !== LEGACY_MAIN_INSTANCE_ID ? { instanceId: this.instanceId } : {}),
      kind: this.kind,
      status: this._status,
      result: this._result,
      error: this._error,
      // 下行：工具结果附带图片（缺省省略——线格式保持旧形状）
      ...(this._images !== undefined && this._images.length > 0 ? { images: [...this._images] } : {}),
      startedAt: this._startedAt,
      endedAt: this._endedAt,
    };
  }
}
