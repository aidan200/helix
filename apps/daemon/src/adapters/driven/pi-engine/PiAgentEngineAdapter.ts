import type {
  AgentEngineEvent,
  AgentEngineListener,
  AgentEnginePort,
  AgentThinkingState,
  EngineResumeDecision,
} from "../../../application/ports/outbound/AgentEnginePort";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "./runtime/AgentRuntime";
import type { AgentProfile } from "./runtime/AgentProfile";
import type { AgentRuntimeDeps } from "./runtime/AgentRuntime";
import { ApprovalGateHook, type ApprovalGatePausedInfo } from "./runtime/hooks/ApprovalGateHook";
import { buildModels, createStreamFn, explicitGetApiKey, resolveModel, resolveModelSlot, wrapStreamFnThinking } from "../llm";
import { withNetworkRetry } from "../llm";
import { stopReasonOf, errorMessageOf, textOfContent, textOfMessage, usageOf } from "./mappers/SessionMapper";
import { imagesOfContent } from "../../../application/services/images";

/**
 * PiAgentEngineAdapter —— AgentEnginePort 的 pi 实现（防腐墙本体，§3.5）。
 *
 * 对外只暴露 port 语义（start/steer/abort/isStreaming + 引擎事件回调）；
 * 对内：AgentRuntime 装配驱动（loop 本体 import 复用，AD-3）、
 * pi AgentEvent → port 引擎事件的薄翻译（时序契约等价，
 * FakeAgentEngine 是本翻译契约的 mock 侧镜像）。
 */
export interface PiEngineOptions {
  /** 声明式 agent 规格（MainSessionProfile / SubAgentProfile / 测试 TestProfile）。 */
  readonly profile: AgentProfile;
  /**
   * 已解析的完整模型对象（透传单点产物：resolveConfigModel）。
   * profile.model 声明槽位时在装配期覆写解析（resolveModelSlot，fail-fast 含 id）；
   * 未声明则同引用透传本对象（缺省继承，AD-6）。
   */
  readonly model: Model<any>;
  /**
   * provider → apiKey（AD-11/13 显式传值；AD-2：数据源改 auth.json
   * ——接受静态表或 getter（getter 每请求读现值，换 key 后下一请求生效）。
   */
  readonly apiKeys: Record<string, string> | (() => Record<string, string>);
  /** provider 目录（缺省 builtinModels()；测试注入 fake catalog）。 */
  readonly models?: Models;
  /**
   * 运行期换模解析器（setModel 按 id 解析完整 Model 对象；组合根
   * 注入 catalog 活解析面——overlay 刷新后新模型可达；缺省 = 静态 models）。
   */
  readonly resolveModelById?: (modelId: string) => Model<any>;
  /** 流式函数覆盖（测试注入 FakeLLM 剧本）。 */
  readonly streamFnOverride?: StreamFn;
  /**
   * thinking 解析读面（architecture.md §3.5 注入器装配点；thinking 批）：
   * 注入后 streamFn（含 streamFnOverride——fake 剧本通道同被包装，测试
   * 可捕获 options.reasoning）经 wrapStreamFnThinking 包装，每次 stream
   * 调用开始重读本 getter；返回 undefined = 不动 options（provider 默认）。
   * 缺省 = 不装注入器（既有行为逐字节不变）。主会话解析链读面归 T1.2；
   * SubAgent 子进程 = 定格值 + 能力过滤（T1.3）。
   */
  readonly resolveThinking?: (model: Model<any>) => string | undefined;
  /** 工具集装配器（CoreToolExecutor.resolveTools，组合根接线）。 */
  readonly resolveTools?: AgentRuntimeDeps["resolveTools"];
  /**
   * 额外钩子实例（park/resume 批）：透传 AgentRuntimeDeps.extraHooks——
   * 需要运行期状态注入的钩子（子进程 ParkGuardHooks 挂起标志位）经此面
   * 接入 hooks 链；缺省不追加（既有装配行为不变）。
   */
  readonly extraHooks?: AgentRuntimeDeps["extraHooks"];
  /**
   * 恢复回填的初始 transcript（恢复回填批）：透传 AgentRuntimeDeps.initialMessages
   * ——mainAgent 实例窗口销毁重建后回填它自己的历史（组合根经 seedMessagesOf
   * 派生）；缺省 = 空历史（新建会话/新实例）。
   */
  readonly initialMessages?: readonly AgentMessage[];
  /**
   * 网络重试配置（P2 ⑦，引擎级全局生效：主会话/子进程编排器同源包装）：
   * backoffMs/sleep 注入 = 测试假时钟面；缺省 10/30/60s 退避 + 真等待
   * （abort 感知）。重试进入等待时经监听器发 engine_retrying 事件
   * （chat 可见反馈/日志数据源）。streamBackoffMs = 流中断快速档
   * （transient-fast，引擎错误体验批 2026-09-19：5s 单次）。
   */
  readonly retry?: {
    readonly backoffMs?: readonly number[];
    readonly streamBackoffMs?: readonly number[];
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
  /**
   * 审批闸（暂停四态 POC 落地批）：携带即装配 ApprovalGateHook——
   * 命中策略的工具调用挂闸（engine_paused + resume 四态，POC 15/15 验证）；
   * 缺省不装配（既有装配行为不变，零漂移）。approve/reject 完整；
   * approveWith/resolve 超 pi BeforeToolCallResult 能力面（resume 显式报错）。
   */
  readonly approvalGate?: {
    readonly shouldGate: (toolName: string, args: unknown) => boolean;
  };
  /**
   * 常驻事件监听器（管家批段B additive）：跨 run 存活的事件通道——与
   * start()/continueRun() 的逐 run listener 互补（后者在 run 收口后置空，
   * 而 followUp 队列驱动的后继 run 在 start() 返回后才自动开，逐 run 面
   * 看不到）。跨 run 消费者（管家：对话投影/队列收口/暂停侦测）经此面
   * 订阅；缺省不装（既有行为不变）。
   */
  readonly persistentListener?: AgentEngineListener;
  /**
   * 压缩摘要 prompt 覆写（管家批段B）：profile.compaction 声明压缩时的
   * customInstructions 透传（vendored compact 第 4 参原生位）。
   */
  readonly compactionCustomInstructions?: string;
  /** 压缩摘要请求覆写（管家批段B——透传 AgentRuntime→CompactionHook）。 */
  readonly compactionSummarizeRequest?: AgentRuntimeDeps["compactionSummarizeRequest"];
  /** 压缩触发档位（管家批段B——透传 AgentRuntime→CompactionHook）。 */
  readonly compactionTrigger?: AgentRuntimeDeps["compactionTrigger"];
}

export class PiAgentEngineAdapter implements AgentEnginePort {
  private readonly runtime: AgentRuntime;
  private listener: AgentEngineListener | null = null;
  /** 常驻监听器（persistentListener 选项——跨 run 事件通道）。 */
  private readonly persistentListener: AgentEngineListener | null;

