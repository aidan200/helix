/**
 * closure 卡（F1.6/F1.7；AD-8 结构：status/summary/reportPath/findings/taskId 五字段）。
 *
 * done = 绿边绿角标 / failed = 红边红角标（hud-corners 同签名）；徽标文案与
 * P-1 卡片同源（chat.sa.card.doneBadge/failedBadge）；findings 计数展示
 * （v2 kg 重生长接点，本迭代透传）。纯渲染，零本地态。
 */
import { memo } from "react";
import type { ClosureDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";

const ClosureCard = memo(function ClosureCard({ closure }: { closure: ClosureDto }) {
  const { t } = useI18n();
  const failed = closure.status === "failed";
  const findings = Array.isArray(closure.findings) ? closure.findings.length : null;
  return (
    <div
      className={cn("closure-card", failed && "failed")}
      data-kind="closure"
      data-status={closure.status}
    >
      <div className="cl-head">
        <span className={cn("cl-badge", failed && "bad")}>
          {failed ? t("chat.sa.card.failedBadge") : t("chat.sa.card.doneBadge")}
        </span>
        <span className="cl-t">{t("chat.drawer.closure.title")}</span>
      </div>
      <div className="cl-summary">{closure.summary}</div>
      <div className="cl-meta">
        {closure.reportPath ? (
          <span>
            <span className="k">reportPath</span> {closure.reportPath}
          </span>
        ) : null}
        {findings !== null ? (
          <span>
            <span className="k">findings</span> {findings}
          </span>
        ) : null}
        {closure.taskId ? (
          <span>
            <span className="k">taskId</span> {closure.taskId}
          </span>
        ) : null}
      </div>
    </div>
  );
});

export default ClosureCard;
