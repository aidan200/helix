/**
 * app 路由层（F(4.4).2；CL-4，Q-4b；S2）：五页签独立 URL。
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
/** 项目（占位页：施工牌）。 */
export const ROUTE_PROJECT = "/project";
/** 任务（P-2 任务页；T3.1，iter-20260829-ys7q）。 */
export const ROUTE_TASKS = "/tasks";
/** 设置（S2 实页化：AppLayout 壳 + 分区导航，模型配置为首分区）。 */
export const ROUTE_SETTINGS = "/settings";

export type AppRoute =
  | typeof ROUTE_WORKBENCH
  | typeof ROUTE_SKILLS
  | typeof ROUTE_TRACE
  | typeof ROUTE_PROJECT
  | typeof ROUTE_TASKS
  | typeof ROUTE_SETTINGS;

/** pathname → 路由（未知路径——含退役 /models 与旧 /settings/models——回落工作台，F-9 既有语义）。 */
export function routeOfPath(pathname: string): AppRoute {
  switch (pathname) {
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
    default:
      return ROUTE_WORKBENCH;
  }
}
