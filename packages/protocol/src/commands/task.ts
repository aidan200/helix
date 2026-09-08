/** 任务域命令族：workspace.* / task.*（九命令族）/ diff.get。 */
import type { CommandFrame } from "../envelope";
import type { TaskStatus } from "../types/task";
import type { DiffGetPayload } from "../types/diff";
import type { EmptyPayload } from "./session";

// ── workspace 批新增（W1 workspace 绑定闭环；契约 = 设计稿 workspace-feature-design-candidate.md §3.1）──

/**
 * workspace.get 载荷：绑定门禁读面（全局命令，无参）。结果帧 =
 * workspace.get.result 点对点回执（TR-AD-21 模式）——前端启动门禁分流
 * 依据（bound → 主壳 / null → 选择页）。无 close/unbind 命令（v1 裁决：
 * 切换 = open 另一 root）。
 */
export interface WorkspaceGetCommand extends CommandFrame<EmptyPayload> {
  type: "workspace.get";
}

/** workspace.open 载荷：显式绑定写面（全局命令）。 */
export interface WorkspaceOpenPayload {
  /** 待绑定的工作空间根（daemon 单点校验：realpath 规范化 + 危险根拒绝）。 */
  root: string;
}
export interface WorkspaceOpenCommand extends CommandFrame<WorkspaceOpenPayload> {
  type: "workspace.open";
}

// ── task 批新增（iter-20260829-ys7q T1.5，P-2 任务页数据面九命令族；契约 = contracts/task-api.md §2）──

/**
 * task 族命令通则：九命令全部为全局命令（信封 sessionId 省略）——任务
 * 是 daemon 级实体非会话作用域。零内容干预（AD-2）：无 steer/批次重试/
 * 内容编辑命令——九命令清单即全集（机械 grep 断言守护）。结果 = 点对点
 * 结果帧（types/task.ts，不入 EVENT_TYPES 目录——契约 §0 计数 57→58
 * 仅 task.changed）；生命周期错误码词表 = 契约 §4（handler 透传引擎
 * TaskError，状态判断收口 T1.3 引擎）。
 */
export interface TaskListPayload {
  /** 状态过滤器（服务端生效；六态枚举，越界 → command.invalid_payload）。 */
  status?: TaskStatus;
  /** 项目过滤器（AD-8：0..n 项目标签之一；服务端生效）。 */
  project?: string;
}
export interface TaskListCommand extends CommandFrame<TaskListPayload> {
  type: "task.list";
}

export interface TaskDetailPayload {
  jobId: string;
}
export interface TaskDetailCommand extends CommandFrame<TaskDetailPayload> {
  type: "task.detail";
}

export interface TaskArtifactsPayload {
  jobId: string;
}
/** 结果只读查询（F3.4）：节点详情/修正转 /project 页（AD-10）。 */
export interface TaskArtifactsCommand extends CommandFrame<TaskArtifactsPayload> {
  type: "task.artifacts";
}

export interface TaskSubscribePayload {
  /** 缺省 = 订阅全部任务变更（通配档；连接级订阅表机械定义）。 */
  jobId?: string;
}
/** 连接级订阅（F3.2 WS 实时推送；订阅表登记 → task.changed 按连接过滤投递）。 */
export interface TaskSubscribeCommand extends CommandFrame<TaskSubscribePayload> {
  type: "task.subscribe";
}

export interface TaskUnsubscribePayload {
  /** 缺省 = 清空订阅集与通配档（对称语义）。 */
  jobId?: string;
}
export interface TaskUnsubscribeCommand extends CommandFrame<TaskUnsubscribePayload> {
  type: "task.unsubscribe";
}

export interface TaskPausePayload {
  jobId: string;
}
/** 暂停（F3.5；仅 running → paused 合法——O-2 停派新批次+在跑自然收口；非法态 → task.invalid_state 引擎透传）。 */
export interface TaskPauseCommand extends CommandFrame<TaskPausePayload> {
  type: "task.pause";
}

export interface TaskResumePayload {
  jobId: string;
}
/** 恢复（仅 paused → running；与断点恢复同路径）。 */
export interface TaskResumeCommand extends CommandFrame<TaskResumePayload> {
  type: "task.resume";
}

export interface TaskCancelPayload {
  jobId: string;
}
/** 取消（running/paused/pending → cancelled 终态；在跑批次 SIGTERM）。 */
export interface TaskCancelCommand extends CommandFrame<TaskCancelPayload> {
  type: "task.cancel";
}

export interface TaskRetryPayload {
  jobId: string;
}
/** 人工重试（仅 failed → running 复活：批次重试预算归零留痕 + 失败阶段重开 + 重开编排——token 耗尽换 key 后续跑场景，已 done 阶段/批次不动）。 */
export interface TaskRetryCommand extends CommandFrame<TaskRetryPayload> {
  type: "task.retry";
}

export interface TaskDeletePayload {
  jobId: string;
}
/** 删除（F3.6：仅终态 done/failed/cancelled 可删；清任务域记录不触 kg 产出；判断收口引擎）。 */
export interface TaskDeleteCommand extends CommandFrame<TaskDeletePayload> {
  type: "task.delete";
}

// ── diff 批新增（T3+T4 轮次 diff 协议与 UI 闭环；PROTOCOL-CHANGELOG.md §26）──

/**
 * 轮次 diff 详情查询（session 作用域——**信封 sessionId 必填**，AD-4 路由位）：
 * turnId 缺省 = 最近冻结轮；live=true = 进行中轮实时视图（active 条目即时终读
 * 统计）。回执 diff.get.result 点对点（仅发发起连接；结果帧不入 EVENT_TYPES
 * 目录——task 族先例，types/diff.ts 窄化接口供出）。
 */
export interface DiffGetCommand extends CommandFrame<DiffGetPayload> {
  type: "diff.get";
}


