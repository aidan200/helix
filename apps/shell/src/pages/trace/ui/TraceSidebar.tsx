/**
 * S3b TraceSidebar —— trace 页侧栏（AppLayout sidebar 槽）：上 = 任务/会话
 * 双分组 + 下 = 选中会话的实例列表（InstancePanel 语义迁入：点击 =
 * onSelectInstance 过滤查询 + 「全部实例」混排入口）。
 *
 * 上分区拆组（任务会话与 chat 会话不混排）：「任务」组 = task.list 映射的
 * task:<jobId> 会话（类型徽章，零任务整组隐藏——空组是纯噪音）；「会话」
 * 组 = topology.list chat 会话。两组同属 session 选择面：点击均触发
 * onSelectSession（session 域查询），选中 cyan 激活态跨组互斥（sessionId
 * 全局唯一）。各分区独立内滚（flex + min-height:0）。
 *
 * 纯展示（TR-AD-8）：数据全由 TracePage 注入，不读 store。壳样式复用
 * chat 侧栏 `.sidebar`（264px + 右缘分隔，与 chat 侧栏布局语言一致）；
 * 分区/条目样式归 trace.css（tsb-* / inst-panel）。空态：会话组无会话
 * / 下分区未选会话时轻量文案。
 */
import type { SessionMeta, TraceInstanceRecord } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import InstancePanel from "./P-1-instance-panel";

export interface TraceSidebarProps {
  /** 任务会话组（task:<jobId> 映射 SessionMeta，按最近活动降序）。 */
  taskSessions: readonly SessionMeta[];
  /** 任务会话类型徽章查表（sessionId → 任务类型；非任务会话无条目）。 */
  taskKinds?: ReadonlyMap<string, string>;
  /** chat 会话组（topology.list，按最近活动降序）。 */
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

/** 会话条目按钮（两组共用形态：任务组条目多一枚类型徽章）。 */
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
  return (
    <aside className="sidebar tsb" data-trace-sidebar aria-label={t("trace.sidebar.ariaLabel")}>
      {/* 任务组：task:<jobId> 会话独立分区（零任务整组隐藏）；点击 = session 域查询 */}
      {taskSessions.length > 0 && (
        <section className="tsb-sec tsb-sec-tasks">
          <div className="tsb-head">
            <span className="tsb-title">{t("trace.sidebar.tasks")}</span>
            <span className="tsb-count">{taskSessions.length}</span>
          </div>
          <div className="tsb-list">
            {taskSessions.map((s) => (
              <SessionItem
                key={s.sessionId}
                meta={s}
                taskKind={taskKinds?.get(s.sessionId)}
                active={s.sessionId === sessionId}
                onSelectSession={onSelectSession}
              />
            ))}
          </div>
        </section>
      )}

      {/* 会话组：chat 会话（点击换会话 = session 域查询；选中 cyan 激活态） */}
      <section className="tsb-sec tsb-sec-sessions">
        <div className="tsb-head">
          <span className="tsb-title">{t("trace.sidebar.sessions")}</span>
          <span className="tsb-count">{sessions.length > 0 ? sessions.length : ""}</span>
        </div>
        <div className="tsb-list">
          {sessions.length === 0 ? (
            <p className="tsb-empty">{t("trace.sidebar.sessionsEmpty")}</p>
          ) : (
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
