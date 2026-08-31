import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { HookSet } from "../../pi-engine/runtime/HookSet";

/**
 * ParkGuardHooks —— 子进程本地挂起硬拦截（park/resume 批 P6 双保险第二层，
 * 设计稿 §2.2；R12 预留位（beforeToolCall 拦截）的首个实例）。
 *
 * 协作式第一层（PARK 标记协议）失败时的机械强制：park 请求经 stdin 协议
 * 指令到达即置挂起标志，此后本实例的工具调用一律拒绝（reason 成为错误
 * 工具结果）——LLM 不听话也拦得住，只能输出 PARK 标记或收口。terminate
 * 提示本批后停止（加速收敛：被拦的工具结果让模型立即转向文本输出）。
 *
 * 标志经共享状态对象驱动（ChildMain stdin 读取器置位 / RESUME 复位）；
 * PARK 标记输出后子进程进入挂起等待（无 run 无工具调用），拦截自然静默。
 */
export class ParkGuardHooks implements HookSet {
  static readonly hookName = "park-guard"; // 事实源（装配面读面）

  /** 实例 name 派生自 static hookName（T8-M3 单源化先例）。 */
  get name(): string {
    return ParkGuardHooks.hookName;
  }

  constructor(private readonly state: { parkRequested: boolean }) {}

  async beforeToolCall(
    _context?: BeforeToolCallContext,
    _signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> {
    if (!this.state.parkRequested) return undefined; // 放行：正常执行
    // 不设 terminate：早停会掐断后续 turn（模型失去输出 PARK 标记的机会，
    // 破坏协作式第一层）——被拦的错误工具结果已足够引导模型转向文本输出
    return {
      block: true,
      reason: "已请求挂起，只能输出 PARK 标记或收口",
    };
  }
}
