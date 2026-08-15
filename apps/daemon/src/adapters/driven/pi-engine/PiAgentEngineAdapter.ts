import type {
  AgentEngineEvent,
  AgentEngineListener,
  AgentEnginePort,
} from "../../../application/ports/outbound/AgentEnginePort";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "./runtime/AgentRuntime";
import type { AgentProfile } from "./runtime/AgentProfile";
import type { AgentRuntimeDeps } from "./runtime/AgentRuntime";
import { buildModels, createStreamFn, explicitGetApiKey, resolveModel } from "./model-provider";
import { stopReasonOf, textOfContent, textOfMessage } from "./mappers/SessionMapper";

/**
 * PiAgentEngineAdapter —— AgentEnginePort 的 pi 实现（防腐墙本体，§3.5）。
 *
 * 对外只暴露 port 语义（start/steer/abort/isStreaming + 引擎事件回调）；
 * 对内：AgentRuntime 装配驱动（loop 本体 import 复用，AD-3）、
 * pi AgentEvent → port 引擎事件的薄翻译（时序契约 spike §5 等价，
 * FakeAgentEngine 是本翻译契约的 mock 侧镜像）。
 */
export interface PiEngineOptions {
  /** 声明式 agent 规格（MainSessionProfile / 测试 TestProfile）。 */
  readonly profile: AgentProfile;
  /** 模型字符串（config.json 的 model 字段）。 */
  readonly modelStr: string;
  /** provider → apiKey（config.json 显式传入，AD-11/13）。 */
  readonly apiKeys: Record<string, string>;
  /** provider 目录（缺省 builtinModels()；测试注入 fake catalog）。 */
  readonly models?: Models;
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

  constructor(options: PiEngineOptions) {
    const models = options.models ?? buildModels();
    this.runtime = new AgentRuntime(options.profile, {
      streamFn: options.streamFnOverride ?? createStreamFn(models),
      model: resolveModel(models, options.modelStr),
      getApiKey: explicitGetApiKey(options.apiKeys),
      resolveTools: options.resolveTools,
    });
    this.runtime.subscribe((event) => this.onPiEvent(event));
  }

  async start(input: string, listener: AgentEngineListener): Promise<void> {
    this.listener = listener;
    try {
      await this.runtime.drive(input);
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
        // 只透传文本增量（thinking 等块不构成对话流；契约见 port 注释）
        if (event.assistantMessageEvent.type === "text_delta") {
          emit({ type: "message_update", delta: event.assistantMessageEvent.delta });
        }
        return;
      }
      case "message_end": {
        const role = event.message.role as "user" | "assistant" | "toolResult";
        return emit({
          type: "message_end",
          role,
          text: textOfMessage(event.message),
          stopReason: role === "assistant" ? stopReasonOf(event.message) : undefined,
        });
      }
      case "tool_execution_start":
        return emit({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      case "tool_execution_end":
        return emit({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          result: textOfContent((event.result as { content?: unknown } | undefined)?.content),
        });
      default:
        return; // tool_execution_update 等中间观测面暂不透传（T1.5 工具接线时评估）
    }
  }
}
