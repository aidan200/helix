/**
 * 工作台账条（main-session plan 批；chat 页主区 conn-banner 之下、消息流
 * 之上常驻条）——主会话 plan 三工具台账的观察面（= MainAgent 执行问责面）。
 *
 * 三态：
 * - 无台账（state.plan === null）→ 整条隐藏（不占位、不虚构 0/0——tasks 页
 *   「无台账如实呈现」同规的 chat 域形态：无条即无台账）；
 * - 收起态（缺省）→ 一行摘要：图标 + n/m 项完成（ledger 服务端计数，前端
 *   零拼装）+ 进行中项名 + 展开箭头；
 * - 展开态 → 条目清单浮窗（absolute 锚摘要条下沿、popover-fill 实底
 *   覆盖消息流，不挤压主窗口——摘要条常驻位不动；CSS 域 wl-items 见
 *   app.css）：状态点配色与 tasks 页批次 plan 同构（done=success /
 *   in_progress=accent 高亮 / pending=faint / abandoned=warning 灰显带理由
 *   note）、内容、note 摘要右对齐。
 *
 * 数据流：WS session.plan.changed → session model state.plan/ledger
 * （consumers/plan）；快照 plan/ledger 字段为恢复种子（consumers/snapshot）。
 * 展开态为组件本地 UI 态（帧不驱动，重连后回收起——与 tasks 页 planOpen
 * 页内态同性质）。
 */
import { useState } from "react";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { useSession } from "@/entities/session/SessionContext";

const WorkLedgerBar = function WorkLedgerBar() {
  const { t } = useI18n();
  const { state } = useSession();
  const [open, setOpen] = useState(false);
  const plan = state.plan;
  const ledger = state.ledger;
  // 无台账（plan 双 null）→ 整条隐藏
  if (plan === null || ledger === null) return null;
  const doing = plan.find((w) => w.status === "in_progress");
  return (
    <div className="wl-bar" data-wl-bar data-plan-open={open ? "on" : "off"}>
      <button
        type="button"
        className="wl-summary"
        data-wl-toggle
        title={open ? t("chat.planbar.open") : t("chat.planbar.closed")}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="wl-ic" aria-hidden="true">
          ▦
        </span>
        <span className="wl-count" data-wl-count>
          {t("chat.planbar.doneCount", { done: ledger.done, total: ledger.total })}
        </span>
        {doing !== undefined && (
          <span className="wl-doing" data-wl-doing>
            <span className="ing">{t("chat.planbar.doing")}</span>
            {doing.content}
          </span>
        )}
        <span className="wl-arrow" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="wl-items" data-wl-items>
          {plan.map((w) => (
            <div key={w.seq} className={cn("wl-pi", w.status)} data-wl-work={w.status}>
              <span className="wl-pi-dot" aria-hidden="true" />
              <span className="wl-pi-c">{w.content}</span>
              {w.note !== null && (
                <span className="wl-pi-n" data-wl-note>
                  {w.note}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default WorkLedgerBar;
