/**
 * app 路由层（F(2.1).4；CL-2）：工作台 ↔ P-4 独立 URL。
 *
 * 机制：History API（pushState + popstate）；工作台常驻 DOM（display 切换
 * 保状态——活跃会话/输入/滚动位/WS 连接均不重建；SessionProvider 在路由层
 * 之上，路由切换零 WS 影响）。P-4 页面本体归 T3.3，本层只提供路由位。
 */

/** 工作台（默认路由）。 */
export const ROUTE_WORKBENCH = "/";
/** P-4 模型与厂商配置（独立 URL；T3.3 页面本体挂载点）。 */
export const ROUTE_SETTINGS_MODELS = "/settings/models";

export type AppRoute = typeof ROUTE_WORKBENCH | typeof ROUTE_SETTINGS_MODELS;

/** pathname → 路由（未知路径回落工作台——M3 仅两路由位）。 */
export function routeOfPath(pathname: string): AppRoute {
  return pathname === ROUTE_SETTINGS_MODELS ? ROUTE_SETTINGS_MODELS : ROUTE_WORKBENCH;
}
