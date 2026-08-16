/**
 * SubAgent 抽屉（P-2 载体；CL-1 F1.2/F1.8）。
 *
 * 页内 overlay（非路由；selectedAgentId 组件状态，review.md Mock 载体口径）：
 * 右侧 min(540px,100vw) 覆盖，popover-fill+blur 14px+左边线；衬底 = 真实 P-1
 * 弱化 0.85（.app[data-drawer]）+ 背板 void/0.55；背板点击/✕/Esc 三路径关闭。
 *
 * 状态源纪律（TR-AD-5 同一状态源）：抽屉与 P-1 卡片消费同一 reducer 实例
 * 状态——agent.killed 到达时双视图同帧更新（卡片 failed 态 = 抽屉状态 chip
 * failed + terminated 行 + closure failed 卡）。本组件仅持纯 UI 态：kill 两步
 * 确认窗口（3s 复原计时）与 steer 到达基线。
 *
 * 订阅（契约 §4/§8-1）：打开发 agent.subscribe{agentId}、关闭 unsubscribe
 * （v0.1 通路语义；事件全广播前端按 instanceId 分流投影）。
 *
 * 原型标注剥离（review.md）：演示控制台/衬底说明文案/dp-note 不进实现；
 * dev 注入控件为演示控件（isDev() 门控，prod 零渲染——供 F 层剧本驱动
 * steer 拒绝规则，非还原项）。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { EventEnvelope } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { formatDuration } from "@/shared/lib/format";
import { useRunningElapsed } from "@/shared/lib/useRunningElapsed";
import { cn } from "@/shared/lib/cn";
import { isDev } from "@/shared/config/env";
import { useSession } from "@/entities/session/SessionContext";
import ChannelTimeline from "./ChannelTimeline";

/** kill 确认窗口（决策消解：3s 未确认自动复原；终态禁用优先于确认态）。 */
const KILL_CONFIRM_MS = 3_000;

/** dev 注入控件的合成文本（非产品文案；仅 dev 可见）。 */
const DEV_STEER_TEXT = "dev steer injection";

export interface SubagentDrawerProps {
  agentId: string;
  onClose: () => void;
}

