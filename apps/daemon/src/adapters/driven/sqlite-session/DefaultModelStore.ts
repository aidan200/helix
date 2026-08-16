import type { WriteQueue } from "./WriteQueue";
import type { DefaultModelPort } from "../../../application/ports/outbound/DefaultModelPort";

/**
 * DefaultModelStore —— 全局默认模型的 SQLite 存取（AD-2 auth 分层：
 * 「经常变的状态不进 JSON」→ helix.db default_model 单行表）。
 *
 * 写面经 WriteQueue 单写通道（AG-06：写语句只在 WriteQueue 内）；读面共用
 * WriteQueue 暴露的 database 连接（SqliteSessionRepository 同构读侧模式）。
 * fallback：存储缺省（首启/未设置）时的 builtin 默认模型 id（组合根注入，
 * model-provider.DEFAULT_MODEL_ID）——current() 永不 undefined。
 */
export class DefaultModelStore implements DefaultModelPort {
  /** 最近已知值（shutdown 后 db 关闭时的读面兑底——getStatus 等观测面仍可用）。 */
  private cached: string | undefined;

  constructor(
    private readonly writeQueue: WriteQueue,
    private readonly fallback: string,
  ) {}

  /** SQLite 原值（未设置 → undefined；db 已关闭 → 最近已知值）。 */
  stored(): string | undefined {
    try {
      const row = this.writeQueue.database
        .prepare("SELECT model FROM default_model WHERE id = 1")
        .get() as { model: string } | undefined;
      this.cached = row?.model;
      return this.cached;
    } catch {
      return this.cached; // db 已关闭（daemon 收尾后观测面）——最近已知值
    }
  }

  /** 当前生效默认（存储值 ?? builtin 兜底；永不 undefined）。 */
  current(): string {
    return this.stored() ?? this.fallback;
  }

  /** 写入默认模型（WriteQueue 单写通道，落盘完成即返回；同步观测缓存）。 */
  async set(model: string): Promise<void> {
    this.cached = model;
    await this.writeQueue.saveDefaultModel(model);
  }
}
