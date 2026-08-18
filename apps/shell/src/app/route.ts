/**
 * app 路由层（F(4.4).2；CL-4，Q-4b）：六页签独立 URL。
 *
 * 机制：History API（pushState + popstate）；工作台常驻 DOM（display 切换
 * 保状态——活跃会话/输入/滚动位/WS 连接均不重建；SessionProvider 在路由层
 * 之上，路由切换零 WS 影响）。models 页自 /settings/models 迁移到 /models
 * （单仓同发不保旧路径兼容——旧路径按未知路径回落工作台）。
 */

/** 工作台 chat（默认路由）。 */
export const ROUTE_WORKBENCH = "/";
/** 模型与厂商配置（自 /settings/models 迁移；页面本体 = M3 P-4 能力迁入）。 */
export const ROUTE_MODELS = "/models";
/** 技能（占位页：施工牌）。 */
export const ROUTE_SKILLS = "/skills";
/** 追踪（占位页：施工牌）。 */
export const ROUTE_TRACE = "/trace";
/** 项目（占位页：施工牌）。 */
export const ROUTE_PROJECT = "/project";
/** 设置（占位页：施工牌）。 */
export const ROUTE_SETTINGS = "/settings";

export type AppRoute =
  | typeof ROUTE_WORKBENCH
  | typeof ROUTE_MODELS
  | typeof ROUTE_SKILLS
  | typeof ROUTE_TRACE
  | typeof ROUTE_PROJECT
  | typeof ROUTE_SETTINGS;

/** pathname → 路由（未知路径——含旧 /settings/models——回落工作台，F-9 既有语义）。 */
export function routeOfPath(pathname: string): AppRoute {
  switch (pathname) {
    case ROUTE_MODELS:
      return ROUTE_MODELS;
    case ROUTE_SKILLS:
      return ROUTE_SKILLS;
    case ROUTE_TRACE:
      return ROUTE_TRACE;
    case ROUTE_PROJECT:
      return ROUTE_PROJECT;
    case ROUTE_SETTINGS:
      return ROUTE_SETTINGS;
    default:
      return ROUTE_WORKBENCH;
  }
}