const SubagentDrawer = memo(function SubagentDrawer({ agentId, onClose }: SubagentDrawerProps) {
  const { t } = useI18n();
  const toast = useToast();
  const {
    state,
    killInstance,
    subscribeInstance,
    unsubscribeInstance,
    devDispatchEvent,
  } = useSession();

  const card = state.instances.find((c) => c.instanceId === agentId);
  const items = state.instanceChannels[agentId] ?? [];
  const stream = state.channelStreams[agentId];
  const thinkingLive = state.thinkingStreams[agentId];
  const running = card?.state === "running";
  const elapsed = useRunningElapsed(running); // hooks 先于早退（实例不在状态源的防御分支）

  // ── 订阅生命周期（开订/关退订；实例切换 = 换订）──
  useEffect(() => {
    subscribeInstance(agentId);
    return () => unsubscribeInstance(agentId);
  }, [agentId, subscribeInstance, unsubscribeInstance]);

  // ── Esc 关闭（抽屉打开期间全局键盘；背板/✕ 为另两路径）──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── kill 两步状态机（idle → armed 3s → 复原；再击发 agent.kill）──
  const [armed, setArmed] = useState(false);
  const killTimerRef = useRef<number | null>(null);
  const resetArmed = useCallback(() => {
    if (killTimerRef.current !== null) {
      window.clearTimeout(killTimerRef.current);
      killTimerRef.current = null;
    }
    setArmed(false);
  }, []);
  useEffect(() => resetArmed, [resetArmed]); // 卸载清计时器（关抽屉/切实例）
  useEffect(() => {
    if (!running) resetArmed(); // 终态禁用优先于确认态
  }, [running, resetArmed]);
  const onKillClick = () => {
    if (!running) return;
    if (!armed) {
      setArmed(true);
      killTimerRef.current = window.setTimeout(resetArmed, KILL_CONFIRM_MS);
      return;
    }
    resetArmed();
    killInstance(agentId); // 终态回流经 agent.killed 事件（同一状态源双视图同帧）
  };

  // ── steer 到达 toast（打开期间新增注入标记 → violet 交代；回放不 toast）──
  const steerCount = items.reduce((n, i) => (i.kind === "steer" ? n + 1 : n), 0);
  const steerBaselineRef = useRef<number>(-1);
  useEffect(() => {
    steerBaselineRef.current = steerCount; // 挂载/实例切换重基线
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  useEffect(() => {
    if (steerBaselineRef.current >= 0 && steerCount > steerBaselineRef.current) {
      steerBaselineRef.current = steerCount;
      toast.push("violet", t("chat.drawer.steerToast"), t("chat.drawer.steerToastSub", { id: agentId }));
    }
  }, [steerCount, agentId, toast, t]);

  // ── 滚动语义：新事件贴底（scrollTop 直设，无滚动监听）；实例切换回顶 ──
  const bodyRef = useRef<HTMLDivElement>(null);
  const agentIdRef = useRef(agentId);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (agentIdRef.current !== agentId) {
      agentIdRef.current = agentId;
      el.scrollTop = 0;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [agentId, items.length, stream?.text, thinkingLive]);

  // ── dev 注入控件（演示控件 isDev() 门控；steer 拒绝规则的 F 层驱动面）──
  const onDevSteer = () => {
    if (!running) {
      // 状态转换规则（还原契约）：非 running 拒绝，err toast 不清旧态（零 reducer 动作）
      toast.push("err", t("chat.drawer.steerOnlyRunning"), t("chat.drawer.steerOnlyRunningSub"));
      return;
    }
    // running：合成 agent_send 转投回放事件，经 devDispatchEvent 走真实投影路径
    const now = Date.now();
    const synthetic: EventEnvelope = {
      v: 0,
      type: "chat.message.completed",
      instanceId: agentId,
      payload: {
        entry: {
          kind: "message",
          id: `dev-steer-${now}`,
          role: "user",
          content: DEV_STEER_TEXT,
          ts: now,
          instanceId: agentId,
        },
      },
    };
    devDispatchEvent(synthetic);
  };

  if (!card) return null; // 防御：实例不在状态源（正常流经卡片/行尾寻址，不达此分支）

  const stalledVisible = running && card.stalledMs !== undefined;
  const elapsedChip =
    card.state === "running"
      ? t("chat.sa.card.running", { elapsed })
      : card.state === "queued"
        ? t("chat.sa.card.queued", { n: card.queuedPosition ?? 0 })
        : null;

  return (
    <>
      <button
        className="drawer-backdrop"
        type="button"
        aria-label={t("chat.drawer.close")}
        onClick={onClose}
      />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${card.instanceId} · ${card.task}`}
        data-instance={card.instanceId}
      >
        <div className="d-head">
          <div className="d-top">
            <button
              className="d-close"
              type="button"
              aria-label={t("chat.drawer.close")}
              onClick={onClose}
              autoFocus
            >
              ✕
            </button>
            <div className="d-av">SA</div>
            <div className="d-title">
              <div className="d-id">
                {card.instanceId} <span className="prof">· {card.profileKind}</span>
              </div>
            </div>
            <button
              className={cn("d-kill", armed && "confirm")}
              type="button"
              disabled={!running}
              onClick={onKillClick}
            >
              {armed ? t("chat.drawer.killConfirm") : t("chat.drawer.kill")}
            </button>
          </div>
          <div className="d-sub">
            {(card.model ?? state.model) && (
              <span className="d-chip" data-chip="model">
                {card.model ?? state.model}
              </span>
            )}
            {elapsedChip && <span className="d-chip">{elapsedChip}</span>}
            <span className={cn("d-status", card.state)} data-status={card.state}>
              {running && <span className="hud-dot hud-dot-pulse" aria-hidden="true" />}
              {card.state}
            </span>
            {stalledVisible && (
              <span className="d-stalled show" data-stalled>
                <span className="hud-dot hud-dot-pulse" aria-hidden="true" />
                {t("chat.drawer.stalled", { dur: formatDuration(card.stalledMs ?? 0) })}
              </span>
            )}
          </div>
        </div>

        <div className="d-task">
          <div className="d-seclabel">{t("chat.drawer.task")}</div>
          <div className="task-text">{card.task}</div>
          <div className="task-meta">{t("chat.drawer.instanceMeta")}</div>
        </div>

        <div className="d-body" ref={bodyRef}>
          <div className="d-seclabel">{t("chat.drawer.channel")}</div>
          <ChannelTimeline
            agentId={card.instanceId}
            profileKind={card.profileKind}
            items={items}
            stream={stream}
            thinkingLive={thinkingLive}
            queued={card.state === "queued"}
          />
          {isDev() && (
            <button className="drawer-dev" type="button" data-demo onClick={onDevSteer}>
              dev · inject steer
            </button>
          )}
        </div>

        {card.closure?.reportPath ? (
          <div className="d-foot show" data-foot="report">
            <span className="k">reportPath</span>
            <span>{card.closure.reportPath}</span>
            <span className="foot-note">{t("chat.drawer.reportFoot")}</span>
          </div>
        ) : null}
      </aside>
    </>
  );
});

export default SubagentDrawer;
