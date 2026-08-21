/**
 * app 入口组装（FSD 顶层）：providers（主题/i18n/Toast/会话）× 应用壳
 * （IconRail 常驻导航 + 页面域六路由位）。
 *
 * 会话连接在 SessionProvider 挂载时自动启动（连接状态机见 shared/api）；
 * 路由层在 Provider 之内——工作台常驻 DOM（display 切换保状态，F(4.4).2），
 * 路由切换不重建 WS/不丢活跃会话与输入。IconRail 为页面域纯展示组件
 * （不读会话 store，TR-AD-8 页面域/会话域分离）；models 实页自
 * /settings/models 迁移（Q-4b），skills 位已升格为智能体页（M6 T4，路由
 * /skills 不动），trace 实页，project/settings 为施工牌占位页（AD-1）。
 */
import { Activity, Cpu, FolderKanban, Layers, MessageSquare, Settings } from "lucide-react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import { SessionProvider } from "@/entities/session/SessionContext";
import ChatPage from "@/pages/chat/ChatPage";
import P4ModelsConfig from "@/pages/models/P-4-models-config";
import AgentPage from "@/pages/skills/AgentPage";
import TracePage from "@/pages/trace/TracePage";
import ProjectPage from "@/pages/project/ProjectPage";
import SettingsPage from "@/pages/settings/SettingsPage";
import IconRail, { type IconRailItem } from "@/widgets/nav-rail/ui/IconRail";
import {
  ROUTE_MODELS,
  ROUTE_PROJECT,
  ROUTE_SETTINGS,
  ROUTE_SKILLS,
  ROUTE_TRACE,
  ROUTE_WORKBENCH,
  type AppRoute,
} from "./route";
import { useAppRoute } from "./useAppRoute";

/** IconRail 六导航位（序 = review.md §6 R-P4-1；chat/models 实页，其余占位）。 */
const RAIL_ITEMS: readonly IconRailItem<AppRoute>[] = [
  { id: "chat", route: ROUTE_WORKBENCH, labelKey: "chat.nav.pages.chat.label", icon: MessageSquare },
  { id: "models", route: ROUTE_MODELS, labelKey: "chat.nav.pages.models.label", icon: Cpu },
  { id: "skills", route: ROUTE_SKILLS, labelKey: "chat.nav.pages.skills.label", icon: Layers },
  { id: "trace", route: ROUTE_TRACE, labelKey: "chat.nav.pages.trace.label", icon: Activity },
  { id: "project", route: ROUTE_PROJECT, labelKey: "chat.nav.pages.project.label", icon: FolderKanban },
  { id: "settings", route: ROUTE_SETTINGS, labelKey: "chat.nav.pages.settings.label", icon: Settings },
];

function AppRoutes() {
  const { route, navigate } = useAppRoute();
  const onWorkbench = route === ROUTE_WORKBENCH;
  return (
    <div className="app-shell">
      <IconRail items={RAIL_ITEMS} active={route} onNavigate={navigate} />
      <div className="page-area">
        {/* 工作台常驻 DOM：非工作台路由 display:none（状态/WS 全保留） */}
        <div className="route-layer" data-route={onWorkbench ? "on" : "off"}>
          <ChatPage onOpenSettings={() => navigate(ROUTE_MODELS)} />
        </div>
        {route === ROUTE_MODELS && (
          <P4ModelsConfig onBack={() => navigate(ROUTE_WORKBENCH)} />
        )}
        {route === ROUTE_SKILLS && <AgentPage path={ROUTE_SKILLS} />}
        {route === ROUTE_TRACE && <TracePage path={ROUTE_TRACE} />}
        {route === ROUTE_PROJECT && <ProjectPage path={ROUTE_PROJECT} />}
        {route === ROUTE_SETTINGS && <SettingsPage path={ROUTE_SETTINGS} />}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <SessionProvider>
            <AppRoutes />
          </SessionProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
