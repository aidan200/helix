/**
 * RunWatchdog —— run 看门狗纯判定（DDD 重构批 2）。
 *
 * 定位：checkRunWatchdog 的**判定逻辑**抽成纯函数（快照 → verdict），零 IO
 * 零副作用——副作用（日志/通知/abort/强制收口）归应用层 tick 翻译。表驱动
 * 穷举可测（steward-run.test 六态）。
 *
 * 判定序（与批 2 前 checkRunWatchdog 逐分支等价）：
 * 1. idle（runActive=false 或 engine 缺席）→ idle-reset（看门狗锚复位）；
 * 2. 手动快进轨：manualAbortAt 在场且超 grace 仍 runActive →
 *    manual-fast-forward（挂死流 abort 打不醒——E-240 实测，不等被动 180s；
 *    优先于被动轨——手动停止批裁决）；
 * 3. 推进锚未锚定 → unanchored（runActive=true 但锚 undefined：收口复位与
 *    下一 run 置位间竞态窗口——不判挂起，CAND-666 哨兵防御「56 年级挂起
 *    时长」荒谬文案）；
 * 4. 未触发轨：无事件推进 ≥ watchdogMs → arm（携挂起秒数；gatedWait 由
 *    调用方置——挂闸等待是合法业务态，通知面在应用层分支）；
 * 5. 已触发轨：abort 宽限超时仍 runActive → force-recover（弃引擎重建——
 *    pi EventStream 不竞速 abort signal，弃引擎是挂死流唯一恢复路径）。
 *
 * 为什么存在：看门狗判定是管家事故重放的核心区（10-06 装死 20 分钟 /
 * 10-09 卡死 2m47s），判定分支隐式耦合阈值与锚语义；纯函数化后六态穷举
 * 表驱动，阈值经 StewardTuning 注入可配（批 0）。
 */

import type { StewardTuning } from "../tuning/StewardTuning";

/** 看门狗判定输入快照（run 状态容器的只读投影）。 */
export interface RunWatchdogSnapshot {
  readonly runActive: boolean;
  readonly enginePresent: boolean;
  readonly manualAbortAt: number | undefined;
  readonly runLastProgressAt: number | undefined;
  readonly watchdogFiredAt: number | undefined;
}

/** 判定结论（应用层 tick 按 kind 翻译副作用）。 */
export type RunWatchdogVerdict =
  | { readonly kind: "idle-reset" }
  | { readonly kind: "none" }
  | { readonly kind: "unanchored" }
  | { readonly kind: "manual-fast-forward" }
  | { readonly kind: "arm"; readonly hungSeconds: number }
  | { readonly kind: "force-recover"; readonly reason: string };

/** 看门狗判定（纯函数——判定序见模块头注释，与批 2 前逐分支等价）。 */
export function judgeRunWatchdog(
  snapshot: RunWatchdogSnapshot,
  tuning: StewardTuning,
  now: number,
): RunWatchdogVerdict {
  if (!snapshot.runActive || !snapshot.enginePresent) return { kind: "idle-reset" };
  // 手动停止快进轨：abort 后宽限内仍 runActive 直接强制收口（不等被动 180s）。
  // manualAbortAt 有值 ⇔ abortInFlight 曾在 runActive+engine 双在场时置锚。
  if (
    snapshot.manualAbortAt !== undefined &&
    now - snapshot.manualAbortAt >= tuning.run.manualAbortGraceMs
  ) {
    return { kind: "manual-fast-forward" };
  }
  if (snapshot.runLastProgressAt === undefined) {
    // 推进锚未锚定（收口复位与下一 run 置位之间的竞态窗口）——未锚定不判
    // 挂起（哨兵 undefined 而非 0：测试时钟域起点 0 是合法锚定值）。
    return { kind: "unanchored" };
  }
  if (snapshot.watchdogFiredAt === undefined) {
    if (now - snapshot.runLastProgressAt < tuning.run.watchdogMs) return { kind: "none" };
    return { kind: "arm", hungSeconds: Math.round((now - snapshot.runLastProgressAt) / 1000) };
  }
  // 已触发：宽限窗后仍未收口 → 强制收口（abort 打不醒的挂死流）
  if (now - snapshot.watchdogFiredAt >= tuning.run.watchdogAbortGraceMs) {
    return {
      kind: "force-recover",
      reason: `run 看门狗强制收口：abort 宽限 ${tuning.run.watchdogAbortGraceMs / 1000}s 内 run 未收口——弃引擎重建并恢复队列服务`,
    };
  }
  return { kind: "none" };
}
