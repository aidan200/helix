/**
 * app 入口组装（FSD 顶层）：providers（主题/i18n/Toast/会话/workspace
 * 门禁）× 门禁分支（W3：phase !== main 全屏占位，主壳不渲染即无
 * kg/session 消费者——结构保证 gate 态零越权请求）× 应用壳
 * （IconRail 常驻导航 + 页面域五路由位）。
 *
 * 会话连接在 SessionProvider 挂载时自动启动（连接状态机见 shared/api）；
 * workspace 门禁（W3）在 SessionProvider 之内、主壳之外：连接就绪自动
 * workspace.get → bound（phase=main）渲染主壳（零改动）/ null（gate）
 * 渲染选择页 / 判定前（connecting）终端风连接屏（W6b：与静态启动屏
 * 同类族；W6o 升格双形态开场：首启 hold 显完整 16 行序列，重连 status
 * 形态）——门禁是前端状态，
 * 不是壳职责（TR-AD-4）。路由层在 Provider 之内——工作台常驻 DOM
 * （display 切换保状态，F(4.4).2），路由切换不重建 WS/不丢活跃会话与输入。
 * IconRail 为页面域纯展示组件（不读会话 store，TR-AD-8 页面域/会话域
 * 分离；主题态由本层 useTheme 注入，S1）；S2：models 独立页退役（模型
 * 配置迁入设置页分区，导航位五位）；skills 位已升格为智能体页（M6 T4，
 * 路由 /skills 不动），trace 实页，project 为 P-1 单页 master-detail 实页
 * （V-3：项目域+知识图谱查看）。scanline 氛围层全局单份（S1 上提）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, FolderKanban, Layers, ListTodo, MessageSquare, Settings } from "lucide-react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import { SessionProvider } from "@/entities/session/SessionContext";
import { useSession } from "@/entities/session/SessionContext";
import { WorkspaceProvider, useWorkspace } from "@/entities/workspace/WorkspaceContext";
import ChatPage from "@/pages/chat/ChatPage";
import AgentPage from "@/pages/skills/AgentPage";
import TracePage from "@/pages/trace/TracePage";
import ProjectPage from "@/pages/P-1/ProjectPage";
import TasksPage from "@/pages/tasks/ui/TasksPage";
import SettingsPage from "@/pages/settings/SettingsPage";
import WorkspaceGatePage from "@/pages/workspace/WorkspaceGatePage";
import WorkspaceBootScreen from "@/pages/workspace/WorkspaceBootScreen";
import IconRail, { type IconRailItem } from "@/widgets/nav-rail/ui/IconRail";
import { useTheme } from "@/shared/ui/theme";
import {
  ROUTE_PROJECT,
  ROUTE_SETTINGS,
  ROUTE_SKILLS,
  ROUTE_TASKS,
  ROUTE_TRACE,
  ROUTE_WORKBENCH,
  type AppRoute,
} from "./route";
import { useAppRoute } from "./useAppRoute";
import TaskSyncHintToast from "./TaskSyncHintToast";

/** IconRail 六导航位（序沿 review.md §6 R-P4-1 去 models 位；S2：模型配置归设置页；T3.1：任务位入列）。 */
const RAIL_ITEMS: readonly IconRailItem<AppRoute>[] = [
  { id: "chat", route: ROUTE_WORKBENCH, labelKey: "chat.nav.pages.chat.label", icon: MessageSquare },
  { id: "skills", route: ROUTE_SKILLS, labelKey: "chat.nav.pages.skills.label", icon: Layers },
  { id: "trace", route: ROUTE_TRACE, labelKey: "chat.nav.pages.trace.label", icon: Activity },
  { id: "project", route: ROUTE_PROJECT, labelKey: "chat.nav.pages.project.label", icon: FolderKanban },
  { id: "tasks", route: ROUTE_TASKS, labelKey: "chat.nav.pages.tasks.label", icon: ListTodo },
  { id: "settings", route: ROUTE_SETTINGS, labelKey: "chat.nav.pages.settings.label", icon: Settings },
];

