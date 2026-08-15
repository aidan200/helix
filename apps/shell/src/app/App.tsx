/**
 * app 入口组装（FSD 顶层）：providers（主题/i18n/Toast/会话）× 页面。
 * 会话连接在 SessionProvider 挂载时自动启动（连接状态机见 shared/api）。
 */
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import { SessionProvider } from "@/entities/session/SessionContext";
import ChatPage from "@/pages/chat/ChatPage";

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <SessionProvider>
            <ChatPage />
          </SessionProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