  /** 双发（段B）：逐 run listener + 常驻监听器同步转发——构造期回调用此面
   *  （engine_paused/compaction/retrying 等生命周期事件不得绕过常驻面：
   *  followUp 后继 run 与挂闸暂停只发生在 start() 逐 run listener 之外）。 */
  private emitAll(event: AgentEngineEvent): void {
    this.listener?.(event);
    this.persistentListener?.(event);
  }
  /** 审批闸钩子（本批）：未装配 = undefined（resume 面恒报错）。 */
  private readonly gate?: ApprovalGateHook;
  /** 已 steer 的文本（FIFO）：drain 边界的 user 消息据此判别来源。 */
  private readonly steeredTexts: string[] = [];
  /**
   * 本 run 输入形态（code-review 低危：同文 prompt 误标 steer-drain）：
   * start 的 run 首条 user 消息恒 prompt（prompt 消息只在 run 开头出现）
   * 不参与 drain 匹配——run 间隙排队的 steer 与同文 prompt 不再互串；
   * continueRun 的 run 首条 user 消息恰是队列 drain 产物（末消息
   * assistant 时以暂存注入为新 run 输入），正常参与匹配。
   */
  private runInputIsPrompt = true;
  /** 本 run 是否已见过 user 消息（首条豁免判别的计数位；agent_start 重置）。 */
  private seenUserInRun = false;
  /** setModel 解析面（catalog 活解析优先，静态 models 兑底）。 */
  private readonly resolveById: (modelId: string) => Model<any>;
  /** thinking 解析读面（§3.5 注入器同源 getter；currentThinking 生效档计算复用）。 */
  private readonly resolveThinkingFn?: (model: Model<any>) => string | undefined;
  /** setTools 装配面（CoreToolExecutor.resolveTools 既有注入路径）。 */
  private readonly resolveToolsFn: AgentRuntimeDeps["resolveTools"];

