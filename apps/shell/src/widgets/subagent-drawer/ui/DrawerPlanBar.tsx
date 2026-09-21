/**
 * SubAgent 抽屉台账条（SubAgent 抽屉 plan 面）——实例工作台账在抽屉内的
 * 观察面（= 实例执行问责面）。
 *
 * 与主会话 WorkLedgerBar 同构（数据流同源 session.plan.changed，本面读
 * state.instancePlans[instanceId] 分片；快照 instances[].plan 种子原位恢复），
 * 布局适配抽屉窄列（用户点名「布局要考虑」）：
 * - 位置：任务段与 channel 之间常驻条（抽屉上部；channel 是主内容不挤压）；
 * - 收起态（缺省）→ 一行摘要（图标 + n/m + 进行中项名 + 箭头），高度恒定
 *   一行——不与任务段/channel 抢纵向空间；
 * - 展开态 → 清单浮窗 absolute 锚摘要条下沿（覆盖 channel 不推挤布局，
 *   wl-items 浮窗同纪律），max-height 40vh 内部滚动（台账行多时不吞抽屉）；
 * - 无分片（实例未建 plan / 旧 daemon）→ 整条隐藏（不占位不虚构 0/0——
 *   「无台账如实呈现」同规）。
 * 展开态为组件本地 UI 态（帧不驱动，关抽屉/切实例回收起——WorkLedgerBar
 * 同性质）。状态点配色四态与 wl-pi 同语言（done/in_progress/pending/
 * abandoned 灰显带理由 note）。
 */
import { useState } from "react";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { useSession } from "@/entities/session/SessionContext";

interface DrawerPlanBarProps {
  /** 台账归属实例（= 当前展开实例） */
  instanceId: string;
}

const DrawerPlanBar = function DrawerPlanBar({ instanceId }: DrawerPlanBarProps) {
  const { t } = useI18n();
  const { state } = useSession();
  const [open, setOpen] = useState(false);
  const proj = state.instancePlans[instanceId];
  // 无台账分片 → 整条隐藏（实例未建 plan / 旧 daemon 无字段）
  if (proj === undefined) return null;
  const doing = proj.plan.find((w) => w.status === "in_progress");
  return (
    <div className="dpb" data-dpb data-plan-open={open ? "on" : "off"}>
      <button
        type="button"
        className="dpb-summary"
        data-dpb-toggle
        title={open ? t("chat.planbar.open") : t("chat.planbar.closed")}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dpb-ic" aria-hidden="true">
          ▦
        </span>
        <span className="dpb-count" data-dpb-count>
          {t("chat.planbar.doneCount", { done: proj.ledger.done, total: proj.ledger.total })}
        </span>
        {doing !== undefined && (
          <span className="dpb-doing" data-dpb-doing>
            <span className="ing">{t("chat.planbar.doing")}</span>
            {doing.content}
          </span>
        )}
        <span className="dpb-arrow" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="dpb-items" data-dpb-items>
          {proj.plan.map((w) => (
            <div key={w.seq} className={cn("dpb-pi", w.status)} data-dpb-work={w.status}>
              <span className="dpb-pi-dot" aria-hidden="true" />
              <span className="dpb-pi-c">{w.content}</span>
              {w.note !== null && (
                <span className="dpb-pi-n" data-dpb-note>
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

export default DrawerPlanBar;
