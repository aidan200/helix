/**
 * S3b TraceSidebar —— trace 页侧栏（AppLayout sidebar 槽，上下双分区）：
 * 上 = 会话列表（topology.list；点击 = onSelectSession，session 域查询，
 * 行为同原控制条 session 下拉——S3b 迁 sidebar）；下 = 选中会话的实例
 * 列表（InstancePanel 语义迁入：点击 = onSelectInstance 过滤查询 +
 * 「全部实例」混排入口）。两分区各自独立内滚（flex + min-height:0）。
 *
 * 纯展示（TR-AD-8）：数据全由 TracePage 注入，不读 store。壳样式复用
 * chat 侧栏 `.sidebar`（264px + 右缘分隔，与 chat 侧栏布局语言一致）；
 * 分区/条目样式归 trace.css（tsb-* / inst-panel）。空态：上分区无会话
 * / 下分区未选会话时轻量文案。
 */
import type { SessionMeta, TraceInstanceRecord } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import InstancePanel from "./P-1-instance-panel";

export interface TraceSidebarProps {
  /** 会话清单（任务会话 task:<jobId> 排前 + topology.list，按最近活动降序）。 */
  sessions: readonly SessionMeta[];
  /** 任务会话类型徽章查表（sessionId → 任务类型；非任务会话无条目）。 */
  taskKinds?: ReadonlyMap<string, string>;
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

const TraceSidebar = function TraceSidebar({
  sessions,
  taskKinds,
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
      {/* 上分区：会话列表（点击换会话 = session 域查询；选中 cyan 激活态） */}
      <section className="tsb-sec">
        <div className="tsb-head">
          <span className="tsb-title">{t("trace.sidebar.sessions")}</span>
          <span className="tsb-count">{sessions.length > 0 ? sessions.length : ""}</span>
        </div>
        <div className="tsb-list">
          {sessions.length === 0 ? (
            <p className="tsb-empty">{t("trace.sidebar.sessionsEmpty")}</p>
          ) : (
            sessions.map((s) => {
              const taskKind = taskKinds?.get(s.sessionId);
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  className={cn("tsb-ses", s.sessionId === sessionId && "on")}
                  data-session-id={s.sessionId}
                  aria-pressed={s.sessionId === sessionId}
                  onClick={() => onSelectSession(s.sessionId)}
                >
                  <span className="tsb-name">
                    {taskKind !== undefined && <span className="tsb-task-badge">{taskKind}</span>}
                    {s.title !== "" ? s.title : s.sessionId}
                  </span>
                  {s.title !== "" && <span className="tsb-id">{s.sessionId}</span>}
                </button>
              );
            })
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
