/**
 * task 族命令处理（P-2 任务页数据面，§8.1 九命令族；iter-20260829-ys7q T1.5）。
 *
 * 先例 = handlers/kg.ts：unimplemented 门控（任务栈未装配 →
 * command.unimplemented 回执不崩溃）+ requireString/optionalString 形状校验
 * （kg 先例：形状收口本入口，枚举越界按契约词表判）+ sendNow 点对点结果帧
 * （task.*.result——types/task.ts 窄化接口，不入 EVENT_TYPES 目录，契约 §0
 * 计数纪律）+ 错误透传（引擎/查询服务 TaskError.code 原样回执——handler
 * 零状态判断，task.invalid_state 收口引擎 T1.3）。
 *
 * 依赖面 = TaskQueryService（P-2 读面投影，AD-4② 人类可读组装在服务端）+
 * TaskEnginePort（生命周期写面，只转发不决策）+ EventStream（task.subscribe
 * 连接级订阅表 + task.changed 广播）。全局命令（信封 sessionId 不消费）：
 * 结果帧 sessionId = SYSTEM_SESSION_ID、channel = "notification"（任务为
 * daemon 级实体；挂既有通道不新增 Channel 值，契约 §0）。
 *
 * task.changed 触发（O-7 逐迁移轻负载）：生命周期命令成功即广播
 * {jobId, changed:"job", status}——handler/context 层最小接线（引擎无事件
 * 钩子，T1.3 注记 T1.5 接线位，不改引擎状态机）；stage/batch 级迁移触发归
 * 编排侧 T2.2、创建归 T2.4 工具面（同一 EventStream.broadcastTaskChanged
 * 通路）。status 回执 = 引擎成功后置条件（pause→paused / resume→running /
 * cancel→cancelled——引擎迁移语义固定，handler 不读回不判断）。
 */
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type {
  ErrorCode,
  EventEnvelope,
  TaskArtifactsDto,
  TaskArtifactsResultEvent,
  TaskBatchDto,
  TaskCancelResultEvent,
  TaskDeleteResultEvent,
  TaskDetailDto,
  TaskDetailResultEvent,
  TaskListResultEvent,
  TaskPauseResultEvent,
  TaskResumeResultEvent,
  TaskStageDto,
  TaskStatus,
  TaskSubscribeResultEvent,
  TaskSummaryDto,
  TaskUnsubscribeResultEvent,
  WorkItemDto,
} from "@helix/protocol";
import type {
  TaskArtifactsDto as AppTaskArtifactsDto,
  TaskBatchDto as AppTaskBatchDto,
  TaskDetailDto as AppTaskDetailDto,
  TaskStageDto as AppTaskStageDto,
  TaskSummaryDto as AppTaskSummaryDto,
  WorkItemDto as AppWorkItemDto,
} from "../../../../application/services/task/TaskQueryService";
import type { FrameSender } from "../EventStream";
import type { TaskCommandContext } from "./context";

/** 任务域错误码词表（契约 task-api §4；duck-typing 判别，免 TaskError 运行时 import）。 */
const TASK_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "task.type_unknown",
  "task.validation_failed",
  "task.not_found",
  "task.invalid_state",
]);

/** 六态枚举（wire 值 = 后端状态机原值，契约 §0）。 */
const TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "paused",
  "done",
  "failed",
  "cancelled",
]);

// ── 读面（F3.1/F3.2/F3.4） ──────────────────────────────────

/** task.list（F3.1：全局平铺；排序与过滤服务端生效）。 */
export function handleTaskList(ctx: TaskCommandContext): void {
  const query = ctx.taskQuery;
  if (query === undefined) return unimplemented(ctx);
  const status = optionalTaskStatus(ctx);
  if (status === null) return;
  const project = optionalString(ctx, "project");
  if (project === null) return;
  const tasks = query.listTasks({ status, project });
  const frame: TaskListResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "notification",
    type: "task.list.result",
    payload: { tasks: tasks.map(summaryToDto) },
  };
  reply(ctx, frame);
}

/** task.detail（F3.2/F3.3：阶段条 + 当前阶段批次 + 实例 plan + 叙述句）。 */
export function handleTaskDetail(ctx: TaskCommandContext): void {
  const query = ctx.taskQuery;
  if (query === undefined) return unimplemented(ctx);
  const jobId = requireString(ctx, "jobId");
  if (jobId === undefined) return;
  try {
    const frame: TaskDetailResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "notification",
      type: "task.detail.result",
      payload: { task: detailToDto(query.getTaskDetail(jobId)) },
    };
    reply(ctx, frame);
  } catch (err: unknown) {
    taskError(ctx, err);
  }
}

