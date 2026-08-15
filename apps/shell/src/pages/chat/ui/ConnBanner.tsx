/**
 * 连接横幅（F(7).4）：disconnected = error 色「连接中断 · 自动重连中 · 第 n
 * 次尝试」；connecting = warning 色「正在重新连接 daemon · 地址」。显示由
 * .app[data-conn] CSS 门控（四态互斥，切换即清旧表象）。
 */
import { useI18n } from "@/shared/i18n";
import { WS_ADDR } from "@/shared/config/env";
import { useSession } from "@/entities/session/SessionContext";

const ConnBanner = function ConnBanner() {
  const { t } = useI18n();
  const { state } = useSession();
  const isDisconnected = state.conn === "disconnected";

  return (
    <div className="conn-banner" role="status">
      <span className="hud-dot hud-dot-pulse" />
      <span>
        {isDisconnected
          ? t("chat.banner.reconnecting")
          : t("chat.banner.reconnectingAddr")}
      </span>
      <span className="retry-n">
        {isDisconnected
          ? t("chat.banner.reconnectAttempt", { n: state.connAttempts })
          : WS_ADDR}
      </span>
    </div>
  );
};

export default ConnBanner;
