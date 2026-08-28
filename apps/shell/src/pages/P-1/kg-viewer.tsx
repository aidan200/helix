/**
 * P-1 KgViewer —— graph 态图谱视图组件（F5.1~F5.5；主区 graph 分量，
 * 组件而非路由——V-3 单页裁决）。
 *
 * 每次进入 graph（含切项目）由 ProjectPage 以 key=kgToken 强制重挂 =
 * 新数据面：过滤/选中/报告决定/索引面板态全清空（防跨项目骨架竞态）。
 * 内部结构 = 主区顶部项目上下文（「知识图谱 · 项目名」+只读/迭代 chip，
 * 纯标识无返回无导航）+ 左列 380px（搜索/三路过滤/节点列表/底部索引
 * 面板）+ 右区「节点详情 | 变化报告」双 tab。
 *
 * 数据面（五图谱命令，全部带 project = 当前选中项目）：
 * - kg.list 一次性拉全量 → 客户端三路过滤（原型同型即时交互；命令契约
 *   的 q/kind/status 参数不因此收窄）；
 * - kg.node.detail（默认选中首个实体节点——mock 数据面 E-9 先例）；
 * - kg.change.report（tab 待决计数徽章数据源；迭代 chip 取 iterationId）；
 * - kg.index.status（面板起步态；degraded「重新构建」→ rebuild:true 轮询）；
 * - kg.node.confirm（页面唯一写：draft 两步确认后发送；回执翻转列表行
 *   +重发 detail 取 daemon 落账日志）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { EventEnvelope, KgProjectRow } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import {
  createKgViewState,
  filterRows,
  kgReducer,
  pendingCount,
} from "./model/kg-model";
import { highlight, KindBadge, StatusBadge } from "./ui/kg-refs";
import KgDetailPane from "./ui/kg-detail-pane";
import KgReportPane from "./ui/kg-report-pane";
import KgIndexPanel from "./ui/kg-index-panel";

/** 面板重建轮询间隔（O-6 同主区 building 轮询）。 */
const REBUILD_POLL_MS = 750;

const KgViewer = function KgViewer({ project }: { project: KgProjectRow }) {
  const { t } = useI18n();
  const toast = useToast();
  const {
    sendKgList,
    sendKgNodeDetail,
    sendKgChangeReport,
    sendKgNodeConfirm,
    sendKgIndexStatus,
    subscribeKgFrames,
  } = useSession();

  const [state, dispatch] = useReducer(kgReducer, undefined, createKgViewState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // 进入 graph 即新数据面：列表骨架 + 详情骨架 + 报告/索引面板并行拉取
  useEffect(() => {
    sendKgList({ project: project.name });
    sendKgChangeReport({ project: project.name });
    sendKgIndexStatus({ project: project.name });
  }, [project.name, sendKgList, sendKgChangeReport, sendKgIndexStatus]);

  // kg 族点对点回执消费（页面私有 reducer）
  useEffect(
    () =>
      subscribeKgFrames((e: EventEnvelope) => {
        switch (e.type) {
          case "kg.list.result": {
            const nodes = [...e.payload.nodes];
            // 默认选中首个实体节点（原型 E-9 先例：进入即见失效锚点详情）。
            // 仅首载（sel 空）应用——转正后 list 刷新不得重置当前选中/详情
            const initial =
              stateRef.current.sel === null ? (nodes.find((n) => n.kind === "entity") ?? nodes[0]) : undefined;
            dispatch({ type: "list-result", total: e.payload.total, nodes, initialSel: initial?.id });
            if (initial !== undefined) sendKgNodeDetail({ project: project.name, id: initial.id });
            return;
          }
          case "kg.node.detail.result":
            dispatch({ type: "detail-result", detail: e.payload });
            return;
          case "kg.change.report.result":
            dispatch({ type: "report-result", report: e.payload });
            return;
          case "kg.index.status.result": {
            const wasRebuilding = stateRef.current.idxRebuilding;
            const idx = e.payload;
            dispatch({ type: "idx-result", idx });
            if (wasRebuilding && (idx.state === "synced" || idx.state === "degraded")) {
              toast.push("ok", t("pj.kg.rebuildDoneToast", { symbols: idx.symbolCount ?? 0 }));
            }
            return;
          }
          case "kg.node.confirm.result": {
            // 翻转后状态回读：列表行刷新 + 重发 detail（daemon 已落转正日志）
            dispatch({ type: "confirm-applied", id: e.payload.node.id, status: e.payload.node.status });
            sendKgNodeDetail({ project: project.name, id: e.payload.node.id });
            sendKgList({ project: project.name });
            toast.push("ok", t("pj.kg.promoteToast", { name: e.payload.node.name }));
            return;
          }
          default:
            return;
        }
      }),
    [subscribeKgFrames, project.name, sendKgNodeDetail, sendKgList, toast],
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
  const onTab = useCallback((tab: "detail" | "report") => dispatch({ type: "tab", tab }), []);
  const onResolve = useCallback((index: number, value: string) => dispatch({ type: "resolve", index, value }), []);
  const onUnresolve = useCallback((index: number) => dispatch({ type: "unresolve", index }), []);
  const onRebuild = useCallback(() => {
    dispatch({ type: "idx-rebuild-started" });
    sendKgIndexStatus({ project: project.name, rebuild: true });
  }, [project.name, sendKgIndexStatus]);

  // ── 展示派生 ─────────────────────────────────────────────
  const rows = useMemo(() => filterRows(state.all, state.filter), [state.all, state.filter]);
  /** 主状态派生：全量未到 = loading；过滤无匹配 = empty（即时重渲染，转换干净）。 */
  const view = state.view === "loading" ? "loading" : rows.length === 0 ? "empty" : "success";
  const byId = useMemo(() => new Map(state.all.map((n) => [n.id, n])), [state.all]);
  const pending = pendingCount(state.report, state.resolved);

  return (
    <>
      {/* F5.0 graph 态项目上下文：纯标识、无返回、无导航（FID-31） */}
      <div className="kgv-head" data-kg-head>
        <span className="kgv-title">{t("pj.kg.headTitle", { name: project.name })}</span>
        <span className="hud-chip">{t("pj.kg.readonlyChip")}</span>
        {state.report !== null && <span className="hud-chip">{state.report.iterationId}</span>}
      </div>
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
            {view === "empty" && (
              <div className="kgv-empty">
                <div className="kgv-empty-t">{t("pj.kg.emptyTitle")}</div>
                <div className="kgv-empty-s">{t("pj.kg.emptySub")}</div>
                <button type="button" className="hud-btn hud-btn-ghost kg-btn-sm" data-kg-clear onClick={onClearFilter}>
                  {t("pj.kg.clearFilters")}
                </button>
              </div>
            )}
            {view === "success" &&
              rows.map((n) => (
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
              ))}
          </div>

          <KgIndexPanel idx={state.idx} rebuilding={state.idxRebuilding} onRebuild={onRebuild} />
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
              <span
                className={`hud-badge ${pending > 0 ? "st-draft" : "st-confirmed"}`}
                data-kg-report-count
              >
                {pending > 0
                  ? t("pj.kg.reportPending", { n: pending })
                  : state.report !== null
                    ? t("pj.kg.reportCleared")
                    : ""}
              </span>
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
              ) : (
                <KgReportPane
                  report={state.report}
                  resolved={state.resolved}
                  byId={byId}
                  onGoto={onSelectNode}
                  onResolve={onResolve}
                  onUnresolve={onUnresolve}
                />
              )}
            </div>
          </div>
        </section>
      </section>
    </>
  );
};

export default KgViewer;
