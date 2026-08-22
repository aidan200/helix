import { DomainError } from "../DomainError";

/**
 * 轮次（architecture.md §3.3）：用户输入→流式生成→（工具执行→再生成…）→完成/中断。
 *
 * 状态迁移规则（何时允许 steer 注入等业务语义在此收口）：
 * - generating：assistant 流式生成中；
 * - toolRunning：本轮触发的工具执行中（生成暂停等工具）；
 * - completed：轮次正常收尾（终态）；
 * - interrupted：轮次被 abort 中断（终态；abort 非销毁，会话可开新轮）。
 *
 * steer 注入规则：generating / toolRunning 期间允许（isSteerable）——
 * 与实测一致（工具执行中/生成中均可入队，turn 边界 drain）；
 * 终态轮次不允许再注入（新输入应开新轮）。
 */
export type TurnStatus = "generating" | "toolRunning" | "completed" | "interrupted";

export interface TurnData {
  readonly id: string;
  readonly inputEntryId: string;
  readonly status: TurnStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export class Turn {
  private constructor(
    readonly id: string,
    readonly inputEntryId: string,
    private _status: TurnStatus,
    readonly startedAt: string,
    private _endedAt: string | null,
  ) {}

  static create(data: TurnData): Turn {
    return new Turn(data.id, data.inputEntryId, data.status, data.startedAt, data.endedAt);
  }

  get status(): TurnStatus {
    return this._status;
  }
  get endedAt(): string | null {
    return this._endedAt;
  }

  /** 是否允许注入 steer（迁移规则的可观测面）。 */
  isSteerable(): boolean {
    return this._status === "generating" || this._status === "toolRunning";
  }

  /** generating→toolRunning（第一个工具开始执行）。 */
  markToolRunning(): void {
    this.expect("generating", "markToolRunning");
    this._status = "toolRunning";
  }

  /** toolRunning→generating（工具批完成，assistant 继续生成）。 */
  resumeGenerating(): void {
    this.expect("toolRunning", "resumeGenerating");
    this._status = "generating";
  }

  /** generating/toolRunning→completed（正常收尾，终态）。 */
  complete(endedAt?: string): void {
    if (this._status !== "generating" && this._status !== "toolRunning") {
      throw new DomainError(`轮次 ${this.id} 非法收尾：complete 要求未终态，当前 ${this._status}`);
    }
    this._status = "completed";
    this._endedAt = endedAt ?? null;
  }

  /** generating/toolRunning→interrupted（abort，终态）。 */
  interrupt(endedAt?: string): void {
    if (this._status !== "generating" && this._status !== "toolRunning") {
      throw new DomainError(`轮次 ${this.id} 非法中断：interrupt 要求未终态，当前 ${this._status}`);
    }
    this._status = "interrupted";
    this._endedAt = endedAt ?? null;
  }

  private expect(from: TurnStatus, op: string): void {
    if (this._status !== from) {
      throw new DomainError(`轮次 ${this.id} 非法迁移：${op} 要求 ${from}，当前 ${this._status}`);
    }
  }

  toData(): TurnData {
    return {
      id: this.id,
      inputEntryId: this.inputEntryId,
      status: this._status,
      startedAt: this.startedAt,
      endedAt: this._endedAt,
    };
  }
}
