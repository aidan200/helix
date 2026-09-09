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
 *   （SessionContext 转发层；dispatcher 侧保持 no-op 注册守护绿）。
 *   connection.error 归因（M10 批⑦）：错误帧无 echo 关联——daemon
 *   trace.query handler 同步处理 + 单连接有序（回执按请求序到达，tasks
 *   artifacts T4.3 先例），页面持在途查询代 FIFO：错误帧出队最老在途代
 *   归因，reducer query-failed 只清当前代（旧查询错误回执不误伤新查询）；
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
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { EventEnvelope, SessionMeta, TaskSummaryDto, TraceQueryResultPayload } from "@helix/protocol";
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
    sendTaskList,
    subscribeTaskFrames,
  } = useSession();
  const conn = session.conn;

  const [state, dispatch] = useReducer(traceReducer, undefined, createTracePageState);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 任务会话清单（task.list 拉取；task:<jobId> 会话与 chat 会话同栏可选——
   *  任务批次/编排事件落 domain_events 同表，trace.query 直查无需 daemon 改动）。 */
  const [tasks, setTasks] = useState<readonly TaskSummaryDto[]>([]);

  /** 在途查询代 FIFO（M10 批⑦ connection.error 归因）：请求成功发出才入队；
   *  回执（结果帧/错误帧）按请求序到达——出队最老在途代对号（T4.3 先例）。 */
  const queryGensRef = useRef<number[]>([]);
  /** 查询代计数器（页面侧单调递增；随 query-started/page-started 注入 reducer）。 */
  const nextGenRef = useRef(1);

  /** 查询主链：构造 payload+echo（同产防漂移）→ 先置 loading 清旧态 → 发送；
   *  发送失败（未连接）即落 error 态。beforeId 非空 = 分页追加（不收口视图）。 */
  const runQuery = useCallback(
    (filter: TraceFilter, beforeId: number | null, scope: "session" | "filter") => {
      const built = buildTraceQuery(filter, stateRef.current.latestEventTs, beforeId);
      const gen = nextGenRef.current++;
      dispatch(
        beforeId === null
          ? { type: "query-started", filter, echo: built.echo, generation: gen, scope }
          : { type: "page-started", echo: built.echo, generation: gen },
      );
      if (!sendTraceQuery(built.payload)) {
        // 未发出：不入 FIFO——以本查询代直接收口（reducer 当前代 = 本查询）
        dispatch({ type: "query-failed", generation: gen, reason: t("trace.state.notConnected") });
        return;
      }
      queryGensRef.current.push(gen); // 发送成功才入队在途关联
    },
    [sendTraceQuery, t],
  );

  // 点对点回执消费（页面私有 reducer；AG-15 不进 session store）
  useEffect(
    () =>
      subscribeTraceFrames((e: EventEnvelope) => {
        if (e.type === "trace.query.result") {
          queryGensRef.current.shift(); // 最老在途已应答（FIFO 对号）
          const p = (e as { payload: TraceQueryResultPayload }).payload;
          dispatch({
            type: "query-result",
            echo: p.filterEcho,
            instances: p.instances,
            rows: p.events,
            page: p.page,
          });
        } else if (e.type === "connection.error") {
          // M10 批⑦：跨命令归因——daemon commandError 消息尾缀「（命令 <type>）」
          // 固定格式（WsServerAdapter.commandError 单一构造点）：可辨识且非
          // trace.query 的错误帧不进 FIFO（留给其本族消费面，不同页/同页其他
          // 命令错误不误伤在途查询）；无尾缀（旧 daemon 容忍）按可能本族处理
          const p = (e as { payload: { message?: string } }).payload;
          const message = p?.message ?? "connection.error";
          // 尾缀 = fullwidth parens + 「命令」二字 + type（字面 CJK 经 unicode
          // 转义书写——AG-16 组件源码零硬编码 CJK 纪律覆盖正则字面）
          const cmd = /\uFF08\u547D\u4EE4 ([\w.]+)\uFF09\s*$/.exec(message)?.[1];
          if (cmd !== undefined && cmd !== "trace.query") return;
          // 在途查询失败：FIFO 出队最老在途代归因（回执按请求序到达），
          // reducer 只清当前代——旧查询的错误回执不清新查询 pending 不落 error
          const gen = queryGensRef.current.shift();
          if (gen === undefined) return; // 无在途：非本页/迟到错误帧不消费
          dispatch({ type: "query-failed", generation: gen, reason: message });
        }
      }),
    [subscribeTraceFrames],
  );

  // task 族帧消费：task.list.result → 任务会话清单（点对点回执，协议窄化
  // 接口——EventEnvelope 联合外宽松判别，TasksPage 先例同构）；task.changed
  // （job 级）→ 重拉清单——停留 trace 页期间新建/状态翻转的任务会话
  // 侧栏分组与 runState 不陈旧（O-7 轻负载：只重拉 list）
  useEffect(
    () =>
      subscribeTaskFrames((envelope: EventEnvelope) => {
        const e = envelope as { type: string; payload: unknown };
        if (e.type === "task.list.result") {
          setTasks([...(e.payload as { tasks: readonly TaskSummaryDto[] }).tasks]);
          return;
        }
        if (e.type === "task.changed" && (e.payload as { changed?: string }).changed === "job") {
          sendTaskList();
        }
      }),
    [subscribeTaskFrames, sendTaskList],
  );

  /** 会话解析：已选合法 → 保持；否则活跃会话优先，回落清单首条（最新）。
   *  mergedSessions（任务排前 + chat 会话）仅供解析/回落，默认加载逻辑不动；
   *  侧栏呈现拆组（任务/会话两组）见 taskMetas 传递。 */
  const taskMetas = useMemo<readonly SessionMeta[]>(() => {
    // 任务会话映射为 SessionMeta 形态（runState 按 job.status 映射；
    // loaded=false——任务会话不在会话注册表，恒冷会话）
    return tasks.map((tk) => ({
      sessionId: `task:${tk.jobId}`,
      title: tk.title,
      lastActivityAt: Date.parse(tk.updatedAt),
      runState: tk.status === "running" || tk.status === "paused" ? "subagent_running" : "idle",
      loaded: false,
    }));
  }, [tasks]);
  const mergedSessions = useMemo<readonly SessionMeta[]>(
    () => [...taskMetas, ...topology.list],
    [taskMetas, topology.list],
  );
  /** 任务会话类型徽章查表（sessionId → 任务类型；TraceSidebar 徽章数据源）。 */
  const taskKinds = useMemo<ReadonlyMap<string, string>>(
    () => new Map(tasks.map((tk) => [`task:${tk.jobId}`, tk.type])),
    [tasks],
  );
  const resolvedSessionId = useMemo(() => {
    const cur = state.filter.sessionId;
    if (cur !== "" && mergedSessions.some((s) => s.sessionId === cur)) return cur;
    const active = session.sessionId;
    if (active !== null && topology.list.some((s) => s.sessionId === active)) return active;
    return mergedSessions[0]?.sessionId ?? null;
  }, [state.filter.sessionId, session.sessionId, mergedSessions, topology.list]);

  // 会话清单拉取（未请求态才发）+ 进页/重连自动查询
  const requestedListRef = useRef(false);
  const prevConnRef = useRef(conn);
  const autoStartedRef = useRef<string | null>(null); // 进页自动单飞去重（StrictMode 双效应）
  useEffect(() => {
    const prevConn = prevConnRef.current;
    prevConnRef.current = conn;
    if (conn !== "connected") {
      // M42：断连清「已请求」位——旧连接的回执不可能再到达，不清位则首次
      // 请求失败后清单永不重拉；重连转换后按未请求态重发
      requestedListRef.current = false;
      queryGensRef.current = []; // 断连死在途清空（旧连接回执不可能再到达）
      return;
    }
    if (topology.list.length > 0) requestedListRef.current = false; // M42：拉取成功复位（后续清空可重拉）
    sendTaskList(); // 任务会话清单（首挂/重连重拉）
    if (resolvedSessionId === null) {
      // 解析后仍无会话（chat+任务均空）才 early return——旧实现只看
      // topology.list：工作空间零 chat 会话但有任务会话时（mergedSessions
      // 已含 task:*，任务排前）resolvedSessionId 非空却永不自动查询，页面
      // 卡 idle 骨架（W3 #2.33 修复）；chat 清单未拉过则顺手发首拉
      if (topology.list.length === 0 && !requestedListRef.current) {
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
  }, [conn, resolvedSessionId, topology.list.length, requestSessionList, runQuery, toast, t, sendTaskList]);

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
          taskSessions={taskMetas}
          taskKinds={taskKinds}
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
