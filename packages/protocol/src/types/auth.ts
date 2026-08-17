/**
 * auth 管理 DTO（v0.2 新增，契约 C §1.3；G-6 定名 auth.* 命令族）。
 *
 * daemon 侧落点：~/.helix/auth.json（pi 生态 Credential 联合，0600 + 文件锁，
 * daemon 单写点，T2.3 落地）；协议侧只登记前端消费面。
 */

/** auth.list 响应的 provider 条目（P-4 设置页 key 管理列表行数据） */
export interface AuthProviderInfo {
  providerId: string;
  /** 是否已录入 key */
  configured: boolean;
  /** 掩码形式（如 `····7f3a` 尾 4 位）；未录入时缺省 */
  keyMasked?: string;
  /** 最近一次 verify 成功时间（epoch ms）；缺省 = 从未验证 */
  verifiedAt?: number;
  /** 验证状态（auth.verify 不缓存，每次真实请求；前端三态自管理） */
  verifyStatus?: "ok" | "fail" | "unverified";
}
