/**
 * task 族共享 DTO + 事件 + 点对点结果帧（P-2 任务页数据面，iter-20260829-ys7q T1.5）。
 *
 * 契约权威源 = 本迭代 `development/contracts/task-api.md`（T1.5 daemon 协议面
 * 与 T3.1 shell 前端的共同约定；逐字段以契约为准）。本文件是该契约的协议类型
 * 落位（AD-8/AG-13：两端同源，仓内不得平行手写）。
 *
 * 批次：v0.11 后 additive 微批（版本位不 bump，§19/§20 同构先例）——
 * 九命令（PROTOCOL.md §15.11）+ `task.changed` 唯一新事件（EVENT_TYPES
 * 57→58；挂既有 notification 通道，不新增 Channel 值——契约 §0）。
 * 九命令结果帧为**命令点对点回执**（TR-AD-21 模式，sendNow 直发不经
 * EventStream 广播）——与 kg 批不同，本批结果帧不入 EVENT_TYPES 目录
 * （契约 §0 计数 57→58 仅含 task.changed），帧类型以本文件窄化接口供出。
 *
 * AD-4（裸 id 纪律）：jobId/batchId/nodeId 只做 join 键与 data-id 属性，
 * 人类可读字段（title/scope/summary）由服务端
 * TaskQueryService 组装（types/task.ts 只定义 wire 形状）。
 */

import type { EventFrame } from "../envelope";

/** 任务六态（wire 值 = 后端状态机原值；前端展示映射 pending→装配中/done→已完成只发生在展示层，契约 §0）。 */
export type TaskStatus = "pending" | "running" | "paused" | "done" | "failed" | "cancelled";

/** 任务来源（双宿主如实呈现，AD-7/R-9）。 */
export type TaskCreatedBy = "page" | "chat";

// ── 列表行（task.list；契约 §1） ─────────────────────────────

/** 进度块（运行中/已推进任务非 null；duration 不传——前端由 createdAt+status 计算，契约决策）。 */
export interface TaskProgressDto {
  /** 当前阶段名（「阶段名 · 批次 x/y」的阶段名；done 态收口 null）。 */
  stageName: string | null;
  batchesDone: number;
  batchesTotal: number;
  /** 0-100（进度条）。 */
  percent: number;
}

/** 任务列表行（全局平铺；服务端排序 = 运行中置顶 + 创建时间倒序）。 */
export interface TaskSummaryDto {
  /** data-id / join 键。 */
  jobId: string;
  /** 任务类型 = skill 名（如 "kg-bootstrap"；类型徽章）。 */
  type: string;
  /** 人类可读标题（服务端组装）。 */
  title: string;
  status: TaskStatus;
  /** 0..n 项目徽章；空数组合法（AD-8）。 */
  projects: string[];
  createdBy: TaskCreatedBy;
  /** ISO 时间。 */
  createdAt: string;
  updatedAt: string;
  progress: TaskProgressDto | null;
  /** failed 时人类可读原因。 */
  error: string | null;
}

// ── 详情（task.detail；契约 §1） ─────────────────────────────

/** 实例 plan 行（work_item 表投影；abandoned 时必带理由——closure 硬约束）。 */
export interface WorkItemDto {
  seq: number;
  content: string;
  status: "pending" | "in_progress" | "done" | "abandoned";
  note: string | null;
}

/** 批次行（全量批次列表——跨阶段收集，stageSeq 为前端分组键）。 */
export interface TaskBatchDto {
  /** data-id。 */
  batchId: string;
  /** 所属阶段序号（前端按阶段分组键）。 */
  stageSeq: number;
  seq: number;
  /** 批次范围描述（粗体，人类可读）。 */
  scope: string;
  status: "pending" | "running" | "done" | "failed";
  /** 自动重试计数（>0 时前端 warning 色如实呈现）。 */
  retryCount: number;
  /** 重试原因 note。 */
  retryNote: string | null;
  /** 当前/最近执行 SubAgent 实例（data-id；未派发 null）。 */
  instanceId: string | null;
  /** 批次实例 plan（running/done/failed 批次携带；未派发 null）。 */
  plan: WorkItemDto[] | null;
}

/** 阶段行（通用阶段条数据源，R-4；stage 行驱动）。 */
export interface TaskStageDto {
  seq: number;
  /** 阶段名（如 "L0 核心层"）。 */
  name: string;
  status: "pending" | "running" | "done" | "failed";
  /** 阶段产物摘要（done 后非 null；文字报告，与 kg 零耦合）。 */
  artifact: { summary: string } | null;
}

