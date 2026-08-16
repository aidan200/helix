/**
 * 默认模型存储出站端口（outbound，TR-AD-2）。实现体 = driven
 * sqlite-session/DefaultModelStore.ts（default_model 单行表，写经
 * WriteQueue 单写通道 AG-06）。AD-2 裁决：全局默认模型进 SQLite
 * （经常变的状态不进 JSON）。
 */
export interface DefaultModelPort {
  /** SQLite 原值（未设置 → undefined；迁移/测试用）。 */
  stored(): string | undefined;
  /** 当前生效默认（存储值 ?? builtin 兜底；永不 undefined）。 */
  current(): string;
  /** 写入默认模型（单写通道，落盘完成即返回）。 */
  set(model: string): Promise<void>;
}
