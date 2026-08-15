/**
 * 连接中覆盖层（F(7).4）：connecting 时消息流半透明覆盖（void/0.72 + blur）+
 * spinner + 地址文案；投影不清空（覆盖层浮于投影之上，恢复由 daemon 驱动）。
 * 显示由 .app[data-conn="connecting"] CSS 门控。
 */
import { useI18n } from "@/shared/i18n";
import { WS_ADDR } from "@/shared/config/env";

const ConnOverlay = function ConnOverlay() {
  const { t } = useI18n();
  return (
    <div className="conn-overlay" role="status">
      <div className="conn-spinner" />
      <div className="t1">{t("chat.overlay.connecting")}</div>
      <div className="t2">{t("chat.overlay.addr", { addr: WS_ADDR })}</div>
    </div>
  );
};

export default ConnOverlay;
