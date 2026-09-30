/**
 * contracts/pause —— loop 域暂停原语契约（helix-loop Phase 0a 四层拆分；
 * 原 LoopTypes.ts 按主题拆六件之一，设计 §2.1）。
 *
 * beforeToolCallPause 挂闸判定 + 外部裁决决策（暂停原语——helix 独有，
 * 比 pi 的 block-or-pass 多「暂停后继续」；设计 §4① 不变量：四态
 * approve/approveWith/reject/resolve + 递归暂停同构）。
 */
import type { LoopToolOutcome } from "./tool";

/** 暂停恢复决策（beforeToolCallPause 挂闸后的外部裁决面——确认闸语义）。 */
export type LoopResumeDecision =
  /** 放行原参执行（handler 正常路径）。 */
  | { readonly kind: "approve" }
  /** 改参执行。 */
  | { readonly kind: "approveWith"; readonly args: Record<string, unknown> }
  /** 拒绝：toolResult(拒绝文案) 回灌 + 循环继续（模型可自纠）。 */
  | { readonly kind: "reject"; readonly text: string }
  /** 外部已执行：toolResult(text) 回灌 + run 终止（confirm 执行体路径）。 */
  | { readonly kind: "resolve"; readonly text: string; readonly isError?: boolean };

/** beforeToolCallPause 挂钩判定（工具执行前可挂起——helix 独有暂停原语，
 *  比 pi 的 block-or-pass 多「暂停后继续」；设计 §4①）。
 *  pause:false + outcome = 挂钩内前置校验产物（跳过 handler 执行直接回灌——
 *  校验单点在挂钩，approve 后 handler 才执行写动作）。 */
export type LoopPauseDecision =
  | { readonly pause: false; readonly outcome?: LoopToolOutcome }
  | { readonly pause: true };