/** task.artifacts（F3.4：阶段产物只读投影；节点详情/修正转 /project 页 AD-10）。 */
export function handleTaskArtifacts(ctx: TaskCommandContext): void {
  const query = ctx.taskQuery;
  if (query === undefined) return unimplemented(ctx);
  const jobId = requireString(ctx, "jobId");
  if (jobId === undefined) return;
  try {
    const frame: TaskArtifactsResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "notification",
      type: "task.artifacts.result",
      payload: { artifacts: artifactsToDto(query.getTaskArtifacts(jobId)) },
    };
    reply(ctx, frame);
  } catch (err: unknown) {
    taskError(ctx, err);
  }
}

// ── 订阅面（F3.2 WS 实时推送；连接级订阅表机械定义） ──────────

/** task.subscribe：携带 jobId 加入订阅集；缺省 = 通配全部任务变更。 */
export function handleTaskSubscribe(ctx: TaskCommandContext): void {
  const sender = subscribeGate(ctx);
  if (sender === undefined) return;
  const jobId = optionalString(ctx, "jobId");
  if (jobId === null) return;
  ctx.events.subscribeTask(sender, jobId);
  const frame: TaskSubscribeResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "notification",
    type: "task.subscribe.result",
    payload: { ok: true },
  };
  reply(ctx, frame);
}

/** task.unsubscribe：携带 jobId 移除该订阅；缺省 = 清空订阅集与通配档。 */
export function handleTaskUnsubscribe(ctx: TaskCommandContext): void {
  const sender = subscribeGate(ctx);
  if (sender === undefined) return;
  const jobId = optionalString(ctx, "jobId");
  if (jobId === null) return;
  ctx.events.unsubscribeTask(sender, jobId);
  const frame: TaskUnsubscribeResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "notification",
    type: "task.unsubscribe.result",
    payload: { ok: true },
  };
  reply(ctx, frame);
}

// ── 生命周期（F3.5；零内容干预 AD-2——无 steer/批次重试命令） ──

/** task.pause（仅 running → paused；非法态引擎抛 task.invalid_state 透传）。 */
export function handleTaskPause(ctx: TaskCommandContext): void {
  lifecycle(ctx, "pause", "paused", (engine, jobId) => engine.pause(jobId));
}

/** task.resume（仅 paused → running + 重开编排）。 */
export function handleTaskResume(ctx: TaskCommandContext): void {
  lifecycle(ctx, "resume", "running", (engine, jobId) => engine.resume(jobId));
}

/** task.cancel（pending/running/paused → cancelled 终态）。 */
export function handleTaskCancel(ctx: TaskCommandContext): void {
  lifecycle(ctx, "cancel", "cancelled", (engine, jobId) => engine.cancel(jobId));
}

/** task.delete（F3.6：仅终态可删，判断收口引擎；成功无广播——删除非状态迁移，前端重拉 list 自达）。 */
export function handleTaskDelete(ctx: TaskCommandContext): void {
  const engine = ctx.taskEngine;
  if (engine === undefined) return unimplemented(ctx);
  const jobId = requireString(ctx, "jobId");
  if (jobId === undefined) return;
  void engine
    .deleteTask(jobId)
    .then(() => {
      const frame: TaskDeleteResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "notification",
        type: "task.delete.result",
        payload: { ok: true },
      };
      reply(ctx, frame);
    })
    .catch((err: unknown) => taskError(ctx, err));
}

/** 生命周期命令共通：引擎调用 → 成功即广播 task.changed（O-7）+ 后置状态回执。 */
function lifecycle(
  ctx: TaskCommandContext,
  verb: "pause" | "resume" | "cancel",
  postStatus: TaskStatus,
  call: (engine: NonNullable<TaskCommandContext["taskEngine"]>, jobId: string) => Promise<void>,
): void {
  const engine = ctx.taskEngine;
  if (engine === undefined) return unimplemented(ctx);
  const jobId = requireString(ctx, "jobId");
  if (jobId === undefined) return;
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void call(engine, jobId)
    .then(() => {
      ctx.events.broadcastTaskChanged({ jobId, changed: "job", status: postStatus });
      const frame: TaskResultFrame = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "notification",
        type: `task.${verb}.result`,
        payload: { ok: true, status: postStatus },
      };
      ctx.sendNow(sender, frame as unknown as EventEnvelope);
    })
    .catch((err: unknown) => taskError(ctx, err));
}

// ── payload 字段形状校验（枚举按契约词表判；语义判断归引擎/服务） ──

/** 必填 string 字段：缺失/非 string → command.invalid_payload（kg.ts requireString 同构）。 */
function requireString(ctx: TaskCommandContext, key: string): string | undefined {
  const value = ctx.payload[key];
  if (typeof value !== "string") {
    ctx.commandError(ctx.type, "command.invalid_payload", `payload.${key} 应为 string（必填）`);
    return undefined;
  }
  return value;
}

/** 可选 string 字段：null=形状非法（已回执）；undefined=缺省透传。 */
function optionalString(ctx: TaskCommandContext, key: string): string | undefined | null {
  const value = ctx.payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    ctx.commandError(ctx.type, "command.invalid_payload", `payload.${key} 应为 string`);
    return null;
  }
  return value;
}

