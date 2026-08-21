/**
 * P-1 TracePage —— 事件追溯页（CL-5；T2.2；S3b 迁 AppLayout）：执行
 * 全貌双视图（sidebar 下=实例列表 + 主列：实例详情时顶部执行上下文卡 +
 * 事件流时间轴），主列顶部组合过滤控制条（类型 chips / 时间范围）。
 * 壳 = AppLayout 统一应用壳（S1 布局契约）：headerLeft = 页名；
 * sidebar = TraceSidebar 上下分区（上=会话列表 / 下=选中会话实例列表，
 * 各自独立内滚）；children = .p1-col 主列（控制条 + 主区 + 断连 overlay）。
 *
 * 数据通道（连接私有读面，AG-15：页面私有 reducer，不进 session store）：
 * - 发送：sendTraceQuery（trace.query，单飞 + filterEcho 迟到结果丢弃）；
 * - 消费：subscribeTraceFrames 注册 trace.query.result / connection.error
 *   （SessionContext 转发层；dispatcher 侧保持 no-op 注册守护绿）；
 * - 会话清单：topology.list（复用；清单空且 connected 时才 requestSessionList，
 *   「未请求态才发」门控）。
 *
 * 状态模型（review.md §四）：loading / error / empty / success 互斥 +
 * 断连 overlay 正交；任何新查询先清旧态；重连后重查（filter 域重查，
 * 面板保留防闪烁）。
 *
 * 视觉与行为基准 = prototype/P-1-trace.html（还原清单见 review.md §四
 * 「必须还原」8 项）；风格 token 零 delta（hud-* 类名 + CSS 变量，
 * trace.css 零硬编码 hex）。scanline 氛围层 = App.tsx 全局单份（S1 上提，
 * 页内副本 S3b 清理）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { EventEnvelope, TraceQueryResultPayload } from "@helix/protocol";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import {
  TRACE_TYPE_CATEGORIES,
  buildTraceQuery,
  createTracePageState,
  selectTraceView,
  toggleTypeCategory,
  traceReducer,
  type TraceFilter,
} from "./model/trace-model";
import TraceControls from "./ui/P-1-trace-controls";
import TraceSidebar from "./ui/TraceSidebar";
import ContextCard from "./ui/P-1-context-card";
import EventTable from "./ui/P-1-event-table";
import { ConnOverlay, EmptyPane, ErrorPane, TableSkeleton } from "./ui/P-1-state-panes";

const TracePage = function TracePage({ path }: { path: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const {
    state: session,
    topology,
    requestSessionList,
    retry,
    sendTraceQuery,
    subscribeTraceFrames,
  } = useSession();
  const conn = session.conn;

  const [state, dispatch] = useReducer(traceReducer, undefined, createTracePageState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 查询主链：构造 payload+echo（同产防漂移）→ 先置 loading 清旧态 → 发送；
   *  发送失败（未连接）即落 error 态。beforeId 非空 = 分页追加（不收口视图）。 */
  const runQuery = useCallback(
    (filter: TraceFilter, beforeId: number | null, scope: "session" | "filter") => {
      const built = buildTraceQuery(filter, stateRef.current.latestEventTs, beforeId);
      dispatch(
        beforeId === null
          ? { type: "query-started", filter, echo: built.echo, scope }
          : { type: "page-started", echo: built.echo },
      );
      if (!sendTraceQuery(built.payload)) {
        dispatch({ type: "query-failed", reason: t("trace.state.notConnected") });
      }
    },
    [sendTraceQuery, t],
  );

  // 点对点回执消费（页面私有 reducer；AG-15 不进 session store）
  useEffect(
    () =>
      subscribeTraceFrames((e: EventEnvelope) => {
        if (e.type === "trace.query.result") {
          const p = (e as { payload: TraceQueryResultPayload }).payload;
          dispatch({
            type: "query-result",
            echo: p.filterEcho,
            instances: p.instances,
            rows: p.events,
            page: p.page,
          });
        } else if (e.type === "connection.error") {
          // 在途查询失败（单飞：reducer 内 pending 为空则忽略；追加失败保内容）
          const p = (e as { payload: { message?: string } }).payload;
          dispatch({ type: "query-failed", reason: p?.message ?? "connection.error" });
        }
      }),
    [subscribeTraceFrames],
  );

  /** 会话解析：已选合法 → 保持；否则活跃会话优先，回落清单首条（最新）。 */
  const resolvedSessionId = useMemo(() => {
    const cur = state.filter.sessionId;
    if (cur !== "" && topology.list.some((s) => s.sessionId === cur)) return cur;
    const active = session.sessionId;
    if (active !== null && topology.list.some((s) => s.sessionId === active)) return active;
    return topology.list[0]?.sessionId ?? null;
  }, [state.filter.sessionId, session.sessionId, topology.list]);

  // 会话清单拉取（未请求态才发）+ 进页/重连自动查询
  const requestedListRef = useRef(false);
  const prevConnRef = useRef(conn);
  const autoStartedRef = useRef<string | null>(null); // 进页自动单飞去重（StrictMode 双效应）
  useEffect(() => {
    const prevConn = prevConnRef.current;
    prevConnRef.current = conn;
    if (conn !== "connected") return;
    if (topology.list.length === 0) {
      if (!requestedListRef.current) {
        requestedListRef.current = true;
        requestSessionList();
      }
      return;
    }
    const cur = stateRef.current;
    if (resolvedSessionId !== null && resolvedSessionId !== cur.filter.sessionId) {
      // 进页首查 / 当前会话从清单消失（删除等）回落重选：session 域全量重置
      if (cur.filter.sessionId === "" && autoStartedRef.current === resolvedSessionId) return;
      if (cur.filter.sessionId === "") autoStartedRef.current = resolvedSessionId;
      runQuery(
        { sessionId: resolvedSessionId, instanceId: null, types: null, rangeSec: null },
        null,
        "session",
      );
      return;
    }
    if (prevConn !== "connected" && cur.filter.sessionId !== "") {
      // 重连后重查（filter 域：面板保留防闪烁，结果帧到达整体刷新）
      runQuery(cur.filter, null, "filter");
      toast.push("ok", t("trace.state.reconnectedToast"));
    }
  }, [conn, resolvedSessionId, topology.list.length, requestSessionList, runQuery, toast, t]);

  // ── 控制条交互（任何筛选变更 = 新查询：清旧态 + 游标/展开/折叠重置）──
  // 会话选择入口在 TraceSidebar 上分区（S3b；session 域全量重置）
  const onSelectSession = useCallback(
    (sessionId: string) => {
      if (sessionId === stateRef.current.filter.sessionId) return;
      runQuery({ sessionId, instanceId: null, types: null, rangeSec: null }, null, "session");
    },
    [runQuery],
  );

  const onSelectInstance = useCallback(
    (instanceId: string | null) => {
      const cur = stateRef.current;
      if (cur.filter.instanceId === instanceId) return;
      runQuery({ ...cur.filter, instanceId }, null, "filter");
    },
    [runQuery],
  );

  /** 类型 chip：plain 点击 = 单选该类目（再点回全量）；modifier 点击 = 集合 toggle 多选。 */
  const onToggleChip = useCallback(
    (key: string, multi: boolean) => {
      const cur = stateRef.current;
      const cat = TRACE_TYPE_CATEGORIES.find((c) => c.key === key);
      if (cat === undefined) return;
      let types: string[] | null;
      if (multi) {
        types = toggleTypeCategory(cur.filter.types, cat);
      } else {
        const cur2 = cur.filter.types;
        const solo =
          cur2 !== null &&
          cur2.length === cat.types.length &&
          cat.types.every((x) => cur2.includes(x));
        types = solo ? null : [...cat.types];
      }
      runQuery({ ...cur.filter, types }, null, "filter");
    },
    [runQuery],
  );

  const onSelectRange = useCallback(
    (rangeSec: number | null) => {
      const cur = stateRef.current;
      if (cur.filter.rangeSec === rangeSec) return;
      runQuery({ ...cur.filter, rangeSec }, null, "filter");
    },
    [runQuery],
  );

  const onRetry = useCallback(
    () => runQuery(stateRef.current.filter, null, "filter"),
    [runQuery],
  );

  const onLoadMore = useCallback(() => {
    const cur = stateRef.current;
    if (cur.loadingMore || !cur.hasMore || cur.events.length === 0) return;
    runQuery(cur.filter, cur.events[cur.events.length - 1]!.id, "filter");
  }, [runQuery]);

  // ── 展示派生 ─────────────────────────────────────────────
  const view = selectTraceView(state);
  const detail = state.filter.instanceId !== null;
  const connOff = conn === "disconnected" || conn === "error";
  const selectedRecord = detail
    ? state.instances.find((r) => r.instanceId === state.filter.instanceId) ?? null
    : null;
  // running 实例时长参考点：会话最新事件 ts（未知 = 组件侧 now）
  const refMs = state.latestEventTs !== null ? Date.parse(state.latestEventTs) : Date.now();

  return (
    <AppLayout
      headerLeft={<h1 className="p1-title">{t("trace.title")}</h1>}
      sidebar={
        <TraceSidebar
          sessions={topology.list}
          sessionId={state.filter.sessionId !== "" ? state.filter.sessionId : (resolvedSessionId ?? "")}
          instances={state.instances}
          selectedInstance={state.filter.instanceId}
          loading={view === "loading"}
          refMs={refMs}
          onSelectSession={onSelectSession}
          onSelectInstance={onSelectInstance}
        />
      }
    >
      {/* S3b：壳归 AppLayout（header 页名 / sidebar 上下分区）；
          .p1-col = 主列（断言锚 data-trace-page 随主列） */}
      <div className="p1-col" data-trace-page={path}>
        <TraceControls
          rangeSec={state.filter.rangeSec}
          types={state.filter.types}
          onSelectRange={onSelectRange}
          onToggleChip={onToggleChip}
        />

        <div className="p1-main">
          {/* F5.2 上下文卡：仅实例详情视图；error 隐藏 / empty 保留 / loading 骨架化 */}
          {detail && view !== "error" && selectedRecord !== null && (
            <ContextCard
              record={selectedRecord}
              loading={view === "loading"}
              promptOpen={state.promptOpen}
              onTogglePrompt={() => dispatch({ type: "toggle-prompt" })}
              events={state.events}
              refMs={refMs}
            />
          )}

          <div className="hud-card p1-table-card">
            <EventTable
              events={state.events}
              instances={state.instances}
              total={state.total}
              hasMore={state.hasMore}
              loadingMore={state.loadingMore}
              success={view === "success"}
              openId={state.openId}
              detail={detail}
              mainName={t("trace.panel.mainName")}
              onToggleRow={(id) => dispatch({ type: "toggle-row", id })}
              onLoadMore={onLoadMore}
            />
            {/* 五态互斥：loading / empty / error 恰一（success 在 EventTable 内） */}
            {(view === "loading" || view === "idle") && <TableSkeleton detail={detail} />}
            {view === "empty" && <EmptyPane flavor={state.emptyFlavor} />}
            {view === "error" && <ErrorPane reason={state.errorReason} onRetry={onRetry} />}
          </div>
        </div>

        {/* 断连 overlay：正交层（压住主列，重连入口） */}
        {connOff && <ConnOverlay onReconnect={retry} />}
      </div>
    </AppLayout>
  );
};

export default TracePage;
