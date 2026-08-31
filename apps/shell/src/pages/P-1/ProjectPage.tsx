/**
 * P-1 ProjectPage —— 项目域 + 知识图谱查看（单页 master-detail；CL-5 F5.0，
 * V-3 用户裁决：/project 唯一路由页，无跳转、无 /kg 路由）。
 *
 * 结构（AppLayout 壳）：headerLeft = 「项目」标题 + workspace 徽章 + 选中后
 * 当前项目名上下文 chip（纯标识非导航）；headerRight = 主题切换（全页唯一
 * 一枚，复用既有 helix-theme 键——AF-5：原型 p1-theme 键是原型自持实现，
 * 实现态必须走既有键，AG-14 白名单）；sidebar = 左栏项目域两段
 * （①项目列表 kg.projects 驱动：行=项目名+四态徽章 compact+次行状态信息，
 * 可选中高亮、无行尾按钮 ②工作树占位空态——无 API 本迭代不实现）或
 * 36px 折叠窄轨（选中自动折叠+点竖排项目名展开可反复，纯形态切换不触碰主区）；
 * children = 主区四态状态机（empty/absent+构建 CTA/building 进度/graph）
 * ——四态互斥，切项目先清旧态（kgToken 递增重挂 KgViewer 防旧图谱残影）。
 *
 * 数据面（六命令族，契约 contracts/kg-viewer-api.md）：kg.projects 驱动
 * 左栏；absent 主区「构建索引」CTA → kg.index.status {project, rebuild:true}
 * （B1 冷启动）；building 态 O-6 同通道轮询（750ms）至离开 building；
 * graph 态整组件树归 KgViewer（F5.1~F5.5）。
 *
 * 已知边界：kg.*.result 回执帧无 project 回显/关联 id（契约 v0.1 零成本
 * DTO 取向），快速切项目时在途回执可能瞬态落进新实例（单飞+按序回执
 * 保证被下一帧立即覆盖）——记 architecture-feedback，留待 additive 批次。
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { KgIndexStatusDto, KgProjectRow } from "@helix/protocol";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { useTheme } from "@/shared/ui/theme";
import { createProjectPageState, projectReducer } from "./model/project-model";
import KgViewer from "./kg-viewer";
import { ProgressFill } from "./ui/kg-progress";

/** building 轮询间隔（O-6：500ms-1s 由前端定）。 */
const INDEX_POLL_MS = 750;

/** ISO → 「MM-DD HH:mm」短格式（次行完成时间；非法输入原样返回）。 */
function fmtSyncedAt(iso: string | undefined): string {
  if (iso === undefined) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** workspace 名派生（首行绝对路径的父目录名；失败回落裸 workspace）。 */
function workspaceNameOf(projects: readonly KgProjectRow[]): string | null {
  const first = projects[0]?.path;
  if (first === undefined || !first.startsWith("/")) return null;
  const parts = first.split("/").filter((s) => s !== "");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
}

/** 项目列表骨架（首拉；与行布局同构）。 */
function ProjectListSkeleton() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div className="kg-skel-row" key={i}>
          <div className="kg-skel-line" style={{ width: `${38 + ((i * 9) % 26)}%` }} />
          <div className="kg-skel-line" style={{ width: `${56 + ((i * 13) % 30)}%`, height: 8 }} />
        </div>
      ))}
    </>
  );
}

/** F5.0 四态徽章（compact；synced 脉冲点 / degraded DEGRADED 警示 / absent muted）。 */
function ProjectBadge({
  row,
  pct,
  waiting,
  t,
}: {
  row: KgProjectRow;
  pct: number;
  /** 无真实进度（daemon 不回 progress）→ 「构建中…」不确定态，不显示假 0%。 */
  waiting: boolean;
  t: ReturnType<typeof useI18n>["t"];
}) {
  if (row.status === "synced")
    return (
      <span className="hud-badge pb-synced">
        <span className="kg-dot ok" />
        {t("pj.badge.synced")}
      </span>
    );
  if (row.status === "degraded") return <span className="kg-sev-badge warn">{t("pj.badge.degraded")}</span>;
  if (row.status === "building")
    return (
      <span className="hud-badge pb-building">
        {waiting ? t("pj.badge.buildingWait") : t("pj.badge.building", { pct: Math.round(pct * 100) })}
      </span>
    );
  return <span className="hud-badge pb-absent">{t("pj.badge.absent")}</span>;
}

/** F5.0 次行状态信息（synced 统计 / degraded 影响 / building N/M / absent 提示）。 */
function projectDataLine(
  row: KgProjectRow,
  progress: { done: number; total: number } | null,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (row.status === "synced")
    return t("pj.dataLine.synced", { symbols: row.symbolCount ?? 0, nodes: row.nodeCount ?? 0, at: fmtSyncedAt(row.syncedAt) });
  if (row.status === "degraded") return row.degradedNote ?? "";
  if (row.status === "building")
    return progress === null || progress.total === 0
      ? t("pj.dataLine.buildingWait")
      : t("pj.dataLine.building", { done: progress.done, total: progress.total });
  return t("pj.dataLine.absent");
}

