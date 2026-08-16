/**
 * SessionTopologyProbe —— store 拓扑最小验证入口（T3.1；isDev 门控，prod 零渲染）。
 *
 * T3.1 只做 store/dispatcher 层：P-2 侧栏 UI 归 T3.2。本组件提供 F 层剧本
 * 的最小断言/驱动面（data 属性全量暴露拓扑态；后台会话行 = 切换入口）：
 * - data-active-session / data-view：活跃会话与两阶段（loading ↔ ready）；
 * - data-history：向上分页状态（more | loading | exhausted）；
 * - 后台会话行（button data-bg-session）：data-run-state / data-unread /
 *   data-title——点击 = switchSession（真实 unsubscribe+subscribe+重建链）。
 * 无产品文案（AG-16）；数据属性驱动（F 层断言面）。
 */
import { useSession } from "@/entities/session/SessionContext";
import { isDev } from "@/shared/config/env";

const SessionTopologyProbe = function SessionTopologyProbe() {
  const { topology, switchSession } = useSession();
  if (!isDev()) return null;
  const { active, background, list } = topology;
  const historyAttr = !active.history.hasMore
    ? "exhausted"
    : active.history.loading
      ? "loading"
      : "more";
  return (
    <nav
      aria-label="session topology probe"
      data-topology=""
      data-active-session={active.sessionId ?? ""}
      data-view={active.view}
      data-history={historyAttr}
      data-list-count={list.length}
      style={{ position: "fixed", left: 8, bottom: 8, zIndex: 60, display: "grid", gap: 4 }}
    >
      {Object.values(background).map((bg) => (
        <button
          key={bg.sessionId}
          type="button"
          data-bg-session={bg.sessionId}
          data-run-state={bg.runState}
          data-unread={bg.unread}
          data-title={bg.title}
          onClick={() => switchSession(bg.sessionId)}
        >
          {bg.sessionId}
        </button>
      ))}
    </nav>
  );
};

export default SessionTopologyProbe;
