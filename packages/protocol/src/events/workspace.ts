/**
 * workspace 族事件（W1 workspace 绑定闭环；契约 = 设计稿
 * workspace-feature-design-candidate.md §3.1）。
 *
 * 三帧分工：
 * - workspace.get.result：门禁判定读面的点对点回执（TR-AD-21 模式，仅发
 *   发起命令的连接；信封 sessionId = SYSTEM_SESSION_ID——全局命令会话无关）；
 * - workspace.open.result：绑定写面回执（点对点；payload 含新 root 的项目
 *   行——复用 kg.projects 的项目行 DTO 口径 KgProjectRow）；
 * - workspace_changed：绑定变更广播（open 成功/幂等重开均广播一次，前端
 *   各域刷新依据；信封 sessionId = SYSTEM_SESSION_ID 全连接下发，与
 *   web.status.changed 同构）。
 */
import type { EventFrame } from "../envelope";
import type { KgProjectRow } from "../types/kg";
import type { WorkspaceRecent } from "../types/workspace";

/** workspace.get.result：门禁快照（current/recents/notice）。 */
export interface WorkspaceGetResultPayload {
  /** 当前绑定（realpath 规范形）；null = 未绑定（选择页）。 */
  current: { root: string } | null;
  /** 最近使用（MRU 序，上限 8；get 时惰性探测标 valid）。 */
  recents: WorkspaceRecent[];
  /** 降级说明（恢复失败等；无降级缺席）。 */
  notice?: string;
}

/** workspace.open.result：绑定回执（projects 复用 kg.projects 项目行口径）。 */
export interface WorkspaceOpenResultPayload {
  /** 绑定后的规范形根。 */
  root: string;
  /** 新 root 一层扫描项目行（宽松口径含 absent）。 */
  projects: KgProjectRow[];
}

/** workspace_changed：绑定变更广播载荷。 */
export interface WorkspaceChangedPayload {
  /** 变更后绑定根（规范形）。 */
  root: string;
}

// ── workspace 批新增信封（channel 挂 workspace 新族）──

/** workspace.get.result：门禁读面回执（点对点；信封 sessionId = SYSTEM_SESSION_ID）。 */
export interface WorkspaceGetResultEvent extends EventFrame<WorkspaceGetResultPayload> {
  channel?: "workspace";
  type: "workspace.get.result";
}

/** workspace.open.result：绑定写面回执（点对点；全局命令）。 */
export interface WorkspaceOpenResultEvent extends EventFrame<WorkspaceOpenResultPayload> {
  channel?: "workspace";
  type: "workspace.open.result";
}

/** workspace_changed：绑定变更广播（daemon 级全局；信封 sessionId = SYSTEM_SESSION_ID）。 */
export interface WorkspaceChangedEvent extends EventFrame<WorkspaceChangedPayload> {
  channel?: "workspace";
  type: "workspace_changed";
}
