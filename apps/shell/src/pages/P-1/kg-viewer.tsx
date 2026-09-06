/**
 * P-1 KgViewer —— graph 态图谱视图组件（F5.1~F5.5；主区 graph 分量，
 * 组件而非路由——V-3 单页裁决）。
 *
 * 每次进入 graph（含切项目）由 ProjectPage 以 key=kgToken 强制重挂 =
 * 新数据面：过滤/选中/报告决定/索引面板态全清空（防跨项目骨架竞态）。
 * 内部结构 = 主区顶部项目上下文（「知识图谱 · 项目名」+ 右侧索引状态
 * 紧凑形态，纯标识无返回无导航）+ 左列 380px（搜索/三路过滤/节点列表）
 * + 右区「节点详情 | 变化报告 | 产出呈现」三 tab。
 *
 * 数据面（五图谱命令，全部带 project = 当前选中项目）：
 * - kg.list 一次性拉全量 → 客户端三路过滤（原型同型即时交互；命令契约
 *   的 q/kind/status 参数不因此收窄）；
 * - kg.node.detail（默认选中首个实体节点——mock 数据面 E-9 先例）；
 * - kg.change.report（纯通知面：条目无行动项，无待决计数徽章）；
 * - kg.index.status（头部紧凑形态起步态；degraded「重新构建」→ rebuild:true 轮询）；
 * - kg.node.confirm（页面唯一写：draft 两步确认后发送；回执翻转列表行
 *   +重发 detail 取 daemon 落账日志）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from "react";
import type { KgCandidateRowDto, KgHealthDto, KgNodeListRow, KgProjectRow } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import {
  createKgViewState,
  filterRows,
  kgReducer,
} from "./model/kg-model";
import { bootstrapEntryMode, type ProjectAction } from "./model/project-model";
import { createKgFramesListener } from "./model/kg-frames-listener";
import { useKgWriteFlight, type KgWriteKind } from "./model/use-kg-write-flight";
import { highlight, KindBadge, StatusBadge } from "./ui/kg-refs";
import KgDetailPane from "./ui/kg-detail-pane";
import KgReportPane from "./ui/kg-report-pane";
import KgIndexPanel from "./ui/kg-index-panel";
import KgBootstrapEntry from "./ui/kg-bootstrap-entry";
import KgHealthPane from "./ui/kg-health-pane";
import KgCandidatesPanel, { type CandFilter } from "./ui/kg-candidates-panel";

/** 面板重建轮询间隔（O-6 同主区 building 轮询）。 */
const REBUILD_POLL_MS = 750;

/** 写面失败 toast 文案键（单飞 kind → 既有 fail 文案；超时兜底复用同键 +
 *  flightTimeout 作 message——M9 #2.31 统一 hook 一处收口）。 */
const WRITE_FAIL_KEY: Record<KgWriteKind, string> = {
  create: "pj.boot.createFailToast",
  purge: "pj.kg.purgeFailToast",
  indexDelete: "pj.kg.idxDeleteFailToast",
  review: "pj.health.reviewFailToast",
  codeReview: "pj.health.codeReviewFailToast",
};

