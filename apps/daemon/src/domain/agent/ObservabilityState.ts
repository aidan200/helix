/**
 * 观测态编译（U2——trace / agent_status 的「恒 running」歧义修正）。
 *
 * 为什么存在：实例窗口态（InstanceState）的 running 只声明调度位置
 * （非排队非挂起），main 恒 running——零信息量展示等于没展示，用户
 * 自行脑补成「正在干活」。观测面需要的是「此刻在干嘛」：main 编译会话
 * 运行态（SessionRunState——SessionRegistry.runStateOf 已消化的五态
 * 词汇），subagent 编译窗口态。domain 状态机零改动——本文件只是投影层。
 *
 * 词表单源：active/idle/queued/parked/done/failed/cancelled——
 * trace 面板（TraceQuery）与 agent_status（SchedulerService.toStatus）
 * 共用，观测面词汇不两套。
 */

import type { InstanceKind, InstanceState } from "./AgentInstance";

/** 人读观测态词表（观测面统一词汇——与调度/窗口状态机词汇解耦）。 */
export type DisplayState = "active" | "idle" | "queued" | "parked" | "done" | "failed" | "cancelled";

/** 会话运行态（SessionRunState——SessionRegistry.runStateOf 的三值词汇）。 */
export type SessionRunStateLike = "idle" | "streaming" | "subagent_running";

/**
 * 实时观测态编译（agent_status 回执 / 内存读面取数形状）。
 *
 * 编译规则：
 * - main → sessionRun：idle→idle（冷会话/无执行载体同）；streaming/
 *   subagent_running→active（有 subagent 在跑时 main 本身也是活跃编排者）；
 *   sessionRun 缺省（无读口注入）→ idle（SessionRegistry 冷会话同语义）；
 * - subagent → window 直译（窗口态对 single-shot 就是执行状态——
 *   「意图边界与生命周期边界重合」）。
 */
export function displayStateOf(input: {
  readonly kind: InstanceKind;
  /** 窗口六态（agent_status 实时读；main 恒 running 不参与 main 分支）。 */
  readonly window: InstanceState;
  /** 会话运行态（仅 main 消费；subagent 不传）。 */
  readonly sessionRun?: SessionRunStateLike;
}): DisplayState {
  if (input.kind === "main") {
    if (input.sessionRun === "streaming" || input.sessionRun === "subagent_running") return "active";
    return "idle";
  }
  switch (input.window) {
    case "queued":
      return "queued";
    case "running":
      return "active";
    case "parked":
      return "parked";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** trace 面板生命周期状态词汇（事件回放四值——与 InstanceState 不同源）。 */
export type TraceLifecycleStatus = "running" | "completed" | "failed" | "killed";

/**
 * trace 面板观测态编译（事件回放面——无实时窗口态/运行态，输入是
 * lifecycle 事件折叠的 status；main 的实时性经 mainSessionRun 注入
 * 补偿——事件行不含会话五态）。
 *
 * main：sessionRun 同 displayStateOf；subagent：status 直译
 * （running→active；completed→done；failed→failed；killed→cancelled）。
 */
export function traceDisplayOf(input: {
  readonly kind: InstanceKind;
  readonly status: TraceLifecycleStatus;
  readonly sessionRun?: SessionRunStateLike;
}): DisplayState {
  if (input.kind === "main") {
    return displayStateOf({ kind: "main", window: "running", sessionRun: input.sessionRun });
  }
  switch (input.status) {
    case "running":
      return "active";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "killed":
      return "cancelled";
  }
}
