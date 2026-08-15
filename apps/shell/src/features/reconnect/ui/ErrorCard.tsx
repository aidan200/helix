/**
 * 连接失败卡（F(7).4 error 态）：! 图标 + 真实连接错误信息（重试次数 +
 * ws 地址）+「重试连接」→ connecting → connected（SM-2 手动重试路径）。
 */
import { useI18n } from "@/shared/i18n";
import { WS_ADDR } from "@/shared/config/env";
import { useSession } from "@/entities/session/SessionContext";

const ErrorCard = function ErrorCard() {
  const { t } = useI18n();
  const { state, retry } = useSession();
  const attempts = state.connError?.attempts ?? state.connAttempts;

  return (
    <div className="session-error">
      <div className="err-card">
        <div className="err-icon">!</div>
        <div className="err-title">{t("chat.error.title")}</div>
        <div className="err-desc">
          {t("chat.error.desc", { n: attempts })}
          <br />
          <span className="addr">
            {[state.connError?.message, WS_ADDR].filter(Boolean).join(" · ")}
          </span>
        </div>
        <button className="hud-btn hud-btn-cyan" id="btn-retry" type="button" onClick={retry}>
          {t("chat.error.retry")}
        </button>
      </div>
    </div>
  );
};

export default ErrorCard;
