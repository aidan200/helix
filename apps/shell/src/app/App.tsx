/**
 * app 入口组装（FSD 顶层）：providers（主题/i18n/Toast/会话）× 路由层
 * （工作台 ↔ P-4）。
 *
 * 会话连接在 SessionProvider 挂载时自动启动（连接状态机见 shared/api）；
 * 路由层在 Provider 之内——工作台常驻 DOM（display 切换保状态，F(2.1).4），
 * 路由切换不重建 WS/不丢活跃会话与输入。
 */
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import { SessionProvider } from "@/entities/session/SessionContext";
import ChatPage from "@/pages/chat/ChatPage";
import P4ModelsConfig from "@/pages/settings/P-4-models-config";
import { ROUTE_SETTINGS_MODELS, ROUTE_WORKBENCH } from "./route";
import { useAppRoute } from "./useAppRoute";

function AppRoutes() {
  const { route, navigate } = useAppRoute();
  const onWorkbench = route === ROUTE_WORKBENCH;
  return (
    <>
      {/* 工作台常驻 DOM：非工作台路由 display:none（状态/WS 全保留） */}
      <div className="route-layer" data-route={onWorkbench ? "on" : "off"}>
        <ChatPage onOpenSettings={() => navigate(ROUTE_SETTINGS_MODELS)} />
      </div>
      {route === ROUTE_SETTINGS_MODELS && (
        <P4ModelsConfig onBack={() => navigate(ROUTE_WORKBENCH)} />
      )}
    </>
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