const ProjectPage = function ProjectPage({
  path,
  /** 「前往『任务』页」出口（App 层路由回调；缺省 no-op——路由登记面在 T3.1 页面域接通）。 */
  onOpenTasks = () => {},
}: {
  path: string;
  onOpenTasks?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { theme, setTheme } = useTheme();
  const { state: session, sendKgProjects, sendKgIndexStatus, subscribeKgFrames, subscribeWorkspaceFrames } = useSession();
  const conn = session.conn;

  const [state, dispatch] = useReducer(projectReducer, undefined, createProjectPageState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 页面发起的 kg.index.status 目标项目（回执无 project 回显——关联靠此 ref）。 */
  const idxReqRef = useRef<string | null>(null);

  // kg.projects 首拉/重连重拉（读面幂等；首挂已连也拉——prev=null 占位）
  const prevConnRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = conn;
    if (conn === "connected" && prev !== "connected") sendKgProjects();
  }, [conn, sendKgProjects]);

  // workspace_changed 刷新链（W4；按连接转换重拉同款既有模式接）：换绑后
  // 项目域整体作废——页面状态复位到首拉态 + 重拉 kg.projects（kg 视图随
  // 选中清空卸载，新选中后按新域重挂；daemon 侧会话已随重绑卸载，见
  // SessionRegistry.unloadAll）。
  useEffect(
    () =>
      subscribeWorkspaceFrames((e) => {
        if (e.type !== "workspace_changed") return;
        dispatch({ type: "workspace-reset" });
        sendKgProjects();
      }),
    [subscribeWorkspaceFrames, sendKgProjects],
  );

  // kg 族点对点回执消费（页面私有 reducer；AG-15 不进 session store）
  useEffect(
    () =>
      subscribeKgFrames((e) => {
        if (e.type === "kg.projects.result") {
          dispatch({ type: "list-result", projects: [...e.payload.projects] });
          return;
        }
        if (e.type === "kg.index.status.result") {
          const name = idxReqRef.current;
          if (name === null) return; // 非页面发起（KgViewer 面板轮询）——页面层不消费
          const status: KgIndexStatusDto = e.payload;
          dispatch({ type: "index-status", name, status });
          const cur = stateRef.current;
          if (
            name === cur.selected &&
            cur.mainMode === "building" &&
            (status.state === "synced" || status.state === "degraded")
          ) {
            toast.push("ok", t("pj.main.buildDoneToast", { name, symbols: status.symbolCount ?? 0 }));
            sendKgProjects(); // 左栏徽章与次行权威刷新
          }
        }
      }),
    [subscribeKgFrames, toast, sendKgProjects, t],
  );

  // building 态 O-6 轮询（500ms-1s 区间取 750ms；离开 building 由回执翻转）
  const selected = state.selected;
  const mainMode = state.mainMode;
  useEffect(() => {
    if (mainMode !== "building" || selected === null) return;
    idxReqRef.current = selected;
    sendKgIndexStatus({ project: selected });
    const timer = setInterval(() => {
      idxReqRef.current = selected;
      sendKgIndexStatus({ project: selected });
    }, INDEX_POLL_MS);
    return () => clearInterval(timer);
  }, [mainMode, selected, sendKgIndexStatus]);

  // B1 冷启动：absent 主区「构建索引」CTA（左栏行无任何按钮——入口唯一）
  const onBuild = useCallback(() => {
    const cur = stateRef.current;
    if (cur.selected === null || cur.mainMode !== "absent") return;
    idxReqRef.current = cur.selected;
    sendKgIndexStatus({ project: cur.selected, rebuild: true });
    dispatch({ type: "build-started", name: cur.selected });
  }, [sendKgIndexStatus]);

  const onSelectProject = useCallback((name: string) => {
    dispatch({ type: "select-project", name });
  }, []);

  const onExpandDomain = useCallback(() => dispatch({ type: "expand-domain" }), []);

  // ── 展示派生 ─────────────────────────────────────────────
  const selectedRow =
    state.selected !== null ? (state.projects.find((p) => p.name === state.selected) ?? null) : null;
  const indexedCount = state.projects.filter((p) => p.status !== "absent").length;
  const wsName = workspaceNameOf(state.projects);
  const buildRatio =
    state.buildProgress !== null && state.buildProgress.total > 0
      ? state.buildProgress.done / state.buildProgress.total
      : 0;
  /** 真实 daemon building 回执不带 progress（{state:"building"} 仅此）——
      无真实进度时不确定态（假「0 / 0」零渲染）。 */
  const buildWaiting = state.buildProgress === null || state.buildProgress.total === 0;

  return (
    <AppLayout
      headerLeft={
        <>
          <h1 className="p1-title">{t("pj.title")}</h1>
          <span className="hud-chip">{wsName !== null ? t("pj.workspace", { name: wsName }) : t("pj.workspacePlain")}</span>
          {state.selected !== null && (
            <span className="hud-chip" data-ctx-proj={state.selected}>
              {state.selected}
            </span>
          )}
        </>
      }
      headerRight={
        <button
          type="button"
          className="hud-btn hud-btn-ghost kg-btn-sm"
          data-theme-toggle
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "LIGHT" : "DARK"}
        </button>
      }
      sidebar={
        state.domainCollapsed ? (
          <aside className="pj-rail" aria-label={t("pj.domain.railAriaLabel")} data-pj-rail="collapsed">
            <div
              className="pj-rail-name"
              role="button"
              tabIndex={0}
              title={t("pj.domain.expandTitle")}
              onClick={onExpandDomain}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onExpandDomain();
              }}
            >
              {state.selected ?? ""}
            </div>
          </aside>
        ) : (
          <aside className="pj-domain" aria-label={t("pj.domain.ariaLabel")} data-pj-domain>
            <section className="pj-dsec pj-dsec-proj">
              <div className="pj-dsec-head">
                <span className="pj-dsec-title">{t("pj.domain.projectsTitle")}</span>
                <span className="pj-dsec-count">
                  {state.listLoading
                    ? t("pj.domain.loading")
                    : t("pj.domain.countLine", { n: state.projects.length, m: indexedCount })}
                </span>
              </div>
              <div className="pj-plist" aria-label={t("pj.domain.projectsAriaLabel")}>
                {state.listLoading ? (
                  <ProjectListSkeleton />
                ) : (
                  state.projects.map((row) => (
                    <div
                      key={row.name}
                      className={`pj-row st-${row.status}${state.selected === row.name ? " selected" : ""}`}
                      data-name={row.name}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectProject(row.name)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") onSelectProject(row.name);
                      }}
                    >
                      <div className="pj-row-main">
                        <span className="pj-row-name">{row.name}</span>
                        <ProjectBadge
                          row={row}
                          pct={
                            state.selected === row.name &&
                            state.buildProgress !== null &&
                            state.buildProgress.total > 0
                              ? state.buildProgress.done / state.buildProgress.total
                              : 0
                          }
                          waiting={
                            state.buildProgress === null || state.buildProgress.total === 0
                          }
                          t={t}
                        />
                      </div>
                      <div className="pj-row-data">
                        {projectDataLine(row, state.selected === row.name ? state.buildProgress : null, t)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </aside>
        )
      }
    >
      <div className="pj-main" data-pj-main={state.mainMode} data-p1-project={path}>
        {state.mainMode !== "graph" && (
          <div className="pj-main-center">
            {state.mainMode === "empty" && (
              <div className="pj-center-panel">
                <div className="pj-cp-title">{t("pj.main.emptyTitle")}</div>
                <div className="pj-cp-sub">{t("pj.main.emptySub")}</div>
              </div>
            )}
            {state.mainMode === "absent" && selectedRow !== null && (
              <div className="pj-center-panel" data-boot-entry="guide">
                <div className="pj-cp-title">{selectedRow.name}</div>
                <div className="pj-cp-badges">
                  <span className="hud-badge pb-absent">{t("pj.badge.absent")}</span>
                  {/* T3.2 R-11 引导态：bootstrap 入口前置条件未满足（串联冷启动链） */}
                  <span className="hud-badge pb-absent">{t("pj.boot.guideBadge")}</span>
                </div>
                <div className="pj-cp-sub">{t("pj.main.absentSub")}</div>
                <div className="pj-cp-sub">{t("pj.boot.guideSub")}</div>
                <button type="button" className="hud-btn kg-btn-primary" data-build-cta onClick={onBuild}>
                  {t("pj.main.buildCta")}
                </button>
              </div>
            )}
            {state.mainMode === "building" && selectedRow !== null && (
              <div className="pj-build-panel">
                <div className="pj-bp-head">
                  <span className="pj-bp-title">{t("pj.main.buildTitle", { name: selectedRow.name })}</span>
                  <span className="hud-badge pb-building">
                    {buildWaiting ? t("pj.badge.buildingWait") : t("pj.badge.building", { pct: Math.round(buildRatio * 100) })}
                  </span>
                </div>
                <div className="kg-progress">
                  {buildWaiting ? <ProgressFill indeterminate /> : <ProgressFill ratio={buildRatio} />}
                </div>
                <div className="kgv-ip-sub">
                  {buildWaiting
                    ? t("pj.main.buildSubWait")
                    : t("pj.main.buildSub", { done: state.buildProgress?.done ?? 0, total: state.buildProgress?.total ?? 0 })}
                </div>
              </div>
            )}
          </div>
        )}
        {state.mainMode === "graph" && selectedRow !== null && (
          /* 切项目先清旧态再进新态：key=kgToken 强制重挂（新数据面）。T3.2：
             produce/bootstrap 扩面状态与 dispatch 注入（切项目复位在 reducer） */
          <KgViewer
            key={state.kgToken}
            project={selectedRow}
            produce={state.produce}
            bootstrapLaunched={state.bootstrap.launched}
            projectDispatch={dispatch}
            onOpenTasks={onOpenTasks}
          />
        )}
      </div>
    </AppLayout>
  );
};

export default ProjectPage;
