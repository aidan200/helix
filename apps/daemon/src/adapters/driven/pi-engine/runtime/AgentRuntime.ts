import { Agent, convertToLlm } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Models } from "@earendil-works/pi-ai";
import type { AgentProfile } from "./AgentProfile";
import { hasSteer, type HookSet, type SteerCapable } from "./HookSet";
import { CompactionHook, type CompactionOutcome } from "./hooks/CompactionHook";
import { parseDataUrlImages } from "../../../../application/services/images";

/** data URL → pi ImageContent（AgentRuntime 驱动面单点解码）。 */
function toImageContent(dataUrl: string): ImageContent {
  const [image] = parseDataUrlImages([dataUrl]);
  if (image === undefined) throw new Error(`图片 data URL 解码异常：${dataUrl.slice(0, 32)}…`);
  return { type: "image", mimeType: image.mimeType, data: image.data };
}

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
 * **不自持领域状态副本**（聚合状态在 domain）、**不复刻**
 * 流式循环/工具批执行（那是 pi agentLoop 本体）。规模红线 ~百行级。
 */
export interface AgentRuntimeDeps {
  /** 流式补全函数（model-provider.createStreamFn 产出；测试注入 FakeLLM）。 */
  readonly streamFn: StreamFn;
  /** 已解析的模型对象。 */
  readonly model: Model<any>;
  /** pi 模型目录（compaction 摘要调用用；profile.compaction.enabled 时必传，fail-fast）。 */
  readonly models?: Models;
  /** 显式 key 查询（config.json apiKeys → pi 工厂；不走 env，AD-11/13）。 */
  readonly getApiKey: (provider: string) => string | undefined;
  /** 工具名 → pi AgentTool 解析器（组合根注入 CoreToolExecutor.resolveTools）。 */
  readonly resolveTools?: (names: readonly string[]) => AgentTool<any>[];
  /** turn 边界 compaction 完成上抛（adapter 转 port 事件）。 */
  readonly onCompactionCompleted?: (result: CompactionOutcome) => void;
  /** turn 边界 compaction 失败上抛（不崩会话，继续 turn）。 */
  readonly onCompactionFailed?: (message: string) => void;
  /**
   * 额外钩子实例（park/resume 批）：装配期已实例化的 HookSet 直接入链
   * ——profile.hooks 是构造器引用（T1 纯声明），需要运行期状态注入的钩子
   * （如子进程 ParkGuardHooks 共享挂起标志位）经此面接入。缺省不追加。
   */
  readonly extraHooks?: readonly HookSet[];
  /**
   * 恢复回填的初始 transcript（恢复回填批）：装配时注入 Agent 的
   * initialState.messages——mainAgent 实例窗口销毁重建后回填它自己的历史
   * （调用方经 seedMessagesOf 派生）；缺省 = 空历史（新建会话/新实例）。
   */
  readonly initialMessages?: readonly AgentMessage[];
}

export class AgentRuntime {
  private readonly agent: Agent;
  private readonly steerHook?: HookSet & SteerCapable;

  constructor(profile: AgentProfile, deps: AgentRuntimeDeps) {
    const compaction = compactionHooks(profile, deps);
    // hooks 声明为构造器引用（纯数据，T1）：在此装配点每 runtime 实例化——
    // SteerHooks.bind 绑 agent 引用，共享实例即跨 runtime 串台（P0）。
    // extraHooks（park/resume 批）为已实例化钩子（运行期状态注入面）直接追加。
    const hooks = [...profile.hooks.map((H) => new H()), ...compaction, ...(deps.extraHooks ?? [])];
    this.agent = new Agent({
      initialState: {
        systemPrompt: profile.systemPrompt,
        model: deps.model,
        tools: deps.resolveTools ? deps.resolveTools(profile.tools) : [],
        // 恢复回填：mainAgent 实例窗口销毁重建后回填它自己的历史（恢复回填批）；
        // 空/缺省 = 新实例（新建会话/阶段切换新实例）无历史。
        ...(deps.initialMessages !== undefined && deps.initialMessages.length > 0
          ? { messages: [...deps.initialMessages] }
          : {}),
      },
      streamFn: deps.streamFn,
      getApiKey: deps.getApiKey,
      steeringMode: "one-at-a-time", // 每条注入独占一个 turn（实测默认）
      // 压缩接线时同步启用 pi 的 LLM 转换器：compactionSummary 角色 →
      // 带前缀的 user 消息（缺省转换器会直接丢弃 summary，压缩历史丢失）
      ...(compaction.length > 0 ? { convertToLlm } : {}),
      transformContext: combineTransformContext(hooks),
      beforeToolCall: combineBeforeToolCall(hooks),
      prepareNextTurn: combinePrepareNextTurn(hooks),
    });
    for (const hook of hooks) hook.bind?.(this.agent);
    this.steerHook = hooks.find(hasSteer);
  }