  constructor(options: PiEngineOptions) {
    const models = options.models ?? buildModels();
    this.persistentListener = options.persistentListener ?? null;
    this.resolveById = options.resolveModelById ?? ((id) => resolveModel(models, id));
    this.resolveToolsFn = options.resolveTools;
    this.resolveThinkingFn = options.resolveThinking;
    // §3.5 透传注入器装配：包装在 override 判定外侧——fake 剧本通道
    // （streamFnOverride）同样被注入器包裹（定格值进 options.reasoning 可捕获），
    // override 槽位语义不被破坏（仍是唯一 streamFn 来源）
    const baseStreamFn = options.streamFnOverride ?? createStreamFn(models);
    const thinkingStreamFn =
      options.resolveThinking === undefined ? baseStreamFn : wrapStreamFnThinking(baseStreamFn, options.resolveThinking);
    // P2 ⑦ 网络重试：重试包装在最外层（每轮重试重新过 thinking 解析）；
    // 主会话/子进程/编排器三装配点同源生效。fake 剧本通道同被包裹。
    // 分类纪律 = TR-195 现行口径（2026-09-19/21 修订，与 network-retry.ts
    // 实现同步）：传输层错误（连接/超时/socket 断开）退避档重试；
    // 5xx/流中断/Anthropic refusal（库常量串）收编 transient-fast 5s 单次
    // 快速重试；4xx/429/配额 permanent 快速失败；缺省 permanent（fail-fast，
    // 错判 transient 代价 = 每 agent 白等——GLM 1308 事故实证）。重试回调
    // 经监听器发 engine_retrying（等待期可观测）
    const streamFn = withNetworkRetry(thinkingStreamFn, {
      ...(options.retry?.backoffMs !== undefined ? { backoffMs: options.retry.backoffMs } : {}),
      ...(options.retry?.streamBackoffMs !== undefined ? { streamBackoffMs: options.retry.streamBackoffMs } : {}),
      ...(options.retry?.sleep !== undefined ? { sleep: options.retry.sleep } : {}),
      onRetry: (info) =>
        this.emitAll({
          type: "engine_retrying",
          attempt: info.attempt,
          totalAttempts: info.totalAttempts,
          waitMs: info.waitMs,
          message: info.message,
        }),
    });
    // 审批闸（本批）：携带即装配——engine_paused 经 listener 直发（挂闸即发，
    // 早于决策 await——消费方拿到凭据即可 resume）；已实例化钩子经 extraHooks
    // 入链（运行期状态注入面，AgentRuntimeDeps 契约）。
    this.gate =
      options.approvalGate === undefined
        ? undefined
        : new ApprovalGateHook({
            shouldGate: options.approvalGate.shouldGate,
            onPaused: (info: ApprovalGatePausedInfo) => this.emitAll({ type: "engine_paused", ...info }),
          });
    this.runtime = new AgentRuntime(options.profile, {
      streamFn,
      model: resolveModelSlot(options.profile.model, options.model, models),
      models,
      getApiKey: explicitGetApiKey(options.apiKeys),
      resolveTools: options.resolveTools,
      ...(options.extraHooks !== undefined || this.gate !== undefined
        ? { extraHooks: [...(options.extraHooks ?? []), ...(this.gate ? [this.gate] : [])] }
        : {}),
      ...(options.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}),
      // turn 边界 compaction 产物 → port 事件（失败走 engine_error，不崩会话）
      ...(options.compactionCustomInstructions !== undefined
        ? { compactionCustomInstructions: options.compactionCustomInstructions }
        : {}),
      ...(options.compactionSummarizeRequest !== undefined
        ? { compactionSummarizeRequest: options.compactionSummarizeRequest }
        : {}),
      ...(options.compactionTrigger !== undefined ? { compactionTrigger: options.compactionTrigger } : {}),
      onCompactionCompleted: (r) =>
        this.emitAll({
          type: "compaction_completed",
          tokensBefore: r.tokensBefore,
          tokensAfter: r.tokensAfter,
          summary: r.summary,
          ...(r.usage !== undefined ? { usage: r.usage } : {}),
        }),
      onCompactionFailed: (message) => this.emitAll({ type: "engine_error", message }),
    });
    this.runtime.subscribe((event) => this.onPiEvent(event));
  }

