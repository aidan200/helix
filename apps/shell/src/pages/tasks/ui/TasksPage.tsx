/**
 * P-2 TasksPage —— 任务页（列表 + 详情全状态；T3.1，CL-3 F3.1~F3.6 +
 * CL-1.A7 零创建）。
 *
 * 结构（AppLayout 壳，四槽契约）：headerLeft = 「任务」页名；headerRight 无
 * （主题切换归全局导航栏 IconRail 单钮，页面级不重复）；sidebar = 左栏
 * 380px 任务列表
 * （状态 seg + 项目 seg 过滤 / 全局平铺运行中置顶）；children = 右区详情
 * （头 + 进度/任务结果双 tab）。全局导航（会话/项目/任务）由 IconRail
 * 页面域承载（R-1 壳层口径）。
 *
 * 数据面（连接私有读面，AG-15 页面私有 reducer 不进 session store）：
 * - 九命令族（contracts/task-api.md）：task.subscribe（连接级订阅，重连
 *   重发——TR-AD-5 daemon 不持跨连接订阅）+ task.list 驱动左栏；
 *   task.detail 驱动进度 tab；task.artifacts 驱动结果 tab；pause/resume/
 *   cancel/delete 生命周期写面（单飞锁 + 两步确认在详情头组件）；
 * - task.changed（O-7 逐迁移轻负载）：changed=job → 重拉 list+detail；
 *   changed=stage/batch/work_item → 仅当选中时重拉 detail（重拉不带
 *   loading 闪——列表行就地刷新）；
 * - connection.error：生命周期命令在途时消费（lifecycleReqRef 单飞关联，
 *   trace 先例）。
 *
 * 零创建（AD-2）：任何状态无创建入口；空态指路宿主（「项目」页/会话）。
 * 已知边界：detail/artifacts 回执无 jobId 回显（契约零成本 DTO 取向），
 * 在途请求靠 ref 关联（detail 单点去重 / artifacts FIFO 对号，T4.3）+
 * reducer jobId 校验丢弃迟到帧。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  EventEnvelope,
  TaskArtifactsResultPayload,
  TaskChangedPayload,
  TaskDetailResultPayload,
  TaskLifecycleResultPayload,
  TaskListResultPayload,
  TaskStatus,
} from "@helix/protocol";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import {
  createTasksPageState,
  selectListView,
  tasksReducer,
  type TaskLifecycleAction,
} from "../model/tasks-model";
import TaskListPane from "./P-2-task-list";
import TaskDetailHead from "./P-2-task-detail";
import TaskProgressPane from "./P-2-task-progress";
import TaskResultPane from "./P-2-task-result";
import { EmptyPanel, TaskSkeleton } from "./P-2-task-atoms";

const TasksPage = function TasksPage({ path, onOpenProject }: { path: string; onOpenProject: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const {
    state: session,
    sendTaskList,
    sendTaskDetail,
    sendTaskArtifacts,
    sendTaskSubscribe,
    sendTaskPause,
    sendTaskResume,
    sendTaskRetry,
    sendTaskCancel,
    sendTaskDelete,
    subscribeTaskFrames,
    subscribeWorkspaceFrames,
  } = useSession();
  const conn = session.conn;

  const [state, dispatch] = useReducer(tasksReducer, undefined, createTasksPageState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 生命周期在途命令关联（回执无 jobId 回显——ref 单点关联，trace 先例）。 */
  const lifecycleReqRef = useRef<{ kind: TaskLifecycleAction; jobId: string } | null>(null);
  /** artifacts 在途 FIFO 关联（T4.3）：回执无 jobId 回显——请求时记 jobId
   *  入队，回执按序出队对号（daemon handler 同步处理 + 单连接有序，回执按
   *  请求序到达）；空队 = 无在途，迟到/非本页回执丢弃。不得以 cur.selected
   *  回填——产物在途时切任务，迟到回执以请求时 jobId 派发，reducer 归属
   *  校验作第二道防线。 */
  const artifactsReqRef = useRef<string[]>([]);
  /** 详情拉取单次去重（选中未变不重发——订阅回调身份不稳时防重发）。 */
  const detailFetchedRef = useRef<string | null>(null);

  // realtime tick：存在 running/paused 任务时 1s 步进（时长行；纯信息量非动效）
  const [now, setNow] = useState(() => Date.now());
  const ticking = state.tasks.some((x) => x.status === "running" || x.status === "paused");
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  // 连接就绪（首挂/重连）：task.subscribe（连接级订阅重建）+ task.list 首拉；
  // 重连时选中详情一并重拉（断连期间 daemon 侧可能已推进）
  const prevConnRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = conn;
    if (conn === "connected" && prev !== "connected") {
      artifactsReqRef.current = []; // 断连死在途清空（旧连接回执不可能再到达）
      sendTaskSubscribe();
      sendTaskList();
      const jobId = stateRef.current.selected;
      if (jobId !== null) {
        detailFetchedRef.current = null;
        dispatch({ type: "detail-loading", jobId });
        sendTaskDetail({ jobId });
      }
    }
  }, [conn, sendTaskSubscribe, sendTaskList, sendTaskDetail]);

  // workspace_changed 刷新链（W4；ProjectPage 先例）：任务域随新工作空间作废
  useEffect(
    () =>
      subscribeWorkspaceFrames((e) => {
        if (e.type !== "workspace_changed") return;
        dispatch({ type: "workspace-reset" });
        sendTaskList();
      }),
    [subscribeWorkspaceFrames, sendTaskList],
  );

  // task 族帧消费（页面私有 reducer；AG-15 不进 session store）。
  // 帧形状注：task.*.result 点对点回执是协议窄化接口（不入 EVENT_TYPES
  // 目录，契约 §0 计数纪律）——EventEnvelope 联合外，听众内经宽松形状
  // 判别 + payload 类型断言（kg 先例同构）。
  useEffect(
    () =>
      subscribeTaskFrames((envelope: EventEnvelope) => {
        const e = envelope as { type: string; payload: unknown };
        const cur = stateRef.current;
        if (e.type === "task.list.result") {
          dispatch({ type: "list-result", tasks: [...(e.payload as TaskListResultPayload).tasks] });
          return;
        }
        if (e.type === "task.detail.result") {
          dispatch({ type: "detail-result", task: (e.payload as TaskDetailResultPayload).task });
          return;
        }
        if (e.type === "task.artifacts.result") {
          // 在途 FIFO 对号（T4.3）：取请求时记录的 jobId 派发，不取
          // cur.selected——产物在途时切任务，A 的迟到回执不得以新选中
          // 落库；reducer 的 selected!==jobId 校验作第二道防线丢弃
          const jobId = artifactsReqRef.current.shift();
          if (jobId === undefined) return; // 无在途：迟到/非本页回执丢弃
          dispatch({
            type: "artifacts-result",
            jobId,
            artifacts: (e.payload as TaskArtifactsResultPayload).artifacts,
          });
          return;
        }
        if (
          e.type === "task.pause.result" ||
          e.type === "task.resume.result" ||
          e.type === "task.cancel.result" ||
          e.type === "task.retry.result"
        ) {
          const req = lifecycleReqRef.current;
          if (req === null) return; // 非本页发起
          lifecycleReqRef.current = null;
          const status = (e.payload as TaskLifecycleResultPayload).status;
          dispatch({ type: "lifecycle-result", kind: req.kind, jobId: req.jobId, status });
          const kind = e.type.slice("task.".length, -".result".length) as "pause" | "resume" | "cancel" | "retry";
          const toastKey =
            kind === "pause"
              ? "tk.toast.paused"
              : kind === "resume"
                ? "tk.toast.resumed"
                : kind === "retry"
                  ? "tk.toast.retried"
                  : "tk.toast.cancelled";
          toast.push("ok", t(toastKey));
          return;
        }
        if (e.type === "task.delete.result") {
          const req = lifecycleReqRef.current;
          if (req === null) return;
          lifecycleReqRef.current = null;
          const title = cur.tasks.find((x) => x.jobId === req.jobId)?.title ?? "";
          dispatch({ type: "delete-result", jobId: req.jobId });
          toast.push("ok", t("tk.toast.deleted", { title }));
          return;
        }
        if (e.type === "connection.error") {
          // 生命周期命令在途失败（单飞门控；非本页在途的 connection.error 不消费）
          const msg = (e.payload as { message?: string }).message ?? e.type;
          let consumed = false;
          const req = lifecycleReqRef.current;
          if (req !== null) {
            lifecycleReqRef.current = null;
            dispatch({ type: "lifecycle-failed" });
            toast.push("err", t("tk.toast.failed", { msg }));
            consumed = true;
          }
          // M43：task.artifacts 在途同查——清 FIFO 在途关联 + 解除骨架（防结果
          // tab 永久骨架与迟到回执错位对号）；归属标记防 watcher 自动重发成风暴
          const artifactsJob =
            artifactsReqRef.current.length > 0
              ? artifactsReqRef.current[0]!
              : cur.artifactsLoading
                ? cur.selected
                : null;
          if (artifactsJob !== null) {
            artifactsReqRef.current = [];
            dispatch({ type: "artifacts-failed", jobId: artifactsJob });
            if (!consumed) toast.push("err", t("tk.toast.failed", { msg }));
            consumed = true;
          }
          if (!consumed) return;
          return;
        }
        if (e.type === "task.changed") {
          // O-7 轻负载驱动：job → 重拉 list+detail（就地刷新无 loading 闪）；
          // stage/batch/work_item → 仅当选中时重拉 detail
          const p = e.payload as TaskChangedPayload;
          if (p.changed === "job") {
            sendTaskList();
            if (cur.selected === p.jobId) sendTaskDetail({ jobId: p.jobId });
          } else if (cur.selected === p.jobId) {
            sendTaskDetail({ jobId: p.jobId });
          }
        }
      }),
    [subscribeTaskFrames, sendTaskList, sendTaskDetail, toast, t],
  );

  // 选中 watcher：拉详情（选中未变不重发；迟到回执 reducer 按 jobId 丢弃）
  const selected = state.selected;
  useEffect(() => {
    if (selected === null) {
      detailFetchedRef.current = null;
      return;
    }
    if (detailFetchedRef.current === selected) return;
    detailFetchedRef.current = selected;
    dispatch({ type: "detail-loading", jobId: selected });
    sendTaskDetail({ jobId: selected });
  }, [selected, sendTaskDetail]);

  // 结果 tab watcher：首进该 tab 或切换任务后拉产物（artifactsJob 归属校验）
  useEffect(() => {
    if (state.tab !== "result" || selected === null) return;
    if (state.artifactsJob === selected || state.artifactsLoading) return;
    dispatch({ type: "artifacts-loading", jobId: selected });
    const ok = sendTaskArtifacts({ jobId: selected });
    if (ok) artifactsReqRef.current.push(selected); // 发送成功才入队在途关联
  }, [state.tab, state.artifactsJob, state.artifactsLoading, selected, sendTaskArtifacts]);

  // ── 行为回调 ───────────────────────────────────────────────
  const onSelectTask = useCallback((jobId: string) => {
    dispatch({ type: "select-task", jobId });
  }, []);

  const onFilterStatus = useCallback((value: "all" | TaskStatus) => {
    dispatch({ type: "filter-status", value });
  }, []);

  const onFilterProject = useCallback((value: string) => {
    dispatch({ type: "filter-project", value });
  }, []);

  const onClearFilters = useCallback(() => {
    dispatch({ type: "clear-filters" });
  }, []);

  const onTab = useCallback((value: "progress" | "result") => {
    dispatch({ type: "tab", value });
  }, []);

  const onConfirmOpen = useCallback((box: "cancel" | "delete") => {
    dispatch({ type: "confirm-open", box });
  }, []);

  const onConfirmClose = useCallback(() => {
    dispatch({ type: "confirm-close" });
  }, []);

  const onPlanToggle = useCallback((batchId: string) => {
    dispatch({ type: "plan-toggle", batchId });
  }, []);

  /** 生命周期命令发送（单飞：ref 关联 + reducer 锁 + 发送失败回滚）。 */
  const onLifecycle = useCallback(
    (kind: TaskLifecycleAction) => {
      const jobId = stateRef.current.selected;
      if (jobId === null) return;
      dispatch({ type: "lifecycle-started", kind });
      lifecycleReqRef.current = { kind, jobId };
      const ok =
        kind === "pause"
          ? sendTaskPause(jobId)
          : kind === "resume"
            ? sendTaskResume(jobId)
            : kind === "cancel"
              ? sendTaskCancel(jobId)
              : kind === "retry"
                ? sendTaskRetry(jobId)
                : sendTaskDelete(jobId);
      if (!ok) {
        lifecycleReqRef.current = null;
        dispatch({ type: "lifecycle-failed" });
        toast.push("err", t("tk.toast.sendFailed"));
      }
    },
    [sendTaskPause, sendTaskResume, sendTaskCancel, sendTaskRetry, sendTaskDelete, toast, t],
  );

  // ── 展示派生 ───────────────────────────────────────────────
  const view = selectListView(state);
  const detail = state.detail;
  const detailReady = detail !== null && detail.jobId === selected;

  return (
    <AppLayout
      headerLeft={<h1 className="tk-page-title">{t("tk.title")}</h1>}
      sidebar={
        <TaskListPane
          view={view}
          state={state}
          now={now}
          t={t}
          onSelect={onSelectTask}
          onFilterStatus={onFilterStatus}
          onFilterProject={onFilterProject}
          onClearFilters={onClearFilters}
          onOpenProject={onOpenProject}
        />
      }
    >
      <div className="tk-main" data-p2-task={path} data-tk-mode={view.mode}>
        {view.mode === "empty" ? (
          <div className="tk-main-center">
            <div className="tk-center-panel">
              <EmptyPanel marker="detail-empty" title={t("tk.emptyDetail.title")} sub={t("tk.emptyDetail.sub")} />
            </div>
          </div>
        ) : selected === null ? (
          <div className="tk-main-center">
            <div className="tk-center-panel">
              <EmptyPanel marker="no-select" title={t("tk.noSelect.title")} sub={t("tk.noSelect.sub")} />
            </div>
          </div>
        ) : (
          <>
            {detailReady && detail !== null ? (
              <TaskDetailHead
                detail={detail}
                now={now}
                t={t}
                busy={state.pendingLifecycle !== null}
                confirmBox={state.confirmBox}
                onAction={onLifecycle}
                onConfirmOpen={onConfirmOpen}
                onConfirmClose={onConfirmClose}
                onOpenProject={onOpenProject}
              />
            ) : (
              <div className="tk-head" data-tk-detail-loading>
                <TaskSkeleton lines={4} />
              </div>
            )}
            <nav className="tk-tabs" data-tk-tabs>
              <button
                type="button"
                className={cn("tk-tab", state.tab === "progress" && "active")}
                data-tk-tab="progress"
                onClick={() => onTab("progress")}
              >
                {t("tk.result.tabProgress")}
              </button>
              <button
                type="button"
                className={cn("tk-tab", state.tab === "result" && "active")}
                data-tk-tab="result"
                onClick={() => onTab("result")}
              >
                {t("tk.result.tabResult")}
              </button>
            </nav>
            <div className="tk-pane-scroll">
              <div className="tk-pane-inner" data-tk-pane={state.tab}>
                {state.tab === "progress" ? (
                  detailReady && detail !== null ? (
                    <TaskProgressPane detail={detail} planOpen={state.planOpen} t={t} onPlanToggle={onPlanToggle} />
                  ) : (
                    <TaskSkeleton lines={4} />
                  )
                ) : state.artifactsLoading || state.artifactsJob !== selected ? (
                  <TaskSkeleton lines={4} />
                ) : state.artifacts !== null ? (
                  <TaskResultPane artifacts={state.artifacts} t={t} />
                ) : (
                  <EmptyPanel marker="artifacts" title={t("tk.result.emptyTitle")} sub={t("tk.result.emptySub")} />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
};

export default TasksPage;
