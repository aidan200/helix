import { DomainError } from "../DomainError";
import { MAIN_INSTANCE_ID } from "../agent/AgentInstance";
import type { SteerSource } from "../agent/SteerQueue";

/**
 * 会话条目（architecture.md §3.3）：会话语义单元（一条完成的消息）。
 *
 * 注意与「流式中间态」的区别：Entry 只在消息完成时落地；
 * token 级 delta 不是 Entry、不是领域事件、不落盘（AD-16 §5.3）。
 * isSteer=true 标记该 user entry 来自运行中注入（steer），drain 后驱动新 turn。
 *
 * instanceId（AD-3）：Entry 的实例归属（必填）——
 * 会话聚合跨实例持续追加（AD-1 三层模型），每条 Entry 挂产生它的实例；
 * 主实例固定 MAIN_INSTANCE_ID（"main"），SubAgent 为 agent-N。
 */
export type EntryRole = "user" | "assistant" | "tool";

export interface EntryData {
  readonly id: string;
  readonly role: EntryRole;
  readonly text: string;
  readonly turnId: string | null;
  readonly isSteer: boolean;
  readonly instanceId: string;
  readonly createdAt: string;
  /**
   * 注入来源（T11a closure/steer source 贯通）：仅注入类 user 条目携带
   * （steer/closure/进展报告；普通用户输入缺省 = user 语义）。持久化 JSON
   * 列往返自动携带（旧快照无字段 → undefined 前向兼容）。
   */
  readonly source?: SteerSource;
  /**
   * 图片附件（图片上行）：base64 data URL 数组；仅 user 消息携带
   * （chat.send.images 校验后原样落盘）。可选——缺省 = 纯文本旧形态
   * （持久化 JSON 列往返自动携带，v0/v0.1 快照兼容）。
   */
  readonly images?: readonly string[];
}

export class Entry {
  private constructor(
    readonly id: string,
    readonly role: EntryRole,
    readonly text: string,
    readonly turnId: string | null,
    readonly isSteer: boolean,
    readonly instanceId: string,
    readonly createdAt: string,
    private readonly images?: readonly string[],
    readonly source?: SteerSource,
  ) {}

  static create(data: EntryData): Entry {
    if (data.text.trim() === "") {
      throw new DomainError(`会话条目 ${data.id ?? "(新)"} 内容不能为空（role=${data.role}）`);
    }
    if (typeof data.instanceId !== "string" || data.instanceId.trim() === "") {
      throw new DomainError(`会话条目 ${data.id ?? "(新)"} 缺少实例归属 instanceId（主实例为 ${MAIN_INSTANCE_ID}）`);
    }
    return new Entry(
      data.id,
      data.role,
      data.text,
      data.turnId,
      data.isSteer,
      data.instanceId,
      data.createdAt,
      data.images,
      data.source,
    );
  }

  toData(): EntryData {
    return {
      id: this.id,
      role: this.role,
      text: this.text,
      turnId: this.turnId,
      isSteer: this.isSteer,
      instanceId: this.instanceId,
      createdAt: this.createdAt,
      ...(this.images !== undefined ? { images: [...this.images] } : {}),
      ...(this.source !== undefined ? { source: this.source } : {}),
    };
  }
}
