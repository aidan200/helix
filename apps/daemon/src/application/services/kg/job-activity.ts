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

// ── create 共享骨架（code-review M7④） ─────────────────────

/** createTask 错误归一形态（三服务错误码联合的超集——string 承载，各服务回段自窄化）。 */
export interface NormalizedCreateError {
  readonly code: string;
  readonly message: string;
}

/**
 * createTask 抛错 → 结构化错误归一（M7④ 三服务同构收口；含 code-review M7
 * 「未分类错误不再伪装 validation_failed」裁决）：task.validation_failed /
 * task.type_unknown 原码透传；其余 string code 透传原码；无 code → task.internal。
 */
export function normalizeCreateTaskError(err: unknown): NormalizedCreateError {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "task.validation_failed" || code === "task.type_unknown") return { code, message };
  return { code: typeof code === "string" && code !== "" ? code : "task.internal", message };
}

/**
 * 错误码词表窄化（清单 #2.6 盲转收口）：NormalizedCreateError.code 是三服务
 * 码域联合的超集（string）——回段不作 as 盲转（词表外 code 会静默通过
 * 编译，类型说谎）。成员资格判定后才窄化；词表外回落 fallback（三服务
 * 码域均含 task.internal 兑底码，未知码以内部错误面示出）。
 */
export function narrowCreateErrorCode<T extends string>(
  code: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(code) ? (code as T) : fallback;
}

/**
 * page 入口 create 共享骨架（code-review M7④：KgBootstrapService /
 * KgReviewService / CodeReviewService 三份「互斥槽 claim → createTask →
 * 错误归一 → finally release」近逐字重复的收口点——既往修复（M7 错误透传/
 * M10 互斥槽）曾需逐份传播并出现码域微差）。准入判定（eligibility）语义
 * 各服务不同，留在各服务；槽占用错误的码域/文案亦各服务自持（注入）。
 */
export async function createTaskWithSlot(args: {
  readonly taskType: string;
  readonly projectName: string;
  /** 互斥槽占用（check-then-act 窗口撞车）时返回的错误（各服务码域/文案自持）。 */
  readonly slotBusyError: () => NormalizedCreateError;
  readonly createTask: () => Promise<{ jobId: string }>;
}): Promise<{ readonly ok: true; readonly jobId: string } | { readonly ok: false; readonly error: NormalizedCreateError }> {
  if (!claimCreateSlot(args.taskType, args.projectName)) {
    return { ok: false, error: args.slotBusyError() };
  }
  try {
    try {
      const { jobId } = await args.createTask();
      return { ok: true, jobId };
    } catch (err) {
      return { ok: false, error: normalizeCreateTaskError(err) };
    }
  } finally {
    releaseCreateSlot(args.taskType, args.projectName);
  }
}
