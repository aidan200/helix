/**
 * ConfirmStack —— 左下角全局确认卡栈（B1 管家文本链路批；设计稿
 * docs/temp/helix-steward-global-redesign.md §1 布局图 / §3.4）。
 *
 * 形态（E-135 浮层三分法第 1 档：真全屏语义——fixed 视口层，AppRoutes
 * 独立挂载，路由切换/面板开合不卸载；视觉 stats-pop 玻璃族）：
 * - 多卡竖排**新卡在上**；卡片到手即编号 #N（seq 单调，永不重排）；
 * - 超 5 张折叠「还有 N 张」抽屉行（点击展开全部）；
 * - 三态：awaiting（确认/放弃）→ accepted（受理中，按钮禁用——防双击）
 *   → done（steward.action.completed 到达，opacity 淡出后由数据面移除）；
 * - 动效仅 transform/opacity（E-124 WKWebView 纪律；reduced-motion 直切）。
 *
 * 数据面 useStewardActions（单实例挂载于此）——确认卡从 StewardPanel 移出
 * 后的全局承载：无光球/纯文本期卡栈照常出现在左下角，关面板只影响语音。
 */
import { useState } from "react";
import { Brain } from "lucide-react";
import { useStewardActions, STEWARD_CARD_COLLAPSE_AT } from "../model/useStewardActions";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";

/** 记忆通知卡文本上限（超长截「…」——用户规约：卡片内容限 100 字内）。 */
const MEMORY_CARD_TEXT_MAX = 100;

/**
 * 按**码点**截断（旧 slice(0,100) 是 UTF-16 码元口径：代理对/扩展字形被从
 * 中间切开 → 显示残缺字符或半个 emoji）。用 Array.from 按码点切，再拼接。
 */
function truncateMemoryText(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= MEMORY_CARD_TEXT_MAX) return text;
  return `${codePoints.slice(0, MEMORY_CARD_TEXT_MAX).join("")}…`;
}

const ConfirmStack = function ConfirmStack() {
  const { t } = useI18n();
  const { cards, confirmCard, cancelCard } = useStewardActions();
  const [expanded, setExpanded] = useState(false);
  if (cards.length === 0) return null;
  // 新卡在上（渲染序 = 数组逆序）；折叠态只显示最新 N 张
  const ordered = [...cards].reverse();
  const hidden = expanded ? 0 : Math.max(0, ordered.length - STEWARD_CARD_COLLAPSE_AT);
  const visible = expanded ? ordered : ordered.slice(0, STEWARD_CARD_COLLAPSE_AT);
  return (
    <div className="stf-stack" data-testid="steward-confirm-stack" role="region" aria-label={t("steward.confirmTitle")}>
      {visible.map((card) =>
        card.kind === "memory" ? (
          // 记忆落盘通知卡（B5 静默化）：无操作面——大脑图标左上，新增主题色/
          // 更新警告色（色阶挂 memoryMode 类），展示后自动收场（数据面定时）
          <div
            key={card.actionId}
            className={cn("stf-card", "stf-memory", card.memoryMode ?? "added")}
            data-testid="steward-memory-card"
            data-memory-mode={card.memoryMode ?? "added"}
          >
            <div className="stf-head">
              <Brain className="stf-memory-icon" size={14} aria-hidden />
              <span className="stf-title">
                {card.memoryMode === "updated" ? t("steward.memoryUpdated") : t("steward.memoryAdded")}
              </span>
            </div>
            <div className="stf-row stf-body">
              <span className="stf-v">{truncateMemoryText(card.message)}</span>
            </div>
          </div>
        ) : (
        <div
          key={card.actionId}
          className={cn("stf-card", card.state)}
          data-testid="steward-confirm-card"
          data-action-id={card.actionId}
          data-state={card.state}
        >
          <div className="stf-head">
            <span className="stf-seq" data-testid="steward-card-seq">#{card.seq}</span>
            <span className="stf-title">{t("steward.confirmTitle")}</span>
            {card.state === "accepted" && <span className="stf-phase">{t("steward.cardAccepted")}</span>}
            {card.state === "done" && <span className="stf-phase">{t("steward.cardDone")}</span>}
          </div>
          <div className="stf-row">
            <span className="stf-k">{t("steward.confirmTarget")}</span>
            <span className="stf-v">{card.agentId}</span>
          </div>
          <div className="stf-row stf-body">
            <span className="stf-k">{t("steward.confirmBody")}</span>
            <span className="stf-v">{card.message}</span>
          </div>
          {card.state === "awaiting" ? (
            <div className="stf-actions">
              <button
                type="button"
                className="stf-yes"
                data-testid="steward-card-confirm"
                onClick={() => confirmCard(card.actionId)}
              >
                {t("steward.confirmYes")}
              </button>
              <button
                type="button"
                className="stf-no"
                data-testid="steward-card-cancel"
                onClick={() => cancelCard(card.actionId)}
              >
                {t("steward.confirmNo")}
              </button>
            </div>
          ) : (
            // accepted/done 态：禁用钮防双击（数据面双闸之外的视觉第三闸）
            <div className="stf-actions">
              <button type="button" className="stf-yes" data-testid="steward-card-confirm" disabled>
                {t("steward.confirmYes")}
              </button>
              <button type="button" className="stf-no" data-testid="steward-card-cancel" disabled>
                {t("steward.confirmNo")}
              </button>
            </div>
          )}
        </div>
        ),
      )}
      {hidden > 0 && (
        <button
          type="button"
          className="stf-more"
          data-testid="steward-card-more"
          onClick={() => setExpanded(true)}
        >
          {t("steward.cardMore", { n: hidden })}
        </button>
      )}
    </div>
  );
};

export default ConfirmStack;
