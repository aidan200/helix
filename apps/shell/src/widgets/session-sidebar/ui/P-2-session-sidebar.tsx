/**
 * P-2 会话列表侧栏（F(1.2).1 草稿 / F(1.2).2 列表 / F(1.2).4 删除入口 /
 * F(2.1).2 折叠记忆；CL-1 + CL-2）。
 *
 * 数据面（AD-4）：topology.list（session.list / list_changed 维护，按最近
 * 活动降序）+ topology.background（后台轻量 store：运行态徽标 + 未读计数）
 * + 活跃完整 store（活跃卡片徽标 + 草稿判据）。
 *
 * - 草稿卡片：active.sessionId === null 且已连接时在列表顶部（本地态，
 *   不在 session.list——前端零权威，不落库）；
 * - 新建草稿（newDraft）：unsubscribe 旧 + 置草稿态（零建会话帧）；
 * - 删除（F(1.2).4）：confirmingId 单值互斥（进入前清他卡）；删活跃会话
 *   由 deleteSession 内部切草稿态；
 * - 折叠（F(2.1).2）：localStorage(helix-sidebar-collapsed) 记忆；只做
 *   display 切换（sb-full/sb-mini）不动 width 过渡（transform/opacity 纪律）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import { relativeTimeSpan } from "@/shared/lib/format";
import { useSession } from "@/entities/session/SessionContext";
import { selectActiveRunState } from "@/entities/session/model/topology";
import SessionCard, { runBadgeOf } from "./P-2-session-card";

/** 侧栏折叠记忆键（AG-14 白名单：纯 UI 布局偏好，非业务状态）。 */
const SIDEBAR_KEY = "helix-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0");
  } catch {
    /* 无痕/受限环境：记忆失效不阻断交互 */
  }
}

const focusInput = () => {
  (document.getElementById("msg-input") as HTMLInputElement | null)?.focus();
};

