import type { WriteQueue } from "./WriteQueue";
import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";

/**
 * RuntimeConfigStore —— 通用运行时配置 KV 的 SQLite 存取（P1 T1：runtime_config
 * 表，`key TEXT PRIMARY KEY, value TEXT NOT NULL`）。
 *
 * 写面经 WriteQueue 单写通道（AG-06：写语句只在 WriteQueue 内；runtime_config
 * 全局表无会话维 → 全局链 FIFO，勿入 sessionTails 分仓）；读面共用 WriteQueue
 * 暴露的 database 连接（ResourceStateStore 同构读侧模式；write-through：await
 * 的写 promise 落盘完成才 resolve，随后的同步读必见新值）。
 *
 * 语义边界：本 store 只做无语义键值面——键的解释（默认模型兜底等）在
 * 上层包装（DefaultModelStore）/ 组合根。
 */
export class RuntimeConfigStore implements RuntimeConfigPort {
  constructor(private readonly writeQueue: WriteQueue) {}

  /** KV 原值（键未设置 → undefined；bun:sqlite 无行返回 null 归一）。 */
  get(key: string): string | undefined {
    const row = this.writeQueue.database
      .prepare("SELECT value FROM runtime_config WHERE key = ?")
      .get(key) as { value: string } | null;
    return row === null ? undefined : row.value;
  }

  /** 写入键值（WriteQueue 单写通道，落盘完成即返回；同键 upsert 覆盖）。 */
  async set(key: string, value: string): Promise<void> {
    await this.writeQueue.saveRuntimeConfig(key, value);
  }
}
