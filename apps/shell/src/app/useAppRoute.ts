/**
 * 路由订阅 hook（F(2.1).4）：pushState 导航 + popstate 回退同步。
 *
 * react-router 级路由库未引入（五路由位自持轻量层即够，Q-4b；S2）；工作台常驻
 * DOM 的显隐由 AppRoutes 按 route 切换，本 hook 只管 URL ↔ 状态同步。
 */
import { useCallback, useEffect, useState } from "react";
import { routeOfPath, type AppRoute } from "./route";

export interface AppNavigate {
  route: AppRoute;
  /** pushState 导航（同路径 no-op；不产生历史栈垃圾项） */
  navigate: (to: AppRoute) => void;
}

export function useAppRoute(): AppNavigate {
  const [route, setRoute] = useState<AppRoute>(() => routeOfPath(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(routeOfPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: AppRoute) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, "", to);
    setRoute(to);
  }, []);

  return { route, navigate };
}
