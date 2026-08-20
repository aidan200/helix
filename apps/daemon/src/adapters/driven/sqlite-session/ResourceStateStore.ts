import type { WriteQueue } from "./WriteQueue";
import type {
  ProfileKind,
  ResourceStateData,
  ResourceStatePort,
  ResourceType,
} from "../../../application/ports/outbound/ResourceStatePort";

/**
 * ResourceStateStore —— profile kind 维资源启停差异行的 SQLite 存取
 * （M6 T1，DefaultModelStore 同构先例）。
 *
 * 写面经 WriteQueue 单写通道（AG-06：写语句只在 WriteQueue 内；resource_state
 * 全局表无会话维 → 全局链 FIFO，勿入 sessionTails 分仓）；读面共用
 * WriteQueue 暴露的 database 连接（write-through：await 的写 promise 落盘
 * 完成才 resolve，随后的同步读必见新行）。
 *
 * 语义边界：**缺省无记录 = 启用**的解释在 ResourceService 层——本 store 只
 * 存差异行；model 槽位单行不变式（enabled 恒 1、删除行 = 未设）由 WriteQueue
 * 的 modelSlot job 原子替换保证（见 saveModelSlot）。
 */

/** 差异行 SQLite 行形状（enabled 用 INTEGER 承载 boolean）。 */
interface ResourceStateRow {
  readonly profile_kind: string;
  readonly resource_type: string;
  readonly name: string;
  readonly enabled: number;
  readonly updated_at: string;
}

function toData(row: ResourceStateRow): ResourceStateData {
  return {
    profileKind: row.profile_kind as ProfileKind,
    resourceType: row.resource_type as ResourceType,
    name: row.name,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

export class ResourceStateStore implements ResourceStatePort {
  constructor(private readonly writeQueue: WriteQueue) {}

  async upsert(
    profileKind: ProfileKind,
    resourceType: ResourceType,
    name: string,
    enabled: boolean,
  ): Promise<void> {
    await this.writeQueue.saveResourceState(profileKind, resourceType, name, enabled);
  }

  get(profileKind: ProfileKind, resourceType: ResourceType, name: string): ResourceStateData | undefined {
    const row = this.writeQueue.database
      .prepare(
        "SELECT profile_kind, resource_type, name, enabled, updated_at FROM resource_state " +
          "WHERE profile_kind = ? AND resource_type = ? AND name = ?",
      )
      .get(profileKind, resourceType, name) as ResourceStateRow | null;
    return row === null ? undefined : toData(row);
  }

  list(profileKind: ProfileKind, resourceType?: ResourceType): readonly ResourceStateData[] {
    const rows = (
      resourceType === undefined
        ? this.writeQueue.database
            .prepare(
              "SELECT profile_kind, resource_type, name, enabled, updated_at FROM resource_state " +
                "WHERE profile_kind = ? ORDER BY rowid",
            )
            .all(profileKind)
        : this.writeQueue.database
            .prepare(
              "SELECT profile_kind, resource_type, name, enabled, updated_at FROM resource_state " +
                "WHERE profile_kind = ? AND resource_type = ? ORDER BY rowid",
            )
            .all(profileKind, resourceType)
    ) as ResourceStateRow[];
    return rows.map(toData);
  }

  async setModelSlot(profileKind: ProfileKind, model: string): Promise<void> {
    await this.writeQueue.saveModelSlot(profileKind, model);
  }

  async clearModelSlot(profileKind: ProfileKind): Promise<void> {
    await this.writeQueue.clearResourceState(profileKind, "model");
  }

  modelSlot(profileKind: ProfileKind): string | undefined {
    const row = this.writeQueue.database
      .prepare("SELECT name FROM resource_state WHERE profile_kind = ? AND resource_type = 'model'")
      .get(profileKind) as { name: string } | null;
    return row?.name; // bun:sqlite 无行返回 null（非 undefined）
  }
}
