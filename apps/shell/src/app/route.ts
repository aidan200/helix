/**
 * app 路由层（F(4.4).2；CL-4，Q-4b；S2）：六路由位独立 URL。
 *
 * 机制：History API（pushState + popstate）；工作台常驻 DOM（display 切换
 * 保状态——活跃会话/输入/滚动位/WS 连接均不重建；SessionProvider 在路由层
 * 之上，路由切换零 WS 影响）。S2：models 独立页退役（模型配置迁入
 * /settings 页内分区，模型路由常量/分支/联合成员全链删除）——/models
 * 成为未知路径，与旧 /settings/models 同语义回落工作台（不保旧路径兼容）。
 */

/** 工作台 chat（默认路由）。 */
export const ROUTE_WORKBENCH = "/";
/** 技能（智能体页；M6 T4）。 */
export const ROUTE_SKILLS = "/skills";
/** 追踪（实页）。 */
export const ROUTE_TRACE = "/trace";
/** 项目（P-1 实页：master-detail，kg 查看器/项目健康）。 */
export const ROUTE_PROJECT = "/project";
/** 任务（P-2 任务页；T3.1，iter-20260829-ys7q）。 */
export const ROUTE_TASKS = "/tasks";
/** 设置（S2 实页化：AppLayout 壳 + 分区导航，模型配置为首分区）。 */
export const ROUTE_SETTINGS = "/settings";
/** 管家记忆独立页（B2-④：低频不占常驻导航——入口 = StewardPanel 记忆钮 +
 *  设置管家记忆区「管理记忆」链接）。 */
export const ROUTE_STEWARD_MEMORY = "/steward/memory";
/** 管家活动时间线页（M3-d1 感知兑现批：活动账回看/清理 + 实时条目——
 *  低频不占常驻导航，入口 = StewardPanel 头部活动钮）。 */
export const ROUTE_STEWARD_ACTIVITY = "/steward/activity";

export type AppRoute =
  | typeof ROUTE_WORKBENCH
  | typeof ROUTE_SKILLS
  | typeof ROUTE_TRACE
  | typeof ROUTE_PROJECT
  | typeof ROUTE_TASKS
  | typeof ROUTE_SETTINGS
  | typeof ROUTE_STEWARD_MEMORY
  | typeof ROUTE_STEWARD_ACTIVITY;

/** pathname → 路由（未知路径——含退役 /models 与旧 /settings/models——回落工作台，F-9 既有语义）；
 * 尾斜杠先行规范化（"/skills/" 与 "/skills" 同路由，不再静默回落工作台）。 */
export function routeOfPath(pathname: string): AppRoute {
  // 尾斜杠规范化：外部链接/手输常带尾斜杠，剥到无（"/" 剥空后走 default
  // 回落，与工作台常量语义一致不变）
  const normalized = pathname.replace(/\/+$/, "");
  switch (normalized) {
    case ROUTE_SKILLS:
      return ROUTE_SKILLS;
    case ROUTE_TRACE:
      return ROUTE_TRACE;
    case ROUTE_PROJECT:
      return ROUTE_PROJECT;
    case ROUTE_TASKS:
      return ROUTE_TASKS;
    case ROUTE_SETTINGS:
      return ROUTE_SETTINGS;
    case ROUTE_STEWARD_MEMORY:
      return ROUTE_STEWARD_MEMORY;
    case ROUTE_STEWARD_ACTIVITY:
      return ROUTE_STEWARD_ACTIVITY;
    default:
      return ROUTE_WORKBENCH;
  }
}
