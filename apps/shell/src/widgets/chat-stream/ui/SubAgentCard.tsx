/**
 * SubAgent 卡片（CL-1 F1.1；chat-stream 第三物种：非消息、非工具卡）。
 *
 * 四态互斥单值（queued/running/done/failed + cancelled 快照恢复态，AD-10），
 * 切换即整卡重渲染；状态投影来自 entities/session reducer 的 instances
 * （agent.* 事件族 / 快照重建），本组件零权威状态、纯渲染。
 *
 * 形态契约（prototype P-1 / tokens.md）：
 * - hud-corners 四角描线 = HUD 一等实体签名（::before/::after CSS 几何）；
 * - violet 28px「SA」头像跨态不变（Agent 角色身份槽位，05 节）；
 * - 状态语言与工具卡同源（StatusDot + 边框 + 角标变色）；
 * - 整卡 `<a>` 语义键盘可达（Tab 聚焦 + Enter/Space 开抽屉；抽屉本体 T4.3，
 *   经 onOpenDrawer 回调接线，当前由调用方占位）。
 *
 * 视图本地态（非投影）：running 态 elapsed 计时、终态收口时间捕获——协议
 * DTO 不携带 startedAt/closure 时间戳，此处为展示层 best-effort（快照重建
 * 后无值，脚注退化为无时间变体）。
 */
import { memo, useEffect, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { formatDuration, formatTs } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";
import type { InstanceCardState } from "@/entities/session/model/session-reducer";

interface SubAgentCardProps {
  card: InstanceCardState;
  /** 开抽屉回调（T4.3 接线；当前占位）——payload = instanceId（≡ agentId，AD-3） */
  onOpenDrawer: (instanceId: string) => void;
}

/** running 态耗时展示（视图本地计时；1s 步进，纯信息量非动效，reduced-motion 不豁免）。 */
function useRunningElapsed(active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  const startRef = useRef<number | null>(null);
  if (active && startRef.current === null) startRef.current = Date.now();
  if (!active) startRef.current = null;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return startRef.current === null ? "0.0s" : formatDuration(now - startRef.current);
}

/** 终态收口时间捕获（视图本地；仅在本组件生命周期内观察到 running→终态转换时
 *  才捕——快照重建直接以终态挂载的卡无权威时间，退化为无时间脚注，避免误显重连时刻）。 */
function useTerminalAt(terminal: boolean): number | null {
  const atRef = useRef<number | null>(null);
  /** 首帧判定：终态挂载（快照恢复）→ false（永不捕）；非终态挂载 → true（可捕） */
  const capturableRef = useRef<boolean | null>(null);
  if (capturableRef.current === null) capturableRef.current = !terminal;
  if (terminal && capturableRef.current && atRef.current === null) atRef.current = Date.now();
  if (!terminal) {
    capturableRef.current = true;
    atRef.current = null;
  }
  return terminal ? atRef.current : null;
}

const SubAgentCard = memo(function SubAgentCard({ card, onOpenDrawer }: SubAgentCardProps) {
  const { t } = useI18n();
  const isQueued = card.state === "queued";
  const isRunning = card.state === "running";
  const isDone = card.state === "done";
  const isFailed = card.state === "failed";
  // cancelled 仅快照恢复态（AD-10）：区别 failed 的中性收口呈现
  const isCancelled = card.state === "cancelled";

  const elapsed = useRunningElapsed(isRunning);
  const terminalAt = useTerminalAt(isDone || isFailed);

  const open = () => onOpenDrawer(card.instanceId);

  // ── 状态位（四态互斥；queued=idle 点 / running=accent 脉冲点 / 终态=徽标）──
  const stateSlot = isQueued ? (
    <>
      <span className="hud-dot hud-dot-idle" />
      <span>{t("chat.sa.card.queued", { n: card.queuedPosition ?? 0 })}</span>
    </>
  ) : isRunning ? (
    <>
      <span className="hud-dot hud-dot-pulse" />
      <span>{t("chat.sa.card.running", { elapsed })}</span>
    </>
  ) : isDone ? (
    <span className="cl-badge">{t("chat.sa.card.doneBadge")}</span>
  ) : isFailed ? (
    <span className="cl-badge bad">{t("chat.sa.card.failedBadge")}</span>
  ) : (
    <span className="cl-badge off">{t("chat.sa.card.cancelledBadge")}</span>
  );

  // ── sub 行与脚注（随态整卡替换：位次行 / streaming 摘要 / closure 摘要 / 错误行）──
  const subText = isQueued
    ? t("chat.sa.card.waiting")
    : isRunning
      ? card.streamSummary
      : isDone
        ? (card.closure?.summary ?? "")
        : isFailed
          ? (card.error ?? card.closure?.summary ?? "")
          : t("chat.sa.card.cancelledSub");

  const foot = isQueued
    ? t("chat.sa.card.queueFoot")
    : isRunning
      ? t("chat.sa.card.channelSub")
      : isDone
        ? terminalAt !== null
          ? t("chat.sa.card.injectedMain", { time: formatTs(terminalAt, t("chat.tsFormat")) })
          : t("chat.sa.card.injectedMainNoTime")
        : isFailed
          ? t("chat.sa.card.failedFoot")
          : t("chat.sa.card.queueFoot");

  return (
    <a
      className={cn("sa-card", card.state)}
      role="link"
      tabIndex={0}
      data-instance={card.instanceId}
      aria-label={`${card.instanceId} · ${card.task}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // Space 防页面滚动；无 href 无原生 click，单次触发
          open();
        }
      }}
    >
      <div className="sa-head">
        <div className="sa-av">SA</div>
        <div className="sa-meta">
          <div className="sa-id">
            {card.instanceId} <span className="prof">· {card.profileKind}</span>
          </div>
          <div className="sa-task">{card.task}</div>
        </div>
        <span className="sa-state">{stateSlot}</span>
      </div>
      <div className={cn("sa-sub", isRunning && "sa-stream")}>
        {subText}
        {isRunning && <span className="stream-cursor" />}
        <div className="sa-foot">
          {foot}
          <span className="go">{t("chat.sa.card.openDrawer")}</span>
        </div>
      </div>
    </a>
  );
});

export default SubAgentCard;
