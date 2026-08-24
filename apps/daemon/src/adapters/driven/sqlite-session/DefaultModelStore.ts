import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { DefaultModelPort } from "../../../application/ports/outbound/DefaultModelPort";

/**
 * DefaultModelStore —— 全局默认模型的语义包装（P1 T1：存储底座迁
 * runtime_config KV 表，决策 D1/D2；本类从独占单行表实现改写为
 * RuntimeConfigPort 之上 default_model 键的读写 + builtin 兜底——
 * 调用面签名保持 stored/current/set 不变，消费方零改动）。
 *
 * AD-2 auth 分层语义不变：「经常变的状态不进 JSON」——落 SQLite KV。
 * 写面经 RuntimeConfigPort → WriteQueue 单写通道（AG-06：写语句只在
 * WriteQueue 内）。fallback：存储缺省（首启/未设置）时的 builtin 默认
 * 模型 id（组合根注入，model-provider.DEFAULT_MODEL_ID）——current()
 * 永不 undefined。
 */
export class DefaultModelStore implements DefaultModelPort {
  /** KV 里的默认模型键名（与 WriteQueue 启动迁移 migrateLegacyDefaultModel 同键）。 */
  private static readonly KEY = "default_model";

  /** 最近已知值（shutdown 后 db 关闭时的读面兑底——getStatus 等观测面仍可用）。 */
  private cached: string | undefined;

  constructor(
    private readonly runtimeConfig: RuntimeConfigPort,
    private readonly fallback: string,
  ) {}

  /** KV 原值（未设置 → undefined；db 已关闭 → 最近已知值）。 */
  stored(): string | undefined {
    try {
      this.cached = this.runtimeConfig.get(DefaultModelStore.KEY);
    } catch {
      // db 已关闭（daemon 收尾后观测面）——最近已知值
    }
    return this.cached;
  }

  /** 当前生效默认（存储值 ?? builtin 兜底；永不 undefined）。 */
  current(): string {
    return this.stored() ?? this.fallback;
  }

  /** 写入默认模型（RuntimeConfigPort 单写通道，落盘完成即返回；同步观测缓存）。 */
  async set(model: string): Promise<void> {
    this.cached = model;
    await this.runtimeConfig.set(DefaultModelStore.KEY, model);
  }
}
