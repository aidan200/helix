/**
 * 网络重试状态卡（P2 ⑦ 网络重试批，用户明确要求的全局可见反馈）：
 * engine.retrying 帧 → 聊天流内联等待卡「网络重试中（第 N/3 次，约 Xs 后）」。
 *
 * - 数据源：session state.engineRetrying（瞬态——主线 delta 到达即清、
 *   最终失败换 EngineErrorCard、turn 终制/agent idle 收口，不落盘）；
 * - 重试本体在 daemon 引擎层（退避 10/30/60s×3，主会话与 SubAgent 同源）；
 *   本卡只解决「等待期无反馈 = 看似卡死」的体验问题；
 * - 正文 = provider 原文透传（领域数据不 i18n，与 EngineErrorCard 同口径）；
 * - 视觉：warning 色系（等待态非终错），结构复用 engine-error-card 模式。
 */
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

const NetworkRetryCard = function NetworkRetryCard() {
  const { t } = useI18n();
  const { state } = useSession();
  if (state.engineRetrying === null) return null;
  const r = state.engineRetrying;
  return (
    <div className="msg network-retry-card" role="status">
      <div className="nr-head">
        <span className="nr-dot" aria-hidden />
        {t("chat.engineRetry.title", {
          n: r.attempt,
          total: r.totalAttempts,
          secs: Math.max(1, Math.round(r.waitMs / 1000)),
        })}
      </div>
      <div className="nr-body">{r.message}</div>
    </div>
  );
};

export default NetworkRetryCard;
