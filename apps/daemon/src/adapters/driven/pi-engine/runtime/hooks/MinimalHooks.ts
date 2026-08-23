import type { HookSet } from "../HookSet";

/**
 * MinimalHooks —— 最小钩子接线（architecture.md §4.2 / §4.4「W4 口径」）。
 *
 * 三个钩子位的最小版（全部安全直通），作为后续编排能力的生长点：
 * - beforeToolCall：放行（返回 undefined）——后续长成审批挂起/相位锁拦；
 * - prepareNextTurn：保持现状（返回 undefined）——长成动态提示装配；
 * - transformContext：原样返回——长成上下文注入/drift 处理。
 * 契约对齐 pi：钩子不抛错、安全降级（types.d.ts AgentLoopConfig 注释）。
 */
export class MinimalHooks implements HookSet {
  static readonly hookName = "minimal";

  readonly name = "minimal";

  async beforeToolCall(): Promise<undefined> {
    return undefined; // 放行：工具正常执行
  }

  async prepareNextTurn(): Promise<undefined> {
    return undefined; // 保持现状：不改下一轮 context/model/thinking
  }

  async transformContext(messages: Parameters<NonNullable<HookSet["transformContext"]>>[0]): Promise<typeof messages> {
    return messages; // 原样直通（不注入、不裁剪）
  }
}