  async start(input: string, listener: AgentEngineListener, images?: readonly string[]): Promise<void> {
    this.listener = listener;
    this.runInputIsPrompt = true; // run 首条 user 消息恒 prompt（drain 判别豁免，见字段注）
    try {
      await this.runtime.drive(input, images);
    } finally {
      this.steeredTexts.length = 0; // run 边界清理（code-review M17）：abort/提前结束的残留防下一 run 同文 prompt 误判 steer-drain
      this.listener = null;
    }
  }

  /**
   * 从当前转录继续驱动（park/resume 批，子进程挂起恢复专用）：agent.continue()
   * 语义——末消息 assistant 时 drain steer 队列（暂存注入 + RESUME 指令）
   * 作为新 run 输入。事件时序与 start 同源（同一监听器翻译链）。
   */
  async continueRun(listener: AgentEngineListener): Promise<void> {
    this.listener = listener;
    this.runInputIsPrompt = false; // run 首条 user 消息是队列 drain 产物（正常参与匹配）
    try {
      await this.runtime.continueRun();
    } finally {
      this.steeredTexts.length = 0; // run 边界清理（M17 同 start）
      this.listener = null;
    }
  }

  steer(text: string): void {
    // 先驱动后登记（清单 #2.7）：runtime.steer 在 profile 无 SteerCapable 钩子时
    // 抛错（AgentRuntime.steer 守卫）——先 push 会残留文本，使下一 run 同文
    // user 消息被误判 source=steer-drain（drain 判别见 onPiEvent message_start）
    this.runtime.steer(text);
    this.steeredTexts.push(text);
  }

  /** followUp 入队（管家批段B additive，pi 原生语义）：即时入队；活跃 run
   *  在 turn 边界消费（steering 优先），idle 后队列存活待下次 start()/
   *  continueRun() 驱动（不自动开 run；不进 steeredTexts，drain 消息
   *  source="prompt"——pi 事件面无 drain 源标记）。跨 run 事件面见
   *  persistentListener 选项。 */
  followUp(text: string): void {
    this.runtime.followUp(text);
  }

  abort(): void {
    this.runtime.abort();
  }

  /**
   * 挂闸暂停恢复（port additive 面，设计 §7.4；loop 通道同构）：凭据 → 决策
   * 续跑。四态中 approve/reject 完整；resolve 经 **block+terminate 翻译**
   * （段B：结果入账 + run 终结——loop 域 resolve 的 pi 映射，isError 由 pi
   * 强制 true 是声明偏差）；approveWith 超 pi 能力面（无参数改写）——显式
   * 报错不静默降级。未装配审批闸的 adapter 本面恒报错（能力面自描述）。
   */
  async resume(pauseToken: string, decision: EngineResumeDecision): Promise<void> {
    if (this.gate === undefined) {
      throw new Error("本引擎未装配审批闸（approvalGate）——resume 面不可用");
    }
    if (decision.kind === "approveWith") {
      throw new Error(
        `pi 通道审批闸不支持 ${decision.kind}（BeforeToolCallResult 无参数改写——能力面差异，loop 通道原生支持）`,
      );
    }
    this.gate.resume(
      pauseToken,
      decision.kind === "approve"
        ? { kind: "approve" }
        : decision.kind === "reject"
          ? { kind: "reject", text: decision.text }
          : { kind: "resolve", text: decision.text },
    );
  }

  isStreaming(): boolean {
    return this.runtime.isStreaming();
  }

  /** 当前模型 id（可观测面：快照/徽标 model 位数据源）。 */
  currentModel(): string {
    const m = this.runtime.stateModel;
    return `${m.provider}/${m.id}`;
  }

  /**
   * 运行期换模（AD-2）：按 id 解析完整 Model（目录/catalog 面）后
   * 直改 AgentState.model——下一 turn 生效，in-flight run 不受影响。
   */
  setModel(modelId: string): void {
    this.runtime.setModel(this.resolveById(modelId));
  }

