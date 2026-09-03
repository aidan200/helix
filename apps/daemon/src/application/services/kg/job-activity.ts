/**
 * kg 发起面并发禁入判定（P0① 双启动防护，2026-08-31 修复清单①）：
 * bootstrap/review create 的准入第四条件与 kg.projects 行 bootstrapRunning
 * 标志共用同一机械口径——「该项目存在指定类型的非终态 job」即拒绝/标运行中；
 * 终态（done/failed/cancelled，domain/job.ts isTerminalJob）后放行，保留
 * 「终态后可再发」语义（仅禁并发，不绑一次性）。
 *
 * 查询口径（改动最小裁决）：JobListFilter 只有 status 维度且表达不了
 * 「非终态」补集——listJobs() 全量取回后过滤（produce() 同先例）；
 * 「该项目」= job.projects 含项目名（workspace 一级目录名标签匹配）。
 */

import type { JobData } from "../../ports/outbound/TaskStorePort";
import { isTerminalJob } from "../../../domain/task/job";

/** projectRoot → workspace 一级目录名（job.projects 标签匹配键）。 */
export function projectNameOf(projectRoot: string): string {
  return projectRoot.split("/").filter((s) => s !== "").pop() ?? projectRoot;
}

/** 该项目存在指定类型的非终态 job（并发禁入 / 运行中标志判定）。 */
export function hasActiveJob(jobs: readonly JobData[], type: string, projectName: string): boolean {
  return jobs.some((j) => j.type === type && j.projects.includes(projectName) && !isTerminalJob(j.status));
}

/**
 * create check-then-act 互斥槽（code-review M10）：hasActiveJob 检查与
 * createTask 落库之间的 await 窗口内，并发 create 可双双通过检查——claim 与
 * 准入检查在同一同步段完成（JS 单线程无抢占），占住即拒后来者；createTask
 * 落定（成功或抛错）后 finally 释放。
 */
const createSlots = new Set<string>();

/** 占用发起槽（同 type+project 已有在途 create 返回 false）。 */
export function claimCreateSlot(type: string, projectName: string): boolean {
  const key = `${type}::${projectName}`;
  if (createSlots.has(key)) return false;
  createSlots.add(key);
  return true;
}

/** 释放发起槽（finally 必调）。 */
export function releaseCreateSlot(type: string, projectName: string): void {
  createSlots.delete(`${type}::${projectName}`);
}
