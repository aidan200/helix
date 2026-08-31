import { describe, expect, test } from "bun:test";
import { ParkGuardHooks } from "../../src/adapters/driven/subagent/child/ParkGuardHooks";

/**
 * ⑤ park/resume 批 T6（P6 双保险第二层）：beforeToolCall 硬拦截——
 * park 请求到达后（stdin 协议指令），该实例的工具调用一律拒绝（LLM 不听话
 * 也拦得住）；拦截提示 = 「已请求挂起，只能输出 PARK 标记或收口」+ terminate
 * 提示（本批工具结果后停止——加速收敛到 PARK 输出）。拦截位在子进程本地
 * hooks 链（R12 预留位首个实例）。
 */

describe("ParkGuardHooks（park 请求后工具调用硬拦截）", () => {
  test("未置挂起标志：放行（undefined——不干预正常执行）", async () => {
    const state = { parkRequested: false };
    const hook = new ParkGuardHooks(state);
    expect(hook.name).toBe("park-guard");
    await expect(hook.beforeToolCall()).resolves.toBeUndefined();
  });

  test("挂起标志置位：一律拒绝（block + 提示；不设 terminate——保留后续 turn 让模型输出 PARK）", async () => {
    const state = { parkRequested: true };
    const hook = new ParkGuardHooks(state);
    await expect(hook.beforeToolCall()).resolves.toEqual({
      block: true,
      reason: "已请求挂起，只能输出 PARK 标记或收口",
    });
  });

  test("标志共享对象驱动：置位即拦、复位即放（resume 复活）", async () => {
    const state = { parkRequested: false };
    const hook = new ParkGuardHooks(state);
    state.parkRequested = true;
    await expect(hook.beforeToolCall()).resolves.toMatchObject({ block: true });
    state.parkRequested = false;
    await expect(hook.beforeToolCall()).resolves.toBeUndefined();
  });
});