  /**
   * 运行期改生效工具集（setModel 同构）：names 经注入的 resolveTools
   * （CoreToolExecutor 既有路径）重解析成 AgentTool[] 后直改 AgentState.tools
   * ——能力+提示双料同源，下一 turn 生效。未注入 resolveTools（纯测试形态）
   * → fail-fast 不静默。
   */
  setTools(names: readonly string[]): void {
    this.runtime.setTools(this.requireResolveTools(names)(names));
  }

  /**
   * 守卫收敛：未注入 resolveTools 装配面即 fail-fast 不静默
   * （同款消息模板；收敛的是守卫模板而非行为统一——setModel 静态兑底 /
   * setSystemPrompt 纯直通语义保持不变）。返回注入面供调用点直用。
   */
  private requireResolveTools(
    names: readonly string[],
  ): Exclude<AgentRuntimeDeps["resolveTools"], undefined> {
    if (this.resolveToolsFn === undefined) {
      throw new Error(
        `引擎未注入 resolveTools 装配面（PiEngineOptions.resolveTools），无法运行期改工具集：${names.join(", ")}`,
      );
    }
    return this.resolveToolsFn;
  }

  /** 运行期改系统提示（setModel 同构）：直改 AgentState.systemPrompt，下一 turn 生效。 */
  setSystemPrompt(text: string): void {
    this.runtime.setSystemPrompt(text);
  }

  /** 运行期 thinking 覆盖（thinking 批①，AD-4①；setModel 同构直改链，下一 turn 生效）。 */
  setThinking(level: string): void {
    this.runtime.setThinking(level);
  }

  /**
   * thinking 覆盖读面（解析链覆盖位回读——供组合根 engineFor 解析闭包消费；
   * 不含生效计算，避免与 currentThinking 互调递归）。
   */
  thinkingOverride(): string | undefined {
    return this.runtime.stateThinking;
  }

  /**
   * 当前 thinking 覆盖/生效（可观测面：快照 thinking 位 + thinking.changed 广播
   * 数据源）。生效档 = 装配的解析读面按当前模型现值重算（与注入器同源同时点语义）；
   * 未装解析读面 → effective = null（不装注入器的测试形态行为不变）。
   */
  currentThinking(): AgentThinkingState {
    const override = this.runtime.stateThinking ?? null;
    const effective = this.resolveThinkingFn?.(this.runtime.stateModel) ?? null;
    return { override, effective };
  }

