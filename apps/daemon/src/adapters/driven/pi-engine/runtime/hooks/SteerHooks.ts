import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { HookSet, SteerCapable } from "../HookSet";

/**
 * SteerHooks —— steer()/abortController 接线（architecture.md §4.2）。
 *
 * 职责（v1 旁路 hack → 一等钩子的映射，§4.2）：
 * - 「send 矛盾 → steer()」：steer(text) 把用户注入转发 agent.steer()
 *   （即时入队；drain 精确发生在 turn_end → turn_start 边界，spike §5.3）；
 * - 「中断 → 内建 abortController」：每个 run（agent_start）装配一个
 *   AbortController——abort() 触发它并转发 agent.abort()；signal 经
 *   signal 属性暴露给其他钩子（如 beforeToolCall 挂起审批提前 resolve，
 *   spike §5.2-5），对齐 pi 的 abort 非销毁语义。
 */
export class SteerHooks implements HookSet, SteerCapable {
  readonly name = "steer";

  private agent: Agent | null = null;
  private controller: AbortController | null = null;

  bind(agent: Agent): void {
    this.agent = agent;
    // run 边界接线：每个 run 装配新的 AbortController（上个 run 的
    // signal 随 run 结束作废，避免跨 run 误触发）
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "agent_start") {
        this.controller = new AbortController();
      }
    });
  }

  /** 当前 run 的中断信号（供其他钩子/工具观察 abort；run 外为 undefined）。 */
  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  steer(text: string): void {
    this.requireAgent().steer({ role: "user", content: text, timestamp: Date.now() });
  }

  abort(): void {
    this.controller?.abort();
    this.requireAgent().abort();
  }

  private requireAgent(): Agent {
    if (!this.agent) throw new Error("SteerHooks 尚未装配（bind 未被调用）");
    return this.agent;
  }
}
