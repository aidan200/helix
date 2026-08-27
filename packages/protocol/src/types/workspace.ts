/**
 * workspace 族共享 DTO（W1 workspace 绑定闭环）。
 *
 * 契约权威源 = 设计稿 `helix/docs/temp/workspace-feature-design-candidate.md`
 * §3.1（workspace.get / workspace.open / workspace_changed 三面）。本文件是
 * 该契约的协议类型落位（AD-8/AG-13：两端同源，仓内不得平行手写）。
 *
 * 批次：v0.11 后 additive 微批（版本位不 bump，§19/§20 同构先例）。
 */

/** 最近使用工作空间行（workspace.get 响应 recents；MRU 序，上限 8）。 */
export interface WorkspaceRecent {
  /** 绑定根（realpath 规范形）。 */
  root: string;
  /** 显示名（basename）。 */
  name: string;
  /** 上次使用时间（ISO）。 */
  lastUsedAt: string;
  /** get 时惰性探测存在性（daemon 单点校验 §3.3；失效项不自动删除，前端置灰）。 */
  valid: boolean;
}