function AppRoutes() {
  const { route, navigate } = useAppRoute();
  const { theme, setTheme } = useTheme();
  // 页内指路出口（T3.1/T3.2）：P-2 任务页 → /project；P-1 bootstrap 入口卡与
  // 产出分组 → /tasks（页面间闭环流转，review.md §页面间闭环）
  const goProject = useCallback(() => navigate(ROUTE_PROJECT), [navigate]);
  const goTasks = useCallback(() => navigate(ROUTE_TASKS), [navigate]);
  // T4 web 族（契约 v0.7）：联网状态读面（topology.webStatus，拓扑级消费）
  // + 停止写面（web.stop 命令帧）→ IconRail props 注入（IconRail 纯展示）；
  // T7 显式启动写面（web.start，v0.9）同链注入
  const { topology, sendWebStop, sendWebStart } = useSession();
  const onWorkbench = route === ROUTE_WORKBENCH;
  return (
    <>
      <div className="app-shell">
        <IconRail
          items={RAIL_ITEMS}
          active={route}
          onNavigate={navigate}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
          webStatus={topology.webStatus}
          onStopWeb={sendWebStop}
          onStartWeb={sendWebStart}
        />
        <div className="page-area">
          {/* 工作台常驻 DOM：非工作台路由 display:none（状态/WS 全保留） */}
          <div className="route-layer" data-route={onWorkbench ? "on" : "off"}>
            <ChatPage />
          </div>
          {route === ROUTE_SKILLS && <AgentPage path={ROUTE_SKILLS} />}
          {route === ROUTE_TRACE && <TracePage path={ROUTE_TRACE} />}
          {route === ROUTE_PROJECT && <ProjectPage path={ROUTE_PROJECT} onOpenTasks={goTasks} />}
          {route === ROUTE_TASKS && <TasksPage path={ROUTE_TASKS} onOpenProject={goProject} />}
          {route === ROUTE_SETTINGS && <SettingsPage path={ROUTE_SETTINGS} />}
        </div>
      </div>
      {/* 产品氛围层（S1 上提全局单份：fixed + pointer-events:none；各页历史副本已随 AppLayout 迁移全数清理） */}
      <div className="scanline-overlay" aria-hidden="true" />
      {/* W2-D kg sync 提示全局 toast（task.changed 随行 syncHint 直渲；页面无关常驻） */}
      <TaskSyncHintToast />
    </>
  );
}

/**
 * 门禁组装（W3；设计稿 §2.1）：依赖注入点——从 SessionContext 提取连接就绪
 * 与 workspace 命令/帧订阅面注入 WorkspaceProvider（AG-15 entities 跨 slice
 * 零互引，app 层组装；SessionProvider TransportFactory 注入同构）。
 */
function WorkspaceGate() {
  const { state, sendWorkspaceGet, sendWorkspaceOpen, subscribeWorkspaceFrames } = useSession();
  const connected = state.conn === "connected";
  const deps = useMemo(
    () => ({ connected, sendGet: sendWorkspaceGet, sendOpen: sendWorkspaceOpen, subscribe: subscribeWorkspaceFrames }),
    [connected, sendWorkspaceGet, sendWorkspaceOpen, subscribeWorkspaceFrames],
  );
  return (
    <WorkspaceProvider deps={deps}>
      <WorkspaceGateBranch />
    </WorkspaceProvider>
  );
}

/**
 * 首启 boot 序列 hold 时长（W6o）：16 行序列末行 --d 1.30s + wipe 0.14s
 * ≈ 1.44s——序列播完的兜底下限（连接就绪早于此则等待，晚于此由连接
 * 就绪条件收口）。导出供门禁 hold 测试消费（fake timers 步进基准）。
 */
export const BOOT_HOLD_MS = 900;

/**
 * 门禁分支（W3；W4 切换流复用；W6o 首启 hold）：phase=gate → 选择页
 * （首启无导航逃逸；切换流入口带取消逃逸——switching 态页面自渲染返回钮，
 * 首启语义不变）；connecting → 终端风连接屏（W6b；conn=error 时重试占位）；
 * main → 主壳（AppRoutes 零改动）。phase 由 entities/workspace 状态机驱动。
 *
 * 首启 hold（W6o）：打包形态 JS 内嵌秒载、React 立即替换静态 boot 序列
 * （来不及播），真实等待转移到 daemon 连接段——连接屏升格为完整开场动画。
 * 首启在「连接就绪（phase 离开 connecting）且序列播完（挂载起 BOOT_HOLD_MS
 * 兜底）」前恒显 boot 屏（full 形态，即使 phase 已到 gate/main——gate 选择页
 * 同受 hold，开场体验统一）；双条件齐备置 firstBootDone（ref+state：ref 供
 * effect 内同步判重，state 驱动渲染）后恒不复发——此后 phase 回 connecting
 * （重连）→ status 形态直显（无 hold，中途断连不重播序列防打扰）。切换流
 * 是 main 态内路由（firstBootDone 已置）不受影响。导出供门禁 hold 测试消费。
 */
export function WorkspaceGateBranch() {
  const { state } = useWorkspace();
  const [seqDone, setSeqDone] = useState(false);
  const [firstBootDone, setFirstBootDone] = useState(false);
  const firstBootRef = useRef(false);

  // 序列播完兜底：挂载起计时（非阻塞 setTimeout；卸载清理）
  useEffect(() => {
    const timer = setTimeout(() => setSeqDone(true), BOOT_HOLD_MS);
    return () => clearTimeout(timer);
  }, []);

  // 双条件齐备 → firstBootDone 恒置（不回退）
  const connected = state.phase !== "connecting";
  useEffect(() => {
    if (!firstBootRef.current && seqDone && connected) {
      firstBootRef.current = true;
      setFirstBootDone(true);
    }
  }, [seqDone, connected]);

  if (!firstBootDone) return <WorkspaceBootScreen variant="full" />;
  if (state.phase === "connecting") return <WorkspaceBootScreen variant="status" />;
  if (state.phase === "gate") return <WorkspaceGatePage />;
  return <AppRoutes />;
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <SessionProvider>
            <WorkspaceGate />
          </SessionProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