/** 任务详情（阶段条 + 全量批次 + 实例 plan）。 */
export interface TaskDetailDto extends TaskSummaryDto {
  stages: TaskStageDto[];
  batches: TaskBatchDto[];
  /** 定格参数（元信息展示）。 */
  params: Record<string, unknown>;
}

// ── 结果查询（task.artifacts，F3.4 只读；契约 §1） ────────────

/** 各阶段产物（文字报告 only——结果与 kg 彻底零耦合，节点反查链已拆除）。 */
export interface TaskArtifactsDto {
  stages: {
    seq: number;
    name: string;
    status: "pending" | "running" | "done" | "failed";
    artifact: { summary: string } | null;
  }[];
}

// ── 事件（契约 §3；O-7 裁决：逐状态迁移推送、轻负载、前端据以重拉） ──

/** task.changed 载荷：变更面 + job 级新状态。 */
export interface TaskChangedPayload {
  jobId: string;
  /** 变更面（stage/batch/work_item 级变更前端按需重拉 detail）。 */
  changed: "job" | "stage" | "batch" | "work_item";
  /** job 级变更携带新状态。 */
  status?: string;
  /**
   * kg sync 提示（W2-D R13，additive 可选字段）：job 终态时 pending_sync
   * 台账有未提示行 → 随行一帧人读提示（「本次任务有代码/文档变更，是否
   * 触发 kg sync？」——机器只记录只提醒，sync 本体永远要人确认）；服务层
   * 人读文案前端直渲（kg DTO summary 同规）。
   */
  syncHint?: string;
}

/**
 * task.changed 广播事件（唯一入 EVENT_TYPES 目录的本批事件；挂既有
 * notification 通道——daemon 级全局帧 sessionId = SYSTEM_SESSION_ID，
 * 投递按连接级任务订阅表过滤（task.subscribe 登记），不新增 Channel 值）。
 */
export interface TaskChangedEvent extends EventFrame<TaskChangedPayload> {
  channel?: "notification";
  type: "task.changed";
}

// ── 点对点结果帧（契约 §2 响应列；不入 EVENT_TYPES 目录——sendNow 直发） ──

/**
 * task 族结果帧通则：九命令回执全部为命令点对点帧（TR-AD-21 模式），
 * 信封 sessionId = SYSTEM_SESSION_ID、channel = "notification"（任务面为
 * daemon 级全局，会话无关）。协议目录计数（EVENT_TYPES）不含本组——
 * 契约 §0 计数纪律（57→58 仅 task.changed）。
 */

/** task.list.result 载荷。 */
export interface TaskListResultPayload {
  tasks: TaskSummaryDto[];
}
export interface TaskListResultEvent extends EventFrame<TaskListResultPayload> {
  channel?: "notification";
  type: "task.list.result";
}

/** task.detail.result 载荷。 */
export interface TaskDetailResultPayload {
  task: TaskDetailDto;
}
export interface TaskDetailResultEvent extends EventFrame<TaskDetailResultPayload> {
  channel?: "notification";
  type: "task.detail.result";
}

/** task.artifacts.result 载荷。 */
export interface TaskArtifactsResultPayload {
  artifacts: TaskArtifactsDto;
}
export interface TaskArtifactsResultEvent extends EventFrame<TaskArtifactsResultPayload> {
  channel?: "notification";
  type: "task.artifacts.result";
}

/** task.subscribe / task.unsubscribe / task.delete 回执载荷。 */
export interface TaskOkResultPayload {
  ok: true;
}
export interface TaskSubscribeResultEvent extends EventFrame<TaskOkResultPayload> {
  channel?: "notification";
  type: "task.subscribe.result";
}
export interface TaskUnsubscribeResultEvent extends EventFrame<TaskOkResultPayload> {
  channel?: "notification";
  type: "task.unsubscribe.result";
}
export interface TaskDeleteResultEvent extends EventFrame<TaskOkResultPayload> {
  channel?: "notification";
  type: "task.delete.result";
}

/** 生命周期命令回执载荷（status = 引擎成功后置状态）。 */
export interface TaskLifecycleResultPayload {
  ok: true;
  status: TaskStatus;
}
export interface TaskPauseResultEvent extends EventFrame<TaskLifecycleResultPayload> {
  channel?: "notification";
  type: "task.pause.result";
}
export interface TaskResumeResultEvent extends EventFrame<TaskLifecycleResultPayload> {
  channel?: "notification";
  type: "task.resume.result";
}
export interface TaskCancelResultEvent extends EventFrame<TaskLifecycleResultPayload> {
  channel?: "notification";
  type: "task.cancel.result";
}