const KgViewer = function KgViewer({
  project,
  bootstrapLaunched,
  projectDispatch,
  onOpenTasks,
}: {
  project: KgProjectRow;
  /** bootstrap 启动标记（T3.2；bootstrapEntryMode 叠加位）。 */
  bootstrapLaunched: boolean;
  /** projectReducer dispatch（本组件只派发 bootstrap 扩面 action）。 */
  projectDispatch: Dispatch<ProjectAction>;
  /** 「前往『任务』页」出口（入口卡 ok-strip 与产出分组任务详情链接）。 */
  onOpenTasks: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const {
    state: sessionState,
    sendKgList,
    sendKgNodeDetail,
    sendKgChangeReport,
    sendKgNodeConfirm,
    sendKgIndexStatus,
    sendKgBootstrapCreate,
    sendKgGraphPurge,
    sendKgIndexDelete,
    sendKgHealth,
    sendKgReviewCreate,
    sendCodeReviewCreate,
    sendKgCandidatesList,
    sendKgProjects,
    subscribeKgFrames,
  } = useSession();
  const conn = sessionState.conn;

  const [state, dispatch] = useReducer(kgReducer, undefined, createKgViewState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 写面单飞（M9 #2.31 统一 hook）：bootstrap create / purge / indexDelete /
   *  review / codeReview 在途收敛单一带类型 flight（一次一个在途）——发起 /
   *  回执归因 / connection.error 归因 / 超时兜底一处收口。flight 驱动全部写
   *  入口钮禁用；settle/notifyError 引用稳定供 listener 闭包消费。 */
  const { flight, launch, settle, notifyError } = useKgWriteFlight({
    onSendFail: () => toast.push("err", t("pj.boot.sendFail")),
    onConnError: (kind, message) => toast.push("err", t(WRITE_FAIL_KEY[kind], { message })),
    onTimeout: (kind) => toast.push("err", t(WRITE_FAIL_KEY[kind], { message: t("pj.kg.flightTimeout") })),
  });
  /** 体检面板数据面（W2-E；首进 health tab 拉一次）。 */
  const [healthView, setHealthView] = useState<{ loading: boolean; data: KgHealthDto | null }>({ loading: false, data: null });
  const healthFetchedRef = useRef(false);
  const [reviewLaunched, setReviewLaunched] = useState(false);
  const [codeReviewLaunched, setCodeReviewLaunched] = useState(false);
  /** 候选台账面板数据面（台账读面三件套；与 health 同窗口拉取——
   *  首进 tab 一次；过滤/选中为本地态，行集由回执刷新）。 */
  const [candView, setCandView] = useState<{
    loading: boolean;
    rows: readonly KgCandidateRowDto[];
    total: number;
    filter: CandFilter;
    sel: string | null;
  }>({ loading: false, rows: [], total: 0, filter: "all", sel: null });

  // 进入 graph 即新数据面：列表骨架 + 详情骨架 + 报告/索引面板并行拉取。
  // 连接转换驱动（M40：首挂已连即拉 + 断线重连重发——读面幂等，ProjectPage
  // prevConnRef 先例；断连挂载不发送，待转换 connected 才发，不再永久陈旧）；
  // 发送失败（send 返回 false）落 err toast（M41：对齐写面发送失败门控）。
  const prevConnRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = conn;
    if (conn !== "connected" || prev === "connected") return;
    const okList = sendKgList({ project: project.name });
    const okReport = sendKgChangeReport({ project: project.name });
    const okIdx = sendKgIndexStatus({ project: project.name });
    if (!(okList && okReport && okIdx)) toast.push("err", t("pj.boot.sendFail"));
  }, [conn, project.name, sendKgList, sendKgChangeReport, sendKgIndexStatus, toast, t]);

  // kg 族点对点回执消费（页面私有 reducer；listener 独立模块 kg-frames-listener，
  // M9 #2.31 拆分——settle/notifyError 引用稳定，订阅面不随在途态重建）
  useEffect(
    () =>
      subscribeKgFrames(
        createKgFramesListener({
          projectName: project.name,
          stateRef,
          dispatch,
          flight: { settle, notifyError },
          sendKgNodeDetail,
          sendKgList,
          sendKgChangeReport,
          sendKgIndexStatus,
          sendKgProjects,
          projectDispatch,
          toast,
          t,
          onHealthResult: (data) => setHealthView({ loading: false, data }),
          onCandidatesResult: (rows, total) =>
            setCandView((v) => ({ loading: false, rows: [...rows], total, filter: v.filter, sel: v.sel })),
          // M9 #2.31：connection.error 兜底清两个读面 loading（不恒真无报错）
          clearReadLoading: () => {
            setHealthView((v) => (v.loading ? { loading: false, data: v.data } : v));
            setCandView((v) => (v.loading ? { ...v, loading: false } : v));
          },
          markReviewLaunched: () => setReviewLaunched(true),
          markCodeReviewLaunched: () => setCodeReviewLaunched(true),
        }),
      ),
    [subscribeKgFrames, project.name, settle, notifyError, sendKgNodeDetail, sendKgList, sendKgChangeReport, sendKgIndexStatus, sendKgProjects, projectDispatch, toast, t],
  );

  // F5.5 面板重建轮询（degraded→building 触发后至离开 building）
  const idxRebuilding = state.idxRebuilding;
  useEffect(() => {
    if (!idxRebuilding) return;
    const timer = setInterval(() => sendKgIndexStatus({ project: project.name }), REBUILD_POLL_MS);
    return () => clearInterval(timer);
  }, [idxRebuilding, project.name, sendKgIndexStatus]);

  // ── 交互回调 ─────────────────────────────────────────────
  const onSelectNode = useCallback(
    (id: string) => {
      dispatch({ type: "select-node", id });
      sendKgNodeDetail({ project: project.name, id });
    },
    [project.name, sendKgNodeDetail],
  );

  const onConfirm = useCallback(
    (id: string) => {
      sendKgNodeConfirm({ project: project.name, id }); // 页面唯一写入口（F5.4）
    },
    [project.name, sendKgNodeConfirm],
  );

  const onFilterQ = useCallback((q: string) => dispatch({ type: "filter-q", q }), []);
  const onFilterKind = useCallback((kind: "all" | "rule" | "entity") => dispatch({ type: "filter-kind", kind }), []);
  const onFilterStatus = useCallback(
    (status: "all" | "confirmed" | "draft" | "superseded") => dispatch({ type: "filter-status", status }),
    [],
  );
  const onClearFilter = useCallback(() => dispatch({ type: "clear-filter" }), []);
  const onTab = useCallback((tab: "detail" | "report" | "health") => dispatch({ type: "tab", tab }), []);
  const onRebuild = useCallback(() => {
    dispatch({ type: "idx-rebuild-started" });
    sendKgIndexStatus({ project: project.name, rebuild: true });
  }, [project.name, sendKgIndexStatus]);

  // ── kg 维护批写面回调（C1；单飞锁在统一 hook，Panel 纯展示）──
  const onLaunchPurge = useCallback(() => {
    launch("purge", () => sendKgGraphPurge({ project: project.name }));
  }, [launch, project.name, sendKgGraphPurge]);
  const onLaunchIndexDelete = useCallback(() => {
    launch("indexDelete", () => sendKgIndexDelete({ project: project.name }));
  }, [launch, project.name, sendKgIndexDelete]);

  // ── bootstrap 入口回调（T3.2；单飞锁在统一 hook，Entry 纯展示）──
  const onLaunchBootstrap = useCallback(() => {
    launch("create", () => sendKgBootstrapCreate({ project: project.name }));
  }, [launch, project.name, sendKgBootstrapCreate]);

  // health + 台账拉取（W2-E + 三件套；首进 tab 各发一次，回执经 listener 落本地态）
  // M9 #2.31：send 返回值必检（同文件其余发送点同纪律）——false 清对应
  // loading + err toast（体检 tab 与台账面板不恒 loading 无报错）。
  const tab = state.tab;
  useEffect(() => {
    if (tab !== "health" || healthFetchedRef.current) return;
    healthFetchedRef.current = true;
    setHealthView({ loading: true, data: null });
    setCandView((v) => ({ ...v, loading: true }));
    const okHealth = sendKgHealth({ project: project.name });
    const okCand = sendKgCandidatesList({ project: project.name });
    if (!okHealth) setHealthView({ loading: false, data: null });
    if (!okCand) setCandView((v) => ({ ...v, loading: false }));
    if (!(okHealth && okCand)) toast.push("err", t("pj.boot.sendFail"));
  }, [tab, project.name, sendKgHealth, sendKgCandidatesList, toast, t]);

  /** 台账过滤（面板按钮 + 体检四态徽章联动同一入口）：设过滤 + 重拉。 */
  const onCandFilter = useCallback(
    (filter: CandFilter) => {
      setCandView((v) => ({ ...v, filter, loading: true }));
      if (!sendKgCandidatesList({ project: project.name, ...(filter !== "all" ? { status: filter } : {}) })) {
        setCandView((v) => ({ ...v, loading: false }));
        toast.push("err", t("pj.boot.sendFail"));
      }
    },
    [project.name, sendKgCandidatesList, toast, t],
  );
  /** 台账行点击：切换选中展开 body 详情（再点收起）。 */
  const onCandSelect = useCallback((id: string) => {
    setCandView((v) => ({ ...v, sel: v.sel === id ? null : id }));
  }, []);

  // ── kg.review.create 发起（W2-F；单飞锁在统一 hook，Pane 纯展示）──
  const onLaunchReview = useCallback(() => {
    launch("review", () => sendKgReviewCreate({ project: project.name }));
  }, [launch, project.name, sendKgReviewCreate]);

  // ── code.review.create 发起（code-review v1.5；单飞锁在统一 hook）──
  const onLaunchCodeReview = useCallback(() => {
    launch("codeReview", () => sendCodeReviewCreate({ project: project.name }));
  }, [launch, project.name, sendCodeReviewCreate]);

  // ── 展示派生 ─────────────────────────────────────────────
  const rows = useMemo(() => filterRows(state.all, state.filter), [state.all, state.filter]);
  /** P2③ superseded 折叠：仅 status=all 视图生效（显式选「已取代」段 =
   *  全量直显；confirmed/draft 段本就无 superseded）。matched 计数含
   *  superseded（过滤语义不变），折叠只作用于行渲染。 */
  const collapsedSup = state.filter.status === "all";
  const activeRows = useMemo(
    () => (collapsedSup ? rows.filter((n) => n.status !== "superseded") : rows),
    [rows, collapsedSup],
  );
  const supersededRows = useMemo(
    () => (collapsedSup ? rows.filter((n) => n.status === "superseded") : []),
    [rows, collapsedSup],
  );
  /** 主状态派生：全量未到 = loading；过滤无匹配 = empty（即时重渲染，转换干净）。 */
  const view = state.view === "loading" ? "loading" : rows.length === 0 ? "empty" : "success";
  const byId = useMemo(() => new Map(state.all.map((n) => [n.id, n])), [state.all]);

  /** F5.1 节点行（现行区与 P2③ superseded 折叠区共用同一行形态）。 */
  const rowNode = (n: KgNodeListRow) => (
    <div
      key={n.id}
      className={`kgv-row${n.status === "draft" ? " draft" : ""}${n.status === "superseded" ? " superseded" : ""}${
        state.sel === n.id ? " selected" : ""
      }`}
      data-id={n.id}
      role="button"
      tabIndex={0}
      onClick={() => onSelectNode(n.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelectNode(n.id);
      }}
    >
      <div className="kgv-row-main">
        <span className="kgv-row-name">{highlight(n.name, state.filter.q)}</span>
        <KindBadge kind={n.kind} />
        <StatusBadge status={n.status} />
      </div>
      <div className="kgv-row-digest">{highlight(n.digest, state.filter.q)}</div>
      {/* AD-16：id 只存在于「详情 →」链接的 data-id 属性 */}
      <a
        className="kgv-row-link"
        data-id={n.id}
        onClick={(e) => {
          e.stopPropagation();
          onSelectNode(n.id);
        }}
      >
        {t("pj.kg.detailLink")}
      </a>
    </div>
  );

  /** purge 两步确认（C1 危险操作；内联确认条——kg-detail-pane confirmOpen 同形态）。 */
  const [purgeOpen, setPurgeOpen] = useState(false);

  return (
    <>
      {/* F5.0 graph 态项目上下文：纯标识、无返回、无导航（FID-31）；
          右侧 = F5.5 索引状态紧凑形态（原只读/迭代 chip 位）+ C1 清空图谱入口 */}
      <div className="kgv-head" data-kg-head>
        <span className="kgv-title">{t("pj.kg.headTitle", { name: project.name })}</span>
        <KgIndexPanel idx={state.idx} rebuilding={state.idxRebuilding} onRebuild={onRebuild} onDelete={onLaunchIndexDelete} deleting={flight !== null} />
        <button
          type="button"
          className="hud-btn hud-btn-danger kg-btn-sm"
          data-kg-purge
          disabled={flight !== null || purgeOpen}
          onClick={() => setPurgeOpen(true)}
        >
          {t("pj.kg.purge")}
        </button>
      </div>
      {/* C1 危险操作两步确认（文案含「不可恢复」与「运行中任务时不可用」说明） */}
      {purgeOpen && (
        <div className="kgv-confirm-box" data-kg-purge-confirm>
          <div className="kgv-confirm-text">{t("pj.kg.purgeConfirm")}</div>
          <div className="kgv-confirm-btns">
            <button
              type="button"
              className="hud-btn hud-btn-danger kg-btn-sm"
              data-act="confirm"
              disabled={flight !== null}
              onClick={() => {
                setPurgeOpen(false);
                onLaunchPurge();
              }}
            >
              {t("pj.kg.purgeYes")}
            </button>
            <button
              type="button"
              className="hud-btn hud-btn-ghost kg-btn-sm"
              data-act="cancel"
              onClick={() => setPurgeOpen(false)}
            >
              {t("pj.kg.purgeNo")}
            </button>
          </div>
        </div>
      )}
      <section className="kgv-workspace" data-kg-workspace>
        <aside className="kgv-side">
          <div className="kgv-side-search">
            <input
              className="hud-input"
              type="text"
              placeholder={t("pj.kg.searchPlaceholder")}
              aria-label={t("pj.kg.searchAria")}
              autoComplete="off"
              data-kg-q
              value={state.filter.q}
              onChange={(e) => onFilterQ(e.target.value)}
            />
            <div className="kgv-seg-row">
              <div className="kg-seg" data-kg-seg-kind>
                {(["all", "rule", "entity"] as const).map((v) => (
                  <button key={v} type="button" className={state.filter.kind === v ? "active" : ""} onClick={() => onFilterKind(v)}>
                    {v === "all" ? t("pj.kg.segAll") : v === "rule" ? t("pj.kg.segRule") : t("pj.kg.segEntity")}
                  </button>
                ))}
              </div>
              <div className="kg-seg" data-kg-seg-status>
                {(["all", "confirmed", "draft", "superseded"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={state.filter.status === v ? "active" : ""}
                    onClick={() => onFilterStatus(v)}
                  >
                    {v === "all"
                      ? t("pj.kg.segAll")
                      : v === "confirmed"
                        ? t("pj.kg.segConfirmed")
                        : v === "draft"
                          ? t("pj.kg.segDraft")
                          : t("pj.kg.segSuperseded")}
                  </button>
                ))}
              </div>
            </div>
            <div className="kgv-count-line" data-kg-count>
              {view === "loading"
                ? t("pj.kg.loading")
                : t("pj.kg.countLine", { total: state.total, matched: rows.length })}
            </div>
          </div>

          <div className="kgv-list" aria-label={t("pj.kg.listAria")} data-kg-list>
            {view === "loading" &&
              [0, 1, 2, 3, 4, 5, 6].map((i) => (
                <div className="kg-skel-row" key={i}>
                  <div className="kg-skel-line" style={{ width: `${52 + ((i * 7) % 30)}%` }} />
                  <div className="kg-skel-line" style={{ width: `${70 + ((i * 11) % 25)}%`, height: 8 }} />
                </div>
              ))}
            {view === "empty" && state.total === 0 && (
              /* C1 空态（全库无节点）：原因说明——尚未发起过任务或已被清空 */
              <div className="kgv-empty" data-kg-empty-all>
                <div className="kgv-empty-t">{t("pj.kg.emptyAllTitle")}</div>
                <div className="kgv-empty-s">{t("pj.kg.emptyAllSub")}</div>
              </div>
            )}
            {view === "empty" && state.total > 0 && (
              <div className="kgv-empty">
                <div className="kgv-empty-t">{t("pj.kg.emptyTitle")}</div>
                <div className="kgv-empty-s">{t("pj.kg.emptySub")}</div>
                <button type="button" className="hud-btn hud-btn-ghost kg-btn-sm" data-kg-clear onClick={onClearFilter}>
                  {t("pj.kg.clearFilters")}
                </button>
              </div>
            )}
            {view === "success" && (
              <>
                {activeRows.map((n) => rowNode(n))}
                {/* P2③ superseded 折叠组：计数徽标行默认折叠，展开后降档直显
                    （审计路径不动：详情/报告引用跳转仍可选中不可见行） */}
                {supersededRows.length > 0 && (
                  <div className="kgv-sup-group" data-kg-sup-group>
                    <button
                      type="button"
                      className="kgv-sup-toggle"
                      data-kg-sup-toggle
                      aria-expanded={state.supersededOpen}
                      onClick={() => dispatch({ type: "toggle-superseded" })}
                    >
                      {state.supersededOpen
                        ? t("pj.kg.supToggleClose", { n: supersededRows.length })
                        : t("pj.kg.supToggleOpen", { n: supersededRows.length })}
                    </button>
                    {state.supersededOpen && supersededRows.map((n) => rowNode(n))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* T3.2 bootstrap 入口卡（左列底部；准入四态互斥——hidden 静默） */}
          <KgBootstrapEntry
            row={project}
            mode={bootstrapEntryMode(project, bootstrapLaunched)}
            busy={flight !== null}
            t={t}
            onLaunch={onLaunchBootstrap}
            onOpenTasks={onOpenTasks}
          />
        </aside>

        <section className="kgv-main-pane">
          <nav className="kgv-tabs" aria-label={t("pj.kg.tabsAria")}>
            <button
              type="button"
              className={`kgv-tab${state.tab === "detail" ? " active" : ""}`}
              data-tab="detail"
              onClick={() => onTab("detail")}
            >
              {t("pj.kg.tabDetail")}
            </button>
            <button
              type="button"
              className={`kgv-tab${state.tab === "report" ? " active" : ""}`}
              data-tab="report"
              onClick={() => onTab("report")}
            >
              {t("pj.kg.tabReport")}
            </button>
            {/* W2-E kg.health 批第三 tab：体检（概览统计卡 + 问题清单 + 台账 + 任务发起行） */}
            <button
              type="button"
              className={`kgv-tab${state.tab === "health" ? " active" : ""}`}
              data-tab="health"
              onClick={() => onTab("health")}
            >
              {t("pj.health.tab")}
            </button>
          </nav>
          <div className="kgv-pane-scroll">
            <div className="kgv-pane-inner" data-kg-pane={state.tab}>
              {state.tab === "detail" ? (
                <KgDetailPane
                  detail={state.detail}
                  loading={state.detailLoading}
                  byId={byId}
                  onGoto={onSelectNode}
                  onConfirm={onConfirm}
                />
              ) : state.tab === "report" ? (
                <KgReportPane
                  report={state.report}
                  byId={byId}
                />
              ) : (
                <>
                  {/* 体检 tab：概览卡三行（统计/台账/任务发起）+ 问题清单 → 台账面板 */}
                  <KgHealthPane
                    health={healthView.data}
                    loading={healthView.loading}
                    nodeCount={project.nodeCount}
                    reviewBusy={flight !== null}
                    reviewLaunched={reviewLaunched}
                    reviewRunning={project.reviewRunning === true}
                    codeReviewBusy={flight !== null}
                    codeReviewLaunched={codeReviewLaunched}
                    codeReviewRunning={project.codeReviewRunning === true}
                    projectName={project.name}
                    t={t}
                    onLaunchReview={onLaunchReview}
                    onLaunchCodeReview={onLaunchCodeReview}
                    onOpenTasks={onOpenTasks}
                  />
                  <KgCandidatesPanel
                    loading={candView.loading}
                    rows={candView.rows}
                    total={candView.total}
                    filter={candView.filter}
                    sel={candView.sel}
                    t={t}
                    onFilter={onCandFilter}
                    onSelect={onCandSelect}
                  />
                </>
              )}
            </div>
          </div>
        </section>
      </section>
    </>
  );
};

export default KgViewer;
