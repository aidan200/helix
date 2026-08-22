import type {
  AgentEngineEvent,
  AgentEngineListener,
  AgentEnginePort,
} from "../../../application/ports/outbound/AgentEnginePort";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "./runtime/AgentRuntime";
import type { AgentProfile } from "./runtime/AgentProfile";
import type { AgentRuntimeDeps } from "./runtime/AgentRuntime";
import { buildModels, createStreamFn, explicitGetApiKey, resolveModel, resolveModelSlot } from "./model-provider";
import { stopReasonOf, errorMessageOf, textOfContent, textOfMessage, usageOf } from "./mappers/SessionMapper";
import { imagesOfContent } from "../../../application/services/images";

/**
 * PiAgentEngineAdapter —— AgentEnginePort 的 pi 实现（防腐墙本体，§3.5）。
 *
 * 对外只暴露 port 语义（start/steer/abort/isStreaming + 引擎事件回调）；
 * 对内：AgentRuntime 装配驱动（loop 本体 import 复用，AD-3）、
 * pi AgentEvent → port 引擎事件的薄翻译（时序契约 spike §5 等价，
 * FakeAgentEngine 是本翻译契约的 mock 侧镜像）。
 */
export interface PiEngineOptions {
  /** 声明式 agent 规格（MainSessionProfile / SubAgentProfile / 测试 TestProfile）。 */
  readonly profile: AgentProfile;
  /**
   * 已解析的完整模型对象（F-14 透传单点产物：resolveConfigModel）。
   * profile.model 声明槽位时在装配期覆写解析（resolveModelSlot，fail-fast 含 id）；
   * 未声明则同引用透传本对象（缺省继承，AD-6）。
   */
  readonly model: Model<any>;
  /**
   * provider → apiKey（AD-11/13 显式传值）。T2.3（AD-2）：数据源改 auth.json
   * ——接受静态表或 getter（getter 每请求读现值，换 key 后下一请求生效）。
   */
  readonly apiKeys: Record<string, string> | (() => Record<string, string>);
  /** provider 目录（缺省 builtinModels()；测试注入 fake catalog）。 */
  readonly models?: Models;
  /**
   * 运行期换模解析器（T2.3：setModel 按 id 解析完整 Model 对象；组合根
   * 注入 catalog 活解析面——overlay 刷新后新模型可达；缺省 = 静态 models）。
   */
  readonly resolveModelById?: (modelId: string) => Model<any>;
  /** 流式函数覆盖（测试注入 FakeLLM 剧本，M2 级 mock）。 */
  readonly streamFnOverride?: StreamFn;
  /** 工具集装配器（T1.5：CoreToolExecutor.resolveTools，组合根接线）。 */
  readonly resolveTools?: AgentRuntimeDeps["resolveTools"];
}

export class PiAgentEngineAdapter implements AgentEnginePort {
  private readonly runtime: AgentRuntime;
  private listener: AgentEngineListener | null = null;
  /** 已 steer 的文本（FIFO）：drain 边界的 user 消息据此判别来源。 */
  private readonly steeredTexts: string[] = [];
  /** setModel 解析面（T2.3：catalog 活解析优先，静态 models 兑底）。 */
  private readonly resolveById: (modelId: string) => Model<any>;
  /** setTools 装配面（M6 T2：CoreToolExecutor.resolveTools 既有注入路径）。 */
  private readonly resolveToolsFn: AgentRuntimeDeps["resolveTools"];

  constructor(options: PiEngineOptions) {
    const models = options.models ?? buildModels();
    this.resolveById = options.resolveModelById ?? ((id) => resolveModel(models, id));
    this.resolveToolsFn = options.resolveTools;
    this.runtime = new AgentRuntime(options.profile, {
      streamFn: options.streamFnOverride ?? createStreamFn(models),
      model: resolveModelSlot(options.profile.model, options.model, models),
      models,
      getApiKey: explicitGetApiKey(options.apiKeys),
      resolveTools: options.resolveTools,
      // T3.1：turn 边界 compaction 产物 → port 事件（失败走 engine_error，不崩会话）
      onCompactionCompleted: (r) =>
        this.listener?.({
          type: "compaction_completed",
          tokensBefore: r.tokensBefore,
          tokensAfter: r.tokensAfter,
          summary: r.summary,
          ...(r.usage !== undefined ? { usage: r.usage } : {}),
        }),
      onCompactionFailed: (message) => this.listener?.({ type: "engine_error", message }),
    });
    this.runtime.subscribe((event) => this.onPiEvent(event));
  }

