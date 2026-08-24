/**
 * 通用运行时配置 KV 出站端口（outbound，P1 T1）。实现体 = driven
 * sqlite-session/RuntimeConfigStore.ts（runtime_config KV 表，写经
 * WriteQueue 单写通道 AG-06）。决策 D1/D2：独占单行表改通用 KV 结构表，
 * port 层一步到位抽通用键值面——DefaultModel 语义成为 KV 上第一个键的
 * 包装（DefaultModelPort），后续 last_mode 等运行时键位复用本 port。
 */
export interface RuntimeConfigPort {
  /** KV 原值（键未设置 → undefined）。 */
  get(key: string): string | undefined;
  /** 写入键值（单写通道，落盘完成即返回；upsert 语义——同键覆盖）。 */
  set(key: string, value: string): Promise<void>;
}
