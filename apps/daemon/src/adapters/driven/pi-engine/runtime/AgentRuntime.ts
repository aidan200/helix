import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentProfile } from "./AgentProfile";
import { hasSteer, type HookSet, type SteerCapable } from "./HookSet";

/**
 * AgentRuntime —— daemon 唯一驱动层（architecture.md §4.2 第三层）。
 *
 * 职责边界（AD-3「loop 本体一行不重写」）：
 * - 组装：按 AgentProfile 声明构造 pi Agent（系统提示/模型/工具/钩子位），
 *   并把 HookSet 们组合进 Agent 的钩子参数（装配即启用）；
 * - 驱动：drive/steer/abort 三个动作透传 Agent（prompt/waitForIdle/steer/abort）；
 * - 生命周期：事件订阅转发。
 *
 * 它**不感知任何编排模式**（不知道任何具体会话形态的存在，AG-10）、
 * **不自持领域状态副本**（聚合状态在 domain，TP-CL4-5）、**不复刻**
 * 流式循环/工具批执行（那是 pi agentLoop 本体）。规模红线 ~百行级。
 */
export interface AgentRuntimeDeps {
  /** 流式补全函数（model-provider.createStreamFn 产出；测试注入 FakeLLM）。 */
  readonly streamFn: StreamFn;
  /** 已解析的模型对象。 */
  readonly model: Model<any>;
  /** 显式 key 查询（config.json apiKeys → pi 工厂；不走 env，AD-11/13）。 */
  readonly getApiKey: (provider: string) => string | undefined;
  /** 工具名 → pi AgentTool 解析器（T1.5 前恒空集）。 */
  readonly resolveTools?: (names: readonly string[]) => AgentTool<any>[];
}

export class AgentRuntime {
  private readonly agent: Agent;
  private readonly steerHook?: HookSet & SteerCapable;

  constructor(profile: AgentProfile, deps: AgentRuntimeDeps) {
    const hooks = profile.hooks;
    this.agent = new Agent({
      initialState: {
        systemPrompt: profile.systemPrompt,
        model: deps.model,
        tools: deps.resolveTools ? deps.resolveTools(profile.tools) : [],
      },
      streamFn: deps.streamFn,
      getApiKey: deps.getApiKey,
      steeringMode: "one-at-a-time", // 每条注入独占一个 turn（spike §5.3-4 实测默认）
      transformContext: combineTransformContext(hooks),
      beforeToolCall: combineBeforeToolCall(hooks),
      prepareNextTurn: combinePrepareNextTurn(hooks),
    });
    for (const hook of hooks) hook.bind?.(this.agent);
    this.steerHook = hooks.find(hasSteer);
  }

  /** 驱动一轮 run：prompt 输入并等待 run 完全结束（含工具轮与注入 drain 轮）。 */
  async drive(input: string): Promise<void> {
    await this.agent.prompt(input);
    await this.agent.waitForIdle();
  }

  /** 运行中注入（经装配的 SteerCapable 钩子转发；未装配即该 profile 不支持注入）。 */
  steer(text: string): void {
    if (!this.steerHook) throw new Error(`profile 未装配具备 steer 接线的 HookSet，不支持注入`);
    this.steerHook.steer(text);
  }

  /** 中断当前 run（非销毁，spike §5.4）。 */
  abort(): void {
    if (this.steerHook) this.steerHook.abort();
    else this.agent.abort();
  }

  isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  /** 事件订阅（转发 pi AgentEvent；退订函数返回）。 */
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void): () => void {
    return this.agent.subscribe(listener);
  }
}

// ── 钩子组合（装配期纯函数，无状态） ────────────────────────

/** beforeToolCall 链：依序执行，首个非空结果（block）短路返回。 */
function combineBeforeToolCall(hooks: readonly HookSet[]) {
  if (!hooks.some((h) => h.beforeToolCall)) return undefined;
  return async (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    for (const hook of hooks) {
      if (!hook.beforeToolCall) continue;
      const result = await hook.beforeToolCall(context, signal);
      if (result) return result;
    }
    return undefined;
  };
}

/** transformContext 链：依序串接（前一个输出是后一个输入）。 */
function combineTransformContext(hooks: readonly HookSet[]) {
  if (!hooks.some((h) => h.transformContext)) return undefined;
  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    let current = messages;
    for (const hook of hooks) {
      if (!hook.transformContext) continue;
      current = await hook.transformContext(current, signal);
    }
    return current;
  };
}

/** prepareNextTurn 链：首个非空替换状态生效。 */
function combinePrepareNextTurn(hooks: readonly HookSet[]) {
  if (!hooks.some((h) => h.prepareNextTurn)) return undefined;
  return async (signal?: AbortSignal): Promise<AgentLoopTurnUpdate | undefined> => {
    for (const hook of hooks) {
      if (!hook.prepareNextTurn) continue;
      const update = await hook.prepareNextTurn(signal);
      if (update) return update;
    }
    return undefined;
  };
}
