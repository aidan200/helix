/**
 * P-1 右侧活跃事件条（T5.5 重设计；F(2.1).1 主区构成；review.md「抽屉关闭态」）：
 * 自「SubAgent 计数器」升级为「活跃事件条」——SubAgent 是第一种事件类型
 * （类型注册表见 ../model/activity-types，结构预留未来类型，YAGNI 不实现）。
 *
 * 行为契约（task brief §4.1 用户裁决）：
 * - 活跃语义：仅 queued+running 上条（data-rail-count = 活跃数，非累计总数）；
 *   终态（done/failed/cancelled）立即离开；无活跃事件 → 条整体隐藏；
 * - 折叠态（26px 窄竖条）：每活跃事件一个类型着色标识（subagent=violet
 *   圆点），多事件纵列；点击标识 → 开该实例抽屉；
 * - 展开态（活动简介列表）：每活跃事件一行 = 类型徽标 + 名称（task 摘要）
 *   + 状态（running 带计时 / queued 带排位）；点击行 → 开该实例抽屉；
 * - 折叠/展开两态 localStorage 记忆（helix-activity-rail-collapsed，与侧栏
 *   helix-sidebar-collapsed 同模式，AG-14 白名单：纯 UI 布局偏好）；缺省折叠。
 */
import { useState } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { useRunningElapsed } from "@/shared/lib/useRunningElapsed";
import { useSession } from "@/entities/session/SessionContext";
import type { InstanceCardState } from "@/entities/session/model/session-reducer";
import { ACTIVITY_TYPES } from "../model/activity-types";

export interface DrawerRailProps {
  onOpen: (instanceId: string) => void;
}

/** 折叠记忆键（AG-14 白名单；缺省 = 折叠，显式 "0" = 展开）。 */
const RAIL_KEY = "helix-activity-rail-collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_KEY) !== "0";
  } catch {
    return true; // 无痕/受限环境：缺省折叠，记忆失效不阻断交互
  }
}

function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(RAIL_KEY, v ? "1" : "0");
  } catch {
    /* 无痕/受限环境：记忆失效不阻断交互 */
  }
}

/** 活跃判据（用户裁决 Q2）：仅 queued+running 上条；终态立即离开。 */
const isActive = (c: InstanceCardState) => c.state === "queued" || c.state === "running";

/** 展开态简介行：类型徽标 + 名称 + 状态（running 计时 / queued 排位）。 */
const RailRow = function RailRow({
  card,
  onOpen,
}: {
  card: InstanceCardState;
  onOpen: (instanceId: string) => void;
}) {
  const { t } = useI18n();
  const spec = ACTIVITY_TYPES.subagent;
  const Icon = spec.icon;
  const elapsed = useRunningElapsed(card.state === "running");
  const status =
    card.state === "queued"
      ? t("chat.sa.card.queued", { n: card.queuedPosition ?? 0 })
      : t("chat.sa.card.running", { elapsed });
  return (
    <button
      className="rail-row"
      type="button"
      data-activity-type="subagent"
      data-color={spec.color}
      data-state={card.state}
      onClick={() => onOpen(card.instanceId)}
    >
      <span className="rail-badge" aria-hidden="true">
        <Icon size={11} strokeWidth={1.75} />
      </span>
      <span className="rail-row-name">{card.task}</span>
      <span className="rail-row-status">{status}</span>
    </button>
  );
};

const DrawerRail = function DrawerRail({ onOpen }: DrawerRailProps) {
  const { t } = useI18n();
  const { state } = useSession();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const active = state.instances.filter(isActive);
  if (active.length === 0) return null; // 无活跃事件 → 条整体隐藏

  const toggle = (next: boolean) => {
    setCollapsed(next);
    writeCollapsed(next);
  };
  const spec = ACTIVITY_TYPES.subagent;

  return (
    <div
      className="drawer-rail"
      data-drawer-rail
      data-rail-count={active.length}
      data-rail-state={collapsed ? "collapsed" : "expanded"}
    >
      {collapsed ? (
        <>
          <button
            className="rail-toggle"
            type="button"
            aria-label={t("chat.rail.expand")}
            title={t("chat.rail.expand")}
            onClick={() => toggle(false)}
          >
            <ChevronsLeft size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {active.map((card) => (
            <button
              key={card.instanceId}
              className="rail-marker"
              type="button"
              data-activity-type="subagent"
              data-color={spec.color}
              data-state={card.state}
              aria-label={`${t("chat.rail.open")} · ${card.task}`}
              title={`${t("chat.rail.open")} · ${card.task}`}
              onClick={() => onOpen(card.instanceId)}
            />
          ))}
        </>
      ) : (
        <>
          <div className="rail-head">
            <span className="rail-title">
              {t("chat.rail.label")} · {active.length}
            </span>
            <button
              className="rail-toggle"
              type="button"
              aria-label={t("chat.rail.collapse")}
              title={t("chat.rail.collapse")}
              onClick={() => toggle(true)}
            >
              <ChevronsRight size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          {active.map((card) => (
            <RailRow key={card.instanceId} card={card} onOpen={onOpen} />
          ))}
        </>
      )}
    </div>
  );
};

export default DrawerRail;