/** 可选六态枚举：越界 → command.invalid_payload（wire 值 = 状态机原值）。 */
function optionalTaskStatus(ctx: TaskCommandContext): TaskStatus | undefined | null {
  const value = ctx.payload["status"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TASK_STATUSES.has(value)) {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.status 应为任务状态枚举（pending/running/paused/done/failed/cancelled）");
    return null;
  }
  return value as TaskStatus;
}

// ── 回执辅助 ────────────────────────────────────────────

/** 任务栈未装配门控（trace.ts/kg.ts 先例：回执不崩溃）。 */
function unimplemented(ctx: TaskCommandContext): void {
  ctx.commandError(ctx.type, "command.unimplemented", "task 数据面未装配");
}

/**
 * 订阅命令门控：任务读面未装配 → command.unimplemented（订阅无意义——
 * 数据面已关闭）；装配则供出 attach 注册的连接发送端（订阅表键 = 注册键，
 * rawSender 每次新建闭包不可作键）。
 */
function subscribeGate(ctx: TaskCommandContext): FrameSender | undefined {
  if (ctx.taskQuery === undefined) {
    unimplemented(ctx);
    return undefined;
  }
  return ctx.ws.data.sender ?? ctx.rawSender();
}

/**
 * 引擎/查询服务错误 → connection.error 回执（错误码原样透传，契约 §4 词表；
 * modelErrorCode 先例 duck-typing err.code——免 TaskError 运行时 import，
 * AG-12 服务面 type-only 纪律）。词表外异常兜底 command.invalid_payload
 * （不吞声不崩溃）。
 */
function taskError(ctx: TaskCommandContext, err: unknown): void {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code === "string" && TASK_ERROR_CODES.has(code as ErrorCode)) {
    ctx.commandError(ctx.type, code as ErrorCode, message);
    return;
  }
  ctx.commandError(ctx.type, "command.invalid_payload", message);
}

/** 点对点结果帧联合（九命令回执；types/task.ts 窄化接口）。 */
type TaskResultFrame =
  | TaskListResultEvent
  | TaskDetailResultEvent
  | TaskArtifactsResultEvent
  | TaskSubscribeResultEvent
  | TaskUnsubscribeResultEvent
  | TaskPauseResultEvent
  | TaskResumeResultEvent
  | TaskCancelResultEvent
  | TaskDeleteResultEvent;

/**
 * 点对点结果帧直发（TR-AD-21 模式；task.*.result 不入 EVENT_TYPES 目录——
 * 契约 §0 计数纪律，帧形态为 types/task.ts 窄化接口，联合外单点 cast 收口）。
 */
function reply(ctx: TaskCommandContext, frame: TaskResultFrame): void {
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame as unknown as EventEnvelope);
}

// ── 应用层视图 → 协议 DTO（逐字段直拷；readonly → 可变帧形态，kg.ts 同构） ──

function summaryToDto(s: AppTaskSummaryDto): TaskSummaryDto {
  return {
    jobId: s.jobId,
    type: s.type,
    title: s.title,
    status: s.status,
    projects: [...s.projects],
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    progress:
      s.progress === null
        ? null
        : {
            stageName: s.progress.stageName,
            batchesDone: s.progress.batchesDone,
            batchesTotal: s.progress.batchesTotal,
            percent: s.progress.percent,
          },
    error: s.error,
  };
}

function workItemToDto(w: AppWorkItemDto): WorkItemDto {
  return { seq: w.seq, content: w.content, status: w.status, note: w.note };
}

function batchToDto(b: AppTaskBatchDto): TaskBatchDto {
  return {
    batchId: b.batchId,
    stageSeq: b.stageSeq,
    seq: b.seq,
    scope: b.scope,
    status: b.status,
    retryCount: b.retryCount,
    retryNote: b.retryNote,
    instanceId: b.instanceId,
    plan: b.plan === null ? null : b.plan.map(workItemToDto),
    ledger: b.ledger === null ? null : { total: b.ledger.total, done: b.ledger.done, inProgress: b.ledger.inProgress },
  };
}

function stageToDto(s: AppTaskStageDto): TaskStageDto {
  return {
    seq: s.seq,
    name: s.name,
    status: s.status,
    artifact: s.artifact === null ? null : { summary: s.artifact.summary },
  };
}

function detailToDto(d: AppTaskDetailDto): TaskDetailDto {
  return {
    ...summaryToDto(d),
    stages: d.stages.map(stageToDto),
    batches: d.batches.map(batchToDto),
    params: d.params,
  };
}

function artifactsToDto(a: AppTaskArtifactsDto): TaskArtifactsDto {
  return {
    stages: a.stages.map((s) => ({
      seq: s.seq,
      name: s.name,
      status: s.status,
      artifact: s.artifact === null ? null : { summary: s.artifact.summary },
    })),
  };
}
