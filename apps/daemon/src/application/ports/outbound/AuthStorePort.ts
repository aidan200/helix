/**
 * auth.json 访问出站端口（outbound，TR-AD-2）。实现体 = infrastructure/
 * auth-store.ts（~/.helix/auth.json，Credential 联合 + 0600 + 文件锁 +
 * daemon 单写点；类型镜像不 import infrastructure——port 铁律 AG-01）。
 */
export interface AuthStorePort {
  /** 单 provider 凭据状态（configured = 已录入可用 API key）。 */
  statusOf(providerId: string): { configured: boolean; keyMasked?: string };
  /** 写入 API key（空值拒绝；保留既有 env 位）。 */
  setKey(providerId: string, apiKey: string): Promise<{ keyMasked: string }>;
  /** 移除凭据（幂等）。 */
  deleteKey(providerId: string): Promise<void>;
  /** 当前 key（engine getApiKey 数据源；OAuth/缺 key → undefined）。 */
  apiKeyOf(providerId: string): string | undefined;
  /** 全部 key 快照（SubAgent 子进程 env 注入源，显式传值）。 */
  apiKeysSnapshot(): Record<string, string>;
}