  /** pi AgentEvent → port 引擎事件（时序契约 §5 等价的真引擎侧）。
   * 逐 run listener（start/continueRun）之外，常驻监听器（persistentListener）
   * 同步转发——跨 run 消费面（followUp 后继 run）可见。 */
  private onPiEvent(event: AgentEvent): void {
    const emit = (e: AgentEngineEvent) => {
      this.listener?.(e);
      this.persistentListener?.(e);
    };
    switch (event.type) {
      case "agent_start":
        this.seenUserInRun = false; // run 边界重置（首条 user 判别计数位）
        return emit({ type: "agent_start" });
      case "agent_end":
        return emit({ type: "agent_end", messageCount: event.messages.length });
      case "turn_start":
        return emit({ type: "turn_start" });
      case "turn_end":
        return emit({ type: "turn_end", toolResultCount: event.toolResults.length });
      case "message_start": {
        // 0.87：loop 会以正常事件流发出 system 消息（prompt/工具宣告载体）——
        // 引擎内部机制不进对话流事件面（port role 封闭三角色），静默滤除。
        if ((event.message as { role: string }).role === "system") return;
        const role = event.message.role as "user" | "assistant" | "toolResult";
        // drain 判别：run 中出现的 user 消息且文本与最早的 steer 注入一致
        //（注入消息出现在 turn 边界；prompt 的 user 消息只在 run 开头出现）。
        // 首条 user 豁免（start 形态）：run 间隙排队的 steer 与同文 prompt 不再互串
        //（prompt 吃掉队头 → 后续真 drain 错判 prompt 的双错位）。
        const firstUserInRun = role === "user" && !this.seenUserInRun;
        if (role === "user") this.seenUserInRun = true;
        let source: "prompt" | "steer-drain" = "prompt";
        if (role === "user" && !(firstUserInRun && this.runInputIsPrompt) && this.steeredTexts.length > 0) {
          const text = textOfMessage(event.message);
          if (text === this.steeredTexts[0]) {
            source = "steer-drain";
            this.steeredTexts.shift();
          }
        }
        return emit({ type: "message_start", role, source });
      }
      case "message_update": {
        // 文本增量透传对话流；thinking 块流透传通道族（不再丢弃）
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          emit({ type: "message_update", delta: ame.delta });
        } else if (ame.type === "thinking_start") {
          emit({ type: "thinking_started", contentIndex: ame.contentIndex });
        } else if (ame.type === "thinking_delta") {
          emit({ type: "thinking_delta", contentIndex: ame.contentIndex, delta: ame.delta });
        } else if (ame.type === "thinking_end") {
          emit({ type: "thinking_end", contentIndex: ame.contentIndex, content: ame.content });
        }
        return;
      }
      case "message_end": {
        if ((event.message as { role: string }).role === "system") return; // 同 message_start：system 消息滤除
        const role = event.message.role as "user" | "assistant" | "toolResult";
        // assistant 消息携带 usage 时提取（七字段防腐，账目本体归 UsageLedger）
        const usage = role === "assistant" ? usageOf(event.message) : undefined;
        const stopReason = role === "assistant" ? stopReasonOf(event.message) : undefined;
        // 管家批段B additive 载荷：toolResult 配对锚 + assistant 完整块集
        //（thinking/toolCall 投影精度面——text 是拼接便利面）
        const tr = role === "toolResult" ? (event.message as { toolCallId?: string; toolName?: string }) : undefined;
        const toolCallId = tr?.toolCallId;
        const toolName = tr?.toolName;
        const blocks = role === "assistant" ? engineBlocksOf((event.message as { content?: readonly unknown[] }).content) : undefined;
        emit({
          type: "message_end",
          role,
          text: textOfMessage(event.message),
          stopReason,
          ...(usage !== undefined ? { usage } : {}),
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
          ...(blocks !== undefined ? { blocks } : {}),
        });
        // 终验热修：模型调用失败（stopReason=error，pi 归一化帧/消息）→
        // engine_error 事件透传 provider 原文（adapter 不吞错，不崩会话）。
        if (role === "assistant" && stopReason === "error") {
          emit({ type: "engine_error", message: errorMessageOf(event.message) });
        }
        return;
      }
      case "tool_execution_start":
        return emit({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      case "tool_execution_end": {
        // 图片下行：工具结果 content 内 image 块 → images data URL
        //（textOfResult 同源逻辑不动；模型在 pi 侧已直接收到 image 块）
        const images = imagesOfContent((event.result as { content?: unknown } | undefined)?.content);
        return emit({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          result: textOfContent((event.result as { content?: unknown } | undefined)?.content),
          ...(images.length > 0 ? { images } : {}),
        });
      }
      default:
        return; // tool_execution_update 等中间观测面暂不透传（工具接线时评估）
    }
  }
}

/** pi assistant content 块 → port 中立块集（段B additive：dialog 投影精度面——
 * thinking 异名双射（pi thinking ↔ port text）、toolCall arguments→args）。 */
function engineBlocksOf(content: readonly unknown[] | undefined): import("../../../application/ports/outbound/AgentEnginePort").AgentEngineContentBlock[] | undefined {
  if (content === undefined) return undefined;
  return content.map((b) => {
    const blk = b as Record<string, unknown>;
    if (blk.type === "text") return { type: "text", text: String(blk.text ?? "") };
    if (blk.type === "thinking") {
      // pi ThinkingContent 签名字段是 thinkingSignature（pi-ai types），非 signature——
      // 与 PiStewardLlmAdapter.toResponse 同口径；漏读会令下游取块签名恒空、
      // 回放侧无签名 thinking 被判不可回传丢弃（评审 B8）。
      const sig = blk.thinkingSignature ?? blk.signature;
      return { type: "thinking", text: String(blk.thinking ?? ""), ...(sig !== undefined ? { signature: String(sig) } : {}) };
    }
    if (blk.type === "toolCall") {
      return { type: "toolCall", id: String(blk.id), name: String(blk.name), args: (blk.arguments ?? {}) as Record<string, unknown> };
    }
    return { type: "text", text: JSON.stringify(blk) };
  });
}
