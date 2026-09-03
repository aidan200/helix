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
import type { EventEnvelope, KgCandidateRowDto, KgHealthDto, KgNodeListRow, KgProjectRow, KgProduceNodeDto } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import {
  createKgViewState,
  filterRows,
  kgReducer,
  pickInitial,
} from "./model/kg-model";
import { bootstrapEntryMode, type ProjectAction, type ProduceState } from "./model/project-model";
import { highlight, KindBadge, StatusBadge } from "./ui/kg-refs";
import KgDetailPane from "./ui/kg-detail-pane";
import KgReportPane from "./ui/kg-report-pane";
import KgIndexPanel from "./ui/kg-index-panel";
import KgBootstrapEntry from "./ui/kg-bootstrap-entry";
import KgHealthPane from "./ui/kg-health-pane";
import KgCandidatesPanel, { type CandFilter } from "./ui/kg-candidates-panel";
import KgProducePane from "./ui/kg-produce-pane";

/** 面板重建轮询间隔（O-6 同主区 building 轮询）。 */
const REBUILD_POLL_MS = 750;

const KgViewer = function KgViewer({
  project,
  produce,
  bootstrapLaunched,
  projectDispatch,
  onOpenTasks,
}: {
  project: KgProjectRow;
  /** 产出呈现区状态（T3.2；ProjectPageState.produce——切项目复位）。 */
  produce: ProduceState;
  /** bootstrap 启动标记（T3.2；bootstrapEntryMode 叠加位）。 */
  bootstrapLaunched: boolean;
  /** projectReducer dispatch（本组件只派发 bootstrap/produce 扩面 action）。 */
  projectDispatch: Dispatch<ProjectAction>;
  /** 「前往『任务』页」出口（入口卡 ok-strip 与产出分组任务详情链接）。 */
  onOpenTasks: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const {
    sendKgList,
    sendKgNodeDetail,
    sendKgChangeReport,
    sendKgNodeConfirm,
    sendKgIndexStatus,
    sendKgBootstrapCreate,
    sendKgBootstrapProduce,
    sendKgNodeUpdate,
    sendKgNodeSupersede,
    sendKgBootstrapImpact,
    sendKgGraphPurge,
    sendKgIndexDelete,
    sendKgHealth,
    sendKgReviewCreate,
    sendCodeReviewCreate,
    sendKgCandidatesList,
    sendKgProjects,
    subscribeKgFrames,
  } = useSession();

  const [state, dispatch] = useReducer(kgReducer, undefined, createKgViewState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** kg-bootstrap 批在途单飞（T3.2）：create 布尔 + update/supersede 携带
   * 关联位（回执零回显——nodeId/name/reason 暂存）。state 驱动钮禁用，
   * ref 镜像供 listener 读取（listener 闭包不随重渲染更新）。
   * C1 扩：purge / indexDelete 两布尔（kg 维护批写面单飞同轨）。 */
  type WriteReq = { kind: "update" | "supersede"; nodeId: string; name: string; reason?: string };
  const [flight, setFlight] = useState<{ create: boolean; write: WriteReq | null; purge: boolean; indexDelete: boolean; review: boolean; codeReview: boolean }>({
    create: false,
    write: null,
    purge: false,
    indexDelete: false,
    review: false,
    codeReview: false,
  });
  const flightRef = useRef(flight);
  flightRef.current = flight;
  /** 体检面板数据面（W2-E；首进 health tab 拉一次——produceFetchedRef 同构）。 */
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
  /** 产出拉取去重（首进 produce tab 发一次；切项目 kgToken 重挂复位）。 */
  const produceFetchedRef = useRef(false);
  /** 产出状态镜像（回调查找节点用；避免回调依赖 produce 身份抖动）。 */
  const produceRef = useRef(produce);
  produceRef.current = produce;

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
            // 默认选中首个现行实体节点（P2③：避开 superseded——列表默认折叠，
            // 首屏详情与列表同观感；全废回落旧序，审计仍可查）。
            // 仅首载（sel 空）应用——转正后 list 刷新不得重置当前选中/详情
            const initial = stateRef.current.sel === null ? pickInitial(nodes) : undefined;
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
              // W2-D R14：手动 sync 后 orphan>0 的体检提示行随 DTO 直渲 toast 副行（只提示不处置）
              toast.push("ok", t("pj.kg.rebuildDoneToast", { symbols: idx.symbolCount ?? 0 }), idx.orphanNote);
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
          // ── kg-bootstrap 批五回执（T3.2；单飞 ref 关联——回执零关联位）──
          case "kg.bootstrap.create.result": {
            if (!flightRef.current.create) return; // 非本视图发起
            setFlight((f) => ({ ...f, create: false }));
            projectDispatch({ type: "bootstrap-launched" });
            toast.push("ok", t("pj.boot.createOkToast", { name: project.name }));
            return;
          }
          case "kg.bootstrap.produce.result":
            projectDispatch({ type: "produce-result", groups: [...e.payload.groups] });
            return;
          case "kg.node.update.result": {
            const req = flightRef.current.write;
            if (req === null || req.kind !== "update" || req.nodeId !== e.payload.node.nodeId) return;
            setFlight((f) => ({ ...f, write: null }));
            const node: KgProduceNodeDto = e.payload.node;
            projectDispatch({ type: "produce-node-updated", node });
            // F4.3 连带刷新：update 成功后重推 impact（只读推导，幂等）
            sendKgBootstrapImpact({ project: project.name, nodeId: node.nodeId });
            toast.push("ok", t("pj.produce.updatedToast", { name: node.name }));
            return;
          }
          case "kg.node.supersede.result": {
            const req = flightRef.current.write;
            if (req === null || req.kind !== "supersede") return;
            setFlight((f) => ({ ...f, write: null }));
            projectDispatch({ type: "produce-node-superseded", nodeId: req.nodeId, reason: req.reason ?? "" });
            sendKgBootstrapImpact({ project: project.name, nodeId: req.nodeId });
            toast.push("ok", t("pj.produce.supersededToast", { name: req.name }));
            return;
          }
          case "kg.bootstrap.impact.result": {
            // 连带标记合并（只标记；count>0 才 toast——零连带不噪找）
            const ids = e.payload.affected.map((a) => a.nodeId);
            projectDispatch({ type: "produce-affected", nodeIds: ids });
            if (e.payload.count > 0) toast.push("ok", t("pj.produce.affectedToast", { n: e.payload.count }));
            return;
          }
          // ── kg 维护批两回执（C1；单飞 ref 关联——回执零关联位）──
          case "kg.graph.purge.result": {
            if (!flightRef.current.purge) return; // 非本视图发起
            setFlight((f) => ({ ...f, purge: false }));
            toast.push("ok", t("pj.kg.purgedToast", { name: project.name, nodes: e.payload.nodesRemoved, symbols: e.payload.symbolsRemoved }));
            // 空态呈现链：列表/报告/索引态/产出四面刷新（产出复位 loading 防陈旧分组残影）
            sendKgList({ project: project.name });
            sendKgChangeReport({ project: project.name });
            sendKgIndexStatus({ project: project.name });
            projectDispatch({ type: "produce-loading" });
            sendKgBootstrapProduce({ project: project.name });
            sendKgProjects(); // 左栏 nodeCount 权威刷新
            return;
          }
          case "kg.index.delete.result": {
            if (!flightRef.current.indexDelete) return;
            setFlight((f) => ({ ...f, indexDelete: false }));
            toast.push("ok", t("pj.kg.idxDeletedToast", { name: project.name }));
            sendKgIndexStatus({ project: project.name }); // 面板 → absent 徽章
            sendKgProjects(); // 左栏徽章权威刷新
            return;
          }
          // ── kg.health 批 + kg 评审批回执（W2-E/W2-F；review 单飞 ref 关联）──
          case "kg.health.result": {
            setHealthView({ loading: false, data: e.payload });
            return;
          }
          case "kg.candidates.list.result": {
            setCandView((v) => ({ loading: false, rows: e.payload.rows, total: e.payload.total, filter: v.filter, sel: v.sel }));
            return;
          }
          case "kg.review.create.result": {
            if (!flightRef.current.review) return; // 非本视图发起
            setFlight((f) => ({ ...f, review: false }));
            setReviewLaunched(true);
            sendKgProjects(); // 行级 reviewRunning 权威化（体检入口运行态数据源）
            toast.push("ok", t("pj.health.reviewOkToast", { name: project.name }));
            return;
          }
          case "code.review.create.result": {
            if (!flightRef.current.codeReview) return; // 非本视图发起
            setFlight((f) => ({ ...f, codeReview: false }));
            setCodeReviewLaunched(true);
            sendKgProjects(); // 行级 codeReviewRunning 权威化（运行态数据源）
            toast.push("ok", t("pj.health.codeReviewOkToast", { name: project.name }));
            return;
          }
          case "connection.error": {
            // bootstrap 入口/写面/维护面在途失败（单飞门控；非在途不消费）
            const msg = (e.payload as { message?: string }).message ?? "error";
            if (flightRef.current.purge) {
              setFlight((f) => ({ ...f, purge: false }));
              toast.push("err", t("pj.kg.purgeFailToast", { message: msg }));
              return;
            }
            if (flightRef.current.indexDelete) {
              setFlight((f) => ({ ...f, indexDelete: false }));
              toast.push("err", t("pj.kg.idxDeleteFailToast", { message: msg }));
              return;
            }
            if (flightRef.current.create) {
              setFlight((f) => ({ ...f, create: false }));
              toast.push("err", t("pj.boot.createFailToast", { message: msg }));
              return;
            }
            if (flightRef.current.review) {
              setFlight((f) => ({ ...f, review: false }));
              toast.push("err", t("pj.health.reviewFailToast", { message: msg }));
              return;
            }
            if (flightRef.current.codeReview) {
              setFlight((f) => ({ ...f, codeReview: false }));
              toast.push("err", t("pj.health.codeReviewFailToast", { message: msg }));
              return;
            }
            if (flightRef.current.write !== null) {
              setFlight((f) => ({ ...f, write: null }));
              toast.push("err", t("pj.produce.writeFailToast", { message: msg }));
            }
            return;
          }
          default:
            return;
        }
      }),
    [subscribeKgFrames, project.name, sendKgNodeDetail, sendKgList, sendKgBootstrapImpact, sendKgChangeReport, sendKgIndexStatus, sendKgBootstrapProduce, sendKgProjects, projectDispatch, toast, t],
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
  const onTab = useCallback((tab: "detail" | "report" | "produce" | "health") => dispatch({ type: "tab", tab }), []);
  const onRebuild = useCallback(() => {
    dispatch({ type: "idx-rebuild-started" });
    sendKgIndexStatus({ project: project.name, rebuild: true });
  }, [project.name, sendKgIndexStatus]);

  // ── kg 维护批写面回调（C1；单飞锁在本视图，Panel 纯展示）──
  const onLaunchPurge = useCallback(() => {
    if (flightRef.current.purge || flightRef.current.indexDelete) return;
    setFlight((f) => ({ ...f, purge: true }));
    if (!sendKgGraphPurge({ project: project.name })) {
      setFlight((f) => ({ ...f, purge: false }));
      toast.push("err", t("pj.boot.sendFail"));
    }
  }, [project.name, sendKgGraphPurge, toast, t]);
  const onLaunchIndexDelete = useCallback(() => {
    if (flightRef.current.purge || flightRef.current.indexDelete) return;
    setFlight((f) => ({ ...f, indexDelete: true }));
    if (!sendKgIndexDelete({ project: project.name })) {
      setFlight((f) => ({ ...f, indexDelete: false }));
      toast.push("err", t("pj.boot.sendFail"));
    }
  }, [project.name, sendKgIndexDelete, toast, t]);

  // ── bootstrap 入口与产出呈现回调（T3.2；单飞锁在本视图，Pane/Entry 纯展示）──
  const writeBusy = flight.write !== null;
  const bootBusy = flight.create || writeBusy;
  const onLaunchBootstrap = useCallback(() => {
    if (flightRef.current.create || flightRef.current.write !== null) return;
    setFlight((f) => ({ ...f, create: true }));
    if (!sendKgBootstrapCreate({ project: project.name })) {
      setFlight((f) => ({ ...f, create: false, write: null }));
      toast.push("err", t("pj.boot.sendFail"));
    }
  }, [project.name, sendKgBootstrapCreate, toast, t]);

  /** 产出节点名查找（supersede 回执零回显——name 暂存用）。 */
  const findProduceNode = useCallback(
    (nodeId: string): KgProduceNodeDto | undefined => {
      for (const g of produceRef.current.groups)
        for (const s of g.stages)
          for (const b of s.batches) {
            const n = b.nodes.find((x) => x.nodeId === nodeId);
            if (n !== undefined) return n;
          }
      return undefined;
    },
    [],
  );
  const onLaunchUpdate = useCallback(
    (nodeId: string, digest: string, body: string) => {
      if (flightRef.current.write !== null || flightRef.current.create) return;
      const name = findProduceNode(nodeId)?.name ?? "";
      setFlight((f) => ({ ...f, write: { kind: "update", nodeId, name } }));
      if (!sendKgNodeUpdate({ project: project.name, nodeId, digest, body })) {
        setFlight((f) => ({ ...f, create: false, write: null }));
        toast.push("err", t("pj.produce.sendFail"));
      }
    },
    [project.name, sendKgNodeUpdate, findProduceNode, toast, t],
  );
  const onLaunchSupersede = useCallback(
    (nodeId: string, reason: string) => {
      if (flightRef.current.write !== null || flightRef.current.create) return;
      const name = findProduceNode(nodeId)?.name ?? "";
      setFlight((f) => ({ ...f, write: { kind: "supersede", nodeId, name, reason } }));
      if (!sendKgNodeSupersede({ project: project.name, nodeId, reason })) {
        setFlight((f) => ({ ...f, create: false, write: null }));
        toast.push("err", t("pj.produce.sendFail"));
      }
    },
    [project.name, sendKgNodeSupersede, findProduceNode, toast, t],
  );

  // produce 拉取（首进 tab 发一次；切项目 kgToken 重挂复位 ref）
  const tab = state.tab;
  useEffect(() => {
    if (tab !== "produce" || produceFetchedRef.current) return;
    produceFetchedRef.current = true;
    projectDispatch({ type: "produce-loading" });
    sendKgBootstrapProduce({ project: project.name });
  }, [tab, project.name, sendKgBootstrapProduce, projectDispatch]);

  // health + 台账拉取（W2-E + 三件套；首进 tab 各发一次，回执经 listener 落本地态）
  useEffect(() => {
    if (tab !== "health" || healthFetchedRef.current) return;
    healthFetchedRef.current = true;
    setHealthView({ loading: true, data: null });
    setCandView((v) => ({ ...v, loading: true }));
    sendKgHealth({ project: project.name });
    sendKgCandidatesList({ project: project.name });
  }, [tab, project.name, sendKgHealth, sendKgCandidatesList]);

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

  // ── kg.review.create 发起（W2-F；单飞锁在本视图，Pane 纯展示）──
  const onLaunchReview = useCallback(() => {
    if (flightRef.current.review) return;
    setFlight((f) => ({ ...f, review: true }));
    if (!sendKgReviewCreate({ project: project.name })) {
      setFlight((f) => ({ ...f, review: false }));
      toast.push("err", t("pj.boot.sendFail"));
    }
  }, [project.name, sendKgReviewCreate, toast, t]);

  // ── code.review.create 发起（code-review v1.5；单飞锁在本视图）──
  const onLaunchCodeReview = useCallback(() => {
    if (flightRef.current.codeReview) return;
    setFlight((f) => ({ ...f, codeReview: true }));
    if (!sendCodeReviewCreate({ project: project.name })) {
      setFlight((f) => ({ ...f, codeReview: false }));
      toast.push("err", t("pj.boot.sendFail"));
    }
  }, [project.name, sendCodeReviewCreate, toast, t]);

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
        <KgIndexPanel idx={state.idx} rebuilding={state.idxRebuilding} onRebuild={onRebuild} onDelete={onLaunchIndexDelete} deleting={flight.indexDelete} />
        <button
          type="button"
          className="hud-btn hud-btn-danger kg-btn-sm"
          data-kg-purge
          disabled={flight.purge || purgeOpen}
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
              disabled={flight.purge}
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
            busy={bootBusy}
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
            {/* T3.2 kg-bootstrap 批新增第三 tab：产出呈现（无审阅进度无待审计数） */}
            <button
              type="button"
              className={`kgv-tab${state.tab === "produce" ? " active" : ""}`}
              data-tab="produce"
              onClick={() => onTab("produce")}
            >
              {t("pj.produce.tab")}
            </button>
            {/* W2-E kg.health 批第四 tab：体检（五项读面只列不修 + 轨二发起入口） */}
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
              ) : state.tab === "health" ? (
                <>
                  <KgHealthPane
                    health={healthView.data}
                    loading={healthView.loading}
                    reviewBusy={flight.review}
                    reviewLaunched={reviewLaunched}
                    reviewRunning={project.reviewRunning === true}
                    codeReviewBusy={flight.codeReview}
                    codeReviewLaunched={codeReviewLaunched}
                    codeReviewRunning={project.codeReviewRunning === true}
                    projectName={project.name}
                    candFilter={candView.filter}
                    t={t}
                    onCandFilter={onCandFilter}
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
              ) : (
                <KgProducePane
                  produce={produce}
                  writeBusy={writeBusy}
                  t={t}
                  onOpenTasks={onOpenTasks}
                  onToggle={(nodeId) => projectDispatch({ type: "produce-toggle-node", nodeId })}
                  onInlineOpen={(kind, nodeId) => projectDispatch({ type: "produce-inline-open", kind, nodeId })}
                  onInlineClose={() => projectDispatch({ type: "produce-inline-close" })}
                  onLaunchUpdate={onLaunchUpdate}
                  onLaunchSupersede={onLaunchSupersede}
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
