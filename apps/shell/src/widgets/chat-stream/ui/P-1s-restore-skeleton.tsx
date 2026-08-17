/**
 * P-1s 切换两阶段 loading 骨架（F(1.2).3；CL-1）：与最终布局同构（用户气泡
 * 骨架右对齐窄条 / 助手带头像方块 / 工具卡宽度条 / 文字行——无通用
 * spinner）+ 顶部状态行（cyan 脉冲点）。
 *
 * 挂载于 .msg-flow 内（ConnOverlay 同位）；可见性 CSS 门控：
 * .app[data-view="loading"][data-conn="connected"]（切换恢复期；首连
 * connecting 期归 ConnOverlay，互斥不叠加）。
 */
import { useI18n } from "@/shared/i18n";

/** 尾窗口径展示值（G-1 对齐 daemon 默认 30；状态行文案参数）。 */
const TAIL_WINDOW = 30;

const RestoreSkeleton = function RestoreSkeleton() {
  const { t } = useI18n();
  return (
    <div className="restore-skeleton" data-restore-skeleton aria-hidden="true">
      <div className="rs-status">
        <span className="hud-dot hud-dot-cyan hud-dot-pulse" />
        <span>{t("chat.paging.status", { n: TAIL_WINDOW })}</span>
      </div>
      <div className="skel-col">
        <div className="skel-row user">
          <div className="skel skel-av violet" />
          <div className="skel-stack">
            <div className="skel" style={{ width: "64px", height: "10px" }} />
            <div className="skel bubble-user" style={{ width: "58%", height: "34px" }} />
          </div>
        </div>
        <div className="skel-row">
          <div className="skel skel-av cyan" />
          <div className="skel-stack">
            <div className="skel" style={{ width: "110px", height: "10px" }} />
            <div className="skel" style={{ width: "100%", height: "30px", borderRadius: "8px" }} />
            <div className="skel" style={{ width: "100%", height: "46px", borderRadius: "8px" }} />
            <div className="skel" style={{ width: "62%", height: "30px", borderRadius: "8px" }} />
          </div>
        </div>
        <div className="skel" style={{ width: "46%", height: "10px" }} />
        <div className="skel" style={{ width: "30%", height: "10px" }} />
      </div>
    </div>
  );
};

export default RestoreSkeleton;
