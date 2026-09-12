/**
 * WorktreeProvisionerPort —— U3 isolated 档的机械 worktree 供给出口。
 *
 * SubagentLauncher launch 时刻消费（isolated 实例）：探测 git 仓 → 建隔离
 * worktree → 软链 node_modules（TR-143）→ 返回 {path, branch}。toolCwd 钉
 * worktree 路径，子进程写面物理隔离于主树。
 *
 * 失败语义：非 git 仓工作目录 / git 错误 → { error }（launcher 转实例收口
 * failed，spawn 秒回语义不受影响——AD-8 异步交付，失败经 closure 可见）。
 *
 * 物理树生命周期：创建后**不自动删**——merge 归 MainAgent 检查点（工程
 * 纪律①），closure 文案携路径与清理指引；remove 供后续 GC/人工清理面。
 */
export interface WorktreeProvision {
  /** worktree 绝对路径（realpath 归一）。 */
  readonly path: string;
  /** worktree 分支名（helix/<slug> 形态）。 */
  readonly branch: string;
}

export type WorktreeProvisionResult = WorktreeProvision | { readonly error: string };

export interface WorktreeProvisionerPort {
  /** 建 worktree（slug 建议 agent 实例 id；baseCwd = 探测起点 cwd）。 */
  provision(slug: string, baseCwd: string): Promise<WorktreeProvisionResult>;
  /** 删 worktree（git worktree remove；分支保留供 merge，force 仅清树）。 */
  remove(path: string): Promise<boolean>;
}
