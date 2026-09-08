/**
 * S3b TraceSidebar —— trace 页侧栏（AppLayout sidebar 槽）：上 = 会话/任务
 * 横排 tab 切换单列表 + 下 = 选中会话的实例列表（InstancePanel 语义迁入：
 * 点击 = onSelectInstance 过滤查询 + 「全部实例」混排入口）。
 *
 * 上分区 tab（任务会话与 chat 会话不混排，用户裁决横排切换）：「会话」
 * tab（默认激活）= topology.list chat 会话；「任务」tab = task.list 映射的
 * task:<jobId> 会话（类型徽章）——零任务时「任务」tab 整体不渲染（空入口
 * 是纯噪音）。两 tab 同属 session 选择面：点击条目均触发 onSelectSession
 * （session 域查询），选中 cyan 激活态跨 tab 互斥（sessionId 全局唯一）。
 * 默认激活 tab 固定「会话」（用户裁决；与 resolvedSessionId 默认解析互不
 * 干涉——默认选中任务会话时数据面照常加载，仅清单停留在会话 tab）。
 * 各分区独立内滚（flex + min-height:0）。
 *
 * 纯展示（TR-AD-8）：数据全由 TracePage 注入，不读 store（tab 本地状态
 * 除外）。壳样式复用 chat 侧栏 `.sidebar`（264px + 右缘分隔，与 chat 侧栏
 * 布局语言一致）；tab/条目样式归 trace.css（tsb-* / inst-panel）。空态：
 * 会话 tab 无会话 / 下分区未选会话时轻量文案。
 */
import { useState } from "react";
import type { SessionMeta, TraceInstanceRecord } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import InstancePanel from "./P-1-instance-panel";

export interface TraceSidebarProps {
  /** 任务会话清单（task:<jobId> 映射 SessionMeta，按最近活动降序；「任务」tab 数据源）。 */
  taskSessions: readonly SessionMeta[];
  /** 任务会话类型徽章查表（sessionId → 任务类型；非任务会话无条目）。 */
  taskKinds?: ReadonlyMap<string, string>;
  /** chat 会话清单（topology.list，按最近活动降序；「会话」tab 数据源）。 */
  sessions: readonly SessionMeta[];
  /** 当前会话（"" = 尚未解析——下分区退「未选会话」空态）。 */
  sessionId: string;
  /** 实例摘要块（选中会话查询结果，AF-5 会话级 fold）。 */
  instances: readonly TraceInstanceRecord[];
  /** null = 全部实例（混排视图）。 */
  selectedInstance: string | null;
  /** 面板数据加载中且无旧面板可保留（切会话瞬间）。 */
  loading: boolean;
  /** running 实例时长参考点（会话最新事件 ts / 组件注入 now）。 */
  refMs: number;
  onSelectSession: (sessionId: string) => void;
  onSelectInstance: (instanceId: string | null) => void;
}

/** 任务会话条目（「任务」tab；条目多一枚类型徽章）。 */
function SessionItem({
  meta,
  taskKind,
  active,
  onSelectSession,
}: {
  meta: SessionMeta;
  taskKind?: string;
  active: boolean;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <button
      type="button"
      className={cn("tsb-ses", active && "on")}
      data-session-id={meta.sessionId}
      aria-pressed={active}
      onClick={() => onSelectSession(meta.sessionId)}
    >
      <span className="tsb-name">
        {taskKind !== undefined && <span className="tsb-task-badge">{taskKind}</span>}
        {meta.title !== "" ? meta.title : meta.sessionId}
      </span>
      {meta.title !== "" && <span className="tsb-id">{meta.sessionId}</span>}
    </button>
  );
}

const TraceSidebar = function TraceSidebar({
  taskSessions,
  taskKinds,
  sessions,
  sessionId,
  instances,
  selectedInstance,
  loading,
  refMs,
  onSelectSession,
  onSelectInstance,
}: TraceSidebarProps) {
  const { t } = useI18n();
  // 激活 tab：本地状态（默认「会话」）；任务清空时回退会话 tab（任务 tab 已隐藏）
  const [tab, setTab] = useState<"sessions" | "tasks">("sessions");
  const activeTab = tab === "tasks" && taskSessions.length === 0 ? "sessions" : tab;
  return (
    <aside className="sidebar tsb" data-trace-sidebar aria-label={t("trace.sidebar.ariaLabel")}>
      {/* 上分区：横排 tab（会话默认 / 任务零任务隐藏）+ 当前 tab 条目单列表 */}
      <section className="tsb-sec">
        <div className="tsb-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={cn("tsb-tab", activeTab === "sessions" && "on")}
            aria-selected={activeTab === "sessions"}
            onClick={() => setTab("sessions")}
          >
            {t("trace.sidebar.sessions")}
          </button>
          {taskSessions.length > 0 && (
            <button
              type="button"
              role="tab"
              className={cn("tsb-tab", activeTab === "tasks" && "on")}
              aria-selected={activeTab === "tasks"}
              onClick={() => setTab("tasks")}
            >
              {t("trace.sidebar.tasks")}
            </button>
          )}
        </div>
        <div className="tsb-list">
          {activeTab === "tasks" ? (
            /* 任务 tab：task:<jobId> 会话（点击 = session 域查询） */
            taskSessions.map((s) => (
              <SessionItem
                key={s.sessionId}
                meta={s}
                taskKind={taskKinds?.get(s.sessionId)}
                active={s.sessionId === sessionId}
                onSelectSession={onSelectSession}
              />
            ))
          ) : sessions.length === 0 ? (
            <p className="tsb-empty">{t("trace.sidebar.sessionsEmpty")}</p>
          ) : (
            /* 会话 tab（默认）：chat 会话（点击换会话 = session 域查询；选中 cyan 激活态） */
            sessions.map((s) => (
              <SessionItem
                key={s.sessionId}
                meta={s}
                active={s.sessionId === sessionId}
                onSelectSession={onSelectSession}
              />
            ))
          )}
        </div>
      </section>

      {/* 下分区：实例列表（InstancePanel 语义；未选会话时轻量空态） */}
      {sessionId === "" ? (
        <section className="tsb-sec">
          <div className="tsb-head">
            <span className="tsb-title">{t("trace.panel.title")}</span>
            <span className="tsb-count" />
          </div>
          <p className="tsb-empty">{t("trace.sidebar.pickSession")}</p>
        </section>
      ) : (
        <InstancePanel
          instances={instances}
          selected={selectedInstance}
          loading={loading}
          refMs={refMs}
          onSelect={onSelectInstance}
        />
      )}
    </aside>
  );
};

export default TraceSidebar;