  /** 驱动一轮 run：prompt 输入并等待 run 完全结束（含工具轮与注入 drain 轮）。
   * 图片上行：data URL 解码 → ImageContent[] → agent.prompt(input, images)。 */
  async drive(input: string, images?: readonly string[]): Promise<void> {
    const imageContents = images === undefined || images.length === 0 ? undefined : images.map(toImageContent);
    await this.agent.prompt(input, imageContents);
    await this.agent.waitForIdle();
  }

  /**
   * 从当前转录继续驱动（park/resume 批）：agent.continue() 语义——末消息为
   * assistant 时 drain steer 队列（挂起期暂存注入 + RESUME 指令）作为新
   * run 输入；末消息为 user/toolResult 时直接续跑。挂起恢复后同一会话
   * 从断点续跑的单点。
   */
  async continueRun(): Promise<void> {
    await this.agent.continue();
    await this.agent.waitForIdle();
  }

  /** 运行中注入（经装配的 SteerCapable 钩子转发；未装配即该 profile 不支持注入）。 */
  steer(text: string): void {
    if (!this.steerHook) throw new Error(`profile 未装配具备 steer 接线的 HookSet，不支持注入`);
    this.steerHook.steer(text);
  }

  /** 中断当前 run（非销毁）。 */
  abort(): void {
    if (this.steerHook) this.steerHook.abort();
    else this.agent.abort();
  }

  isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  /**
   * 运行期换模（AD-2）：AgentState.model 直改——pi 语义「Active model
   * used for future turns」：in-flight run 的 loop config 已快照模型不受影响，
   * 下一 run（drive）起生效。不走 prepareNextTurn 链（CompactionHook 占用
   * 且「首个非空生效」会短路，换模与压缩同 turn 触发会丢失——机械裁决）。
   */
  setModel(model: Model<any>): void {
    this.agent.state.model = model;
  }

  /**
   * 运行期改生效工具集（setModel 同构）：AgentState.tools 直改——
   * state.tools 是能力+提示双料事实源（provider function calling 面与分发
   * 面读同一数组，agent-loop「not found」兑底），移除即双断。入参须是已
   * resolve 的 AgentTool[]（调用方组合根经 CoreToolExecutor.resolveTools
   * 产物同源派生）。in-flight run 的 context snapshot 已定格不受影响，
   * 下一 run 起生效。
   */
  setTools(tools: AgentTool<any>[]): void {
    this.agent.state.tools = tools;
  }

  /**
   * 运行期改系统提示（setModel 同构）：AgentState.systemPrompt 直改，
   * 下一 run 起生效（不走 prepareNextTurn 链——同 setModel 机械裁决）。
   * 已知边界（§六登记）：run 中 compaction 与配置变更并发时，压缩 turn
   * 透传新 systemPrompt（run 内提前生效）——方向与意图一致，无害。
   */
  setSystemPrompt(systemPrompt: string): void {
    this.agent.state.systemPrompt = systemPrompt;
  }

  /**
   * 运行期 thinking 覆盖（thinking 批①，AD-4①；setModel 同构直改链，下一
   * turn 生效）。helix 自持覆盖字段——**不走** pi AgentState.thinkingLevel：
   * 其缺省 off 且 pi loop config 会把它直注 options.reasoning（无 §3.3 能力
   * 解析，reasoning=false 模型会被带参）；§6 纪律 = options.reasoning 唯一
   * 写入点是 streamFn 注入器（§3.5），覆盖态只是解析链的覆盖位输入。
   */
  private thinkingLevel: string | undefined;

  setThinking(level: string): void {
    this.thinkingLevel = level;
  }

  /** thinking 覆盖读面（解析链覆盖位 + currentThinking 观测面数据源）。 */
  get stateThinking(): string | undefined {
    return this.thinkingLevel;
  }

  /** 当前模型（可观测面：快照/徽标数据源）。 */
  get stateModel(): Model<any> {
    return this.agent.state.model;
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

/**
 * compaction 接线：profile.compaction.enabled 声明即装配
 * CompactionHook（消费声明字段，不感知任何会话形态，AG-10）；
 * enabled 而未注入 models → 装配期 fail-fast（摘要调用无处可去）。
 */
function compactionHooks(profile: AgentProfile, deps: AgentRuntimeDeps): HookSet[] {
  if (!profile.compaction?.enabled) return [];
  if (!deps.models) {
    throw new Error(
      `profile 声明 compaction（reserveTokens=${profile.compaction.reserveTokens}）但未注入 models——摘要调用无法装配（AgentRuntimeDeps.models 必传）`,
    );
  }
  return [
    new CompactionHook({
      settings: profile.compaction,
      models: deps.models,
      model: deps.model,
      onCompleted: deps.onCompactionCompleted,
      onFailed: deps.onCompactionFailed,
    }),
  ];
}
