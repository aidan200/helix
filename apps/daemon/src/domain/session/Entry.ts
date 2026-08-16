import { DomainError } from "../DomainError";
import { MAIN_INSTANCE_ID } from "../agent/AgentInstance";

/**
 * 会话条目（architecture.md §3.3）：会话语义单元（一条完成的消息）。
 *
 * 注意与「流式中间态」的区别：Entry 只在消息完成时落地；
 * token 级 delta 不是 Entry、不是领域事件、不落盘（AD-16 §5.3）。
 * isSteer=true 标记该 user entry 来自运行中注入（steer），drain 后驱动新 turn。
 *
 * instanceId（AD-3，iter-20260816-uzvg T1.2）：Entry 的实例归属（必填）——
 * 会话聚合跨实例持续追加（AD-1 三层模型），每条 Entry 挂产生它的实例；
 * 主实例固定 MAIN_INSTANCE_ID（"main"，O-4），SubAgent 为 agent-N。
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
    };
  }
}