  async start(input: string, listener: AgentEngineListener, images?: readonly string[]): Promise<void> {
    this.listener = listener;
    try {
      await this.runtime.drive(input, images);
    } finally {
      this.listener = null;
    }
  }

  steer(text: string): void {
    this.steeredTexts.push(text);
    this.runtime.steer(text);
  }

  abort(): void {
    this.runtime.abort();
  }

  isStreaming(): boolean {
    return this.runtime.isStreaming();
  }

  /** 当前模型 id（T2.3 可观测面：快照/徽标 model 位数据源）。 */
  currentModel(): string {
    const m = this.runtime.stateModel;
    return `${m.provider}/${m.id}`;
  }

  /**
   * 运行期换模（T2.3 AD-2）：按 id 解析完整 Model（目录/catalog 面）后
   * 直改 AgentState.model——下一 turn 生效，in-flight run 不受影响。
   */
  setModel(modelId: string): void {
    this.runtime.setModel(this.resolveById(modelId));
  }

  /**
   * 运行期改生效工具集（M6 T2，setModel 同构）：names 经注入的 resolveTools
   * （CoreToolExecutor 既有路径）重解析成 AgentTool[] 后直改 AgentState.tools
   * ——能力+提示双料同源，下一 turn 生效。未注入 resolveTools（纯测试形态）
   * → fail-fast 不静默。
   */
  setTools(names: readonly string[]): void {
    this.runtime.setTools(this.requireResolveTools(names)(names));
  }

  /**
   * D12-4 守卫收敛（T1.5）：未注入 resolveTools 装配面即 fail-fast 不静默
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

  /** 运行期改系统提示（M6 T2，setModel 同构）：直改 AgentState.systemPrompt，下一 turn 生效。 */
  setSystemPrompt(text: string): void {
    this.runtime.setSystemPrompt(text);
  }

  /** pi AgentEvent → port 引擎事件（时序契约 §5 等价的真引擎侧）。 */
  private onPiEvent(event: AgentEvent): void {
    const emit = (e: AgentEngineEvent) => this.listener?.(e);
    switch (event.type) {
      case "agent_start":
        return emit({ type: "agent_start" });
      case "agent_end":
        return emit({ type: "agent_end", messageCount: event.messages.length });
      case "turn_start":
        return emit({ type: "turn_start" });
      case "turn_end":
        return emit({ type: "turn_end", toolResultCount: event.toolResults.length });
      case "message_start": {
        const role = event.message.role as "user" | "assistant" | "toolResult";
        // drain 判别：run 中出现的 user 消息且文本与最早的 steer 注入一致
        //（prompt 的 user 消息只在 run 开头出现，注入消息出现在 turn 边界）
        let source: "prompt" | "steer-drain" = "prompt";
        if (role === "user" && this.steeredTexts.length > 0) {
          const text = textOfMessage(event.message);
          if (text === this.steeredTexts[0]) {
            source = "steer-drain";
            this.steeredTexts.shift();
          }
        }
        return emit({ type: "message_start", role, source });
      }
      case "message_update": {
        // 文本增量透传对话流；thinking 块流透传通道族（T3.1：不再丢弃）
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
        const role = event.message.role as "user" | "assistant" | "toolResult";
        // T3.1：assistant 消息携带 usage 时提取（七字段防腐；账目本体 T3.2）
        const usage = role === "assistant" ? usageOf(event.message) : undefined;
        const stopReason = role === "assistant" ? stopReasonOf(event.message) : undefined;
        emit({
          type: "message_end",
          role,
          text: textOfMessage(event.message),
          stopReason,
          ...(usage !== undefined ? { usage } : {}),
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
        // T9 图片下行：工具结果 content 内 image 块 → images data URL
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
        return; // tool_execution_update 等中间观测面暂不透传（T1.5 工具接线时评估）
    }
  }
}