const SessionSidebar = function SessionSidebar() {
  const { t } = useI18n();
  const toast = useToast();
  const { state, topology, switchSession, newDraft, deleteSession, requestSessionList } = useSession();

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // 清单拉取（F(1.2).2）：每次进入 connected 发 session.list（daemon 权威
  // 全量回推；list_changed 增量维护归 store）
  useEffect(() => {
    if (state.conn === "connected") requestSessionList();
  }, [state.conn, requestSessionList]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });
  }, []);

  const onNewSession = useCallback(() => {
    newDraft();
    focusInput();
  }, [newDraft]);

  // confirming 互斥：进入前清他卡（单值状态即互斥保证）
  const onDeleteRequest = useCallback((sessionId: string) => {
    setConfirmingId((prev) => (prev === sessionId ? null : sessionId));
  }, []);
  const onDeleteCancel = useCallback(() => setConfirmingId(null), []);
  const onDeleteConfirm = useCallback(
    (sessionId: string) => {
      setConfirmingId(null);
      deleteSession(sessionId);
      toast.push("err", t("chat.sidebar.deleteToast"), t("chat.sidebar.deleteToastSub"));
    },
    [deleteSession, t, toast],
  );

  const isDraft = state.sessionId === null;
  const draftVisible = state.conn === "connected" && isDraft;

  const timeLabel = useMemo(() => {
    const now = Date.now();
    return (at: number): string => {
      const span = relativeTimeSpan(at, now);
      switch (span.key) {
        case "justNow":
          return t("chat.sidebar.timeJustNow");
        case "minutes":
          return t("chat.sidebar.timeMinutes", { n: span.n });
        case "hours":
          return t("chat.sidebar.timeHours", { n: span.n });
        case "yesterday":
          return t("chat.sidebar.timeYesterday");
        default:
          return t("chat.sidebar.timeDays", { n: span.n });
      }
    };
  }, [t]);

  const cards = topology.list.map((meta) => {
    const isActive = meta.sessionId === state.sessionId;
    const bg = topology.background[meta.sessionId];
    return {
      key: meta.sessionId,
      sessionId: meta.sessionId,
      title: meta.title,
      timeLabel: isActive ? timeLabel(meta.lastActivityAt) : timeLabel(bg?.lastActivityAt ?? meta.lastActivityAt),
      // 活跃卡片徽标取活跃完整 store 投影；后台卡片取轻量 store（回退清单元数据）
      runState: isActive ? selectActiveRunState(state) : (bg?.runState ?? meta.runState),
      unread: isActive ? 0 : (bg?.unread ?? 0),
      active: isActive,
    };
  });
  const count = cards.length + (draftVisible ? 1 : 0);

  const onCardSwitch = useCallback(
    (sessionId: string) => {
      if (confirmingId !== null) return; // confirming 态点击卡片不触发切换
      if (sessionId === state.sessionId) return;
      switchSession(sessionId);
    },
    [confirmingId, state.sessionId, switchSession],
  );

  return (
    <aside
      className={cn("sidebar", collapsed && "collapsed")}
      data-sidebar
      data-collapsed={collapsed ? "1" : undefined}
    >
      <div className="sb-full">
        <div className="sb-head">
          <span className="sb-logo">
            HE<span className="lg2">LIX</span>
          </span>
          <button
            className="icon-btn"
            id="btn-collapse-sidebar"
            type="button"
            title={t("chat.sidebar.collapse")}
            aria-label={t("chat.sidebar.collapse")}
            onClick={toggleCollapsed}
          >
            <PanelLeftClose size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="sb-actions">
          <button className="hud-btn hud-btn-cyan sb-new" id="btn-new-session" type="button" onClick={onNewSession}>
            <Plus size={14} strokeWidth={1.75} />
            {t("chat.sidebar.newSession")}
          </button>
        </div>
        <div className="sb-label">
          <span>{t("chat.sidebar.sessions")}</span>
          <span id="ses-count">{count}</span>
        </div>
        <div className="ses-list" id="ses-list">
          {draftVisible && (
            <div
              className="ses active"
              data-session-card="draft"
              data-active="1"
              onClick={focusInput}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") focusInput();
              }}
            >
              <div className="ses-row1">
                <span className="ses-title">{t("chat.topbar.draftTitle")}</span>
              </div>
              <div className="ses-row2">
                <span className="ses-time">{t("chat.sidebar.notSent")}</span>
                <span className="hud-badge hud-badge-off">{t("chat.sidebar.draft")}</span>
              </div>
            </div>
          )}
          {cards.map((c) => (
            <SessionCard
              key={c.key}
              sessionId={c.sessionId}
              title={c.title}
              timeLabel={c.timeLabel}
              runState={c.runState}
              unread={c.unread}
              active={c.active}
              confirming={confirmingId === c.sessionId}
              onSwitch={onCardSwitch}
              onDeleteRequest={onDeleteRequest}
              onDeleteConfirm={onDeleteConfirm}
              onDeleteCancel={onDeleteCancel}
            />
          ))}
        </div>
        <div className="sb-foot">
          <span className="foot-note">daemon · ws</span>
        </div>
      </div>

      {/* 折叠态：56px 图标条（含每会话状态点小方块，F(2.1).2） */}
      <div className="sb-mini">
        <span className="sb-logo mini">H</span>
        <button
          className="mini-item accent"
          id="btn-mini-new"
          type="button"
          title={t("chat.sidebar.newSession")}
          onClick={onNewSession}
        >
          <Plus size={16} strokeWidth={1.75} />
        </button>
        {draftVisible && (
          <button
            className="mini-item active"
            type="button"
            title={t("chat.topbar.draftTitle")}
            onClick={focusInput}
          >
            <span>{t("chat.topbar.draftTitle").slice(0, 1)}</span>
          </button>
        )}
        {cards.map((c) => (
          <button
            key={c.key}
            className={cn("mini-item", c.active && "active")}
            type="button"
            data-mini-session={c.sessionId}
            data-run-state={c.runState}
            title={`${c.title} · ${t(runBadgeOf(c.runState).labelKey)}`}
            onClick={() => onCardSwitch(c.sessionId)}
          >
            <span>{Array.from(c.title)[0] ?? "·"}</span>
            {(c.runState === "streaming" || c.runState === "subagent_running") && (
              <span className={cn("md", c.runState === "subagent_running" && "violet")} />
            )}
          </button>
        ))}
        <span className="mini-spacer" />
        <button
          className="mini-item"
          id="btn-expand-sidebar"
          type="button"
          title={t("chat.sidebar.expand")}
          aria-label={t("chat.sidebar.expand")}
          onClick={toggleCollapsed}
        >
          <PanelLeftOpen size={16} strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  );
};

export default SessionSidebar;
