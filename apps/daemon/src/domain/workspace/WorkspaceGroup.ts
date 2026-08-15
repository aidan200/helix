/**
 * workspace 分组（architecture.md §3.3）：daemon 内部将会话按 workspace 归组的
 * 领域概念。本迭代仅概念模型（多窗口/workspace 路由实现留 M3+，AD-7）——
 * 协议侧只预留 WorkspaceRoute 类型字段，daemon 侧同样只有本模型，无路由行为。
 */
export interface WorkspaceGroup {
  /** workspace 标识（稳定字符串）。 */
  readonly id: string;
  /** 展示名。 */
  readonly label: string;
}

/** 主 workspace（默认分组；M3 前全部会话都归于此）。 */
export const MAIN_WORKSPACE: WorkspaceGroup = { id: "main", label: "main" };
