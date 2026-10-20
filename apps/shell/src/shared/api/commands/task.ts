/**
 * shared/api/commands/task —— task 域（任务清单/详情/产物读面 + 订阅与 pause/resume/cancel/retry/delete 写面）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  TaskArtifactsCommand,
  TaskArtifactsPayload,
  TaskCancelCommand,
  TaskDeleteCommand,
  TaskDetailCommand,
  TaskDetailPayload,
  TaskListCommand,
  TaskListPayload,
  TaskPauseCommand,
  TaskResumeCommand,
  TaskRetryCommand,
  TaskSubscribeCommand,
  TaskSubscribePayload,
  TaskUnsubscribeCommand,
  TaskUnsubscribePayload,
} from "@helix/protocol";

// ── task 族命令（T3.1；契约 contracts/task-api.md §2；iter-20260829-ys7q）──
// 本族全部为全局命令（信封 sessionId 省略——任务为 daemon 级实体）；回执 =
// task.*.result 点对点帧（SessionContext 转发层 → P-2 页面私有 reducer；
// 错误走 connection.error，生命周期词表 = 契约 §4）。零内容干预（AD-2）：
// 无 steer 命令（不给在跑任务插话改内容）；**人工复活 = task.retry**（仅
// failed→running，非内容干预）。命令清单以本文件构造器为单源（正文不写
// 计数快照——TR-206）。

/** task.list：全局平铺列表（服务端排序 = 运行中置顶+创建时间倒序；
 *  过滤器入参服务端生效，页面另持客户端镜像派生）。 */
export function taskListCommand(payload: TaskListPayload = {}): TaskListCommand {
  return { v: PROTOCOL_VERSION, type: "task.list", payload };
}

/** task.detail：阶段条 + 当前阶段批次 + 实例 plan + 叙述句（R-4~R-8）。 */
export function taskDetailCommand(payload: TaskDetailPayload): TaskDetailCommand {
  return { v: PROTOCOL_VERSION, type: "task.detail", payload };
}

/** task.artifacts：阶段产物只读投影（F3.4；节点修正转 /project 页 AD-10）。 */
export function taskArtifactsCommand(payload: TaskArtifactsPayload): TaskArtifactsCommand {
  return { v: PROTOCOL_VERSION, type: "task.artifacts", payload };
}

/** task.subscribe：连接级订阅（缺省 jobId = 订阅全部变更；重连重发）。 */
export function taskSubscribeCommand(payload: TaskSubscribePayload = {}): TaskSubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "task.subscribe", payload };
}

/** task.unsubscribe：清空订阅集（对称语义）。 */
export function taskUnsubscribeCommand(payload: TaskUnsubscribePayload = {}): TaskUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "task.unsubscribe", payload };
}

/** task.pause：仅 running→paused（O-2 停派新批次+在跑自然收口）。 */
export function taskPauseCommand(jobId: string): TaskPauseCommand {
  return { v: PROTOCOL_VERSION, type: "task.pause", payload: { jobId } };
}

/** task.resume：仅 paused→running（断点恢复同路径）。 */
export function taskResumeCommand(jobId: string): TaskResumeCommand {
  return { v: PROTOCOL_VERSION, type: "task.resume", payload: { jobId } };
}

/** task.cancel：pending/running/paused→cancelled 终态（在跑批次 SIGTERM）。 */
export function taskCancelCommand(jobId: string): TaskCancelCommand {
  return { v: PROTOCOL_VERSION, type: "task.cancel", payload: { jobId } };
}

/** task.retry：仅 failed→running 人工复活（批次预算归零留痕 + failed 阶段重开 + 重开编排）。 */
export function taskRetryCommand(jobId: string): TaskRetryCommand {
  return { v: PROTOCOL_VERSION, type: "task.retry", payload: { jobId } };
}

/** task.delete：仅终态可删；清任务域全部记录不触 kg 产出（F3.6）。 */
export function taskDeleteCommand(jobId: string): TaskDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "task.delete", payload: { jobId } };
}
