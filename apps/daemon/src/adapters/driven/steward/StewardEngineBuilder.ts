/**
 * StewardEngineBuilder —— 管家引擎唯一构造配方（管家批段B，同轨裁定）。
 *
 * 管家与其他 agent 共轨：本函数是管家 PiAgentEngineAdapter 的**唯一**构造
 * 点——生产装配（buildSessionStack）与测试（streamFnOverride 剧本）走同一
 * 配方，不允许旁路散装 options。差异面全部经 StewardEngineOptions 显式
 * 携带（与主会话 sessionEngineFactory 的构造位同构）：
 *
 * - profile = StewardProfile（profiles 家族）；
 * - resolveTools = StewardToolBridge 投影（管家八工具中立规格）；
 * - approvalGate = 挂闸策略（写类工具——engine_paused + resume 四态，
 *   resolve 已翻译 block+terminate）；
 * - persistentListener = 跨 run 事件通道（管家对话投影/队列驱动/暂停侦测
 *   的消费面——start() 逐 run listener 收口即置空，后继事件只有常驻面可见）；
 * - initialMessages = dialog 懒加载回填（管家首问时构造——本函数在
 *   StewardService 首问时被调用，非装配期）；
 * - compaction = CompactionHook 参数（profile.compaction 声明 + models——
 *   AgentRuntime.compactionHooks 装配链；缺省不装压缩）。
 */
import type { Model, Models } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentEngineListener } from "../../../application/ports/outbound/AgentEnginePort";
import type { StewardToolSpec } from "../../../application/ports/outbound/StewardToolSpec";
import { PiAgentEngineAdapter } from "../pi-engine/PiAgentEngineAdapter";
import type { CompactionSettings } from "../pi-engine/runtime/AgentProfile";
import { StewardProfile } from "../pi-engine/runtime/profiles/StewardProfile";
import { projectStewardTools } from "./StewardToolBridge";
import { piMessagesToSteward, stewardMessagesToPi } from "./StewardLlmMessages";
import { ZERO_USAGE } from "../pi-engine/mappers/SessionMapper";

export interface StewardEngineOptions {
  /** 装配期系统提示（管家每 run 动态组装的初值——后续 run 经 setSystemPrompt 变异）。 */
  readonly systemPrompt?: string;
  /** 已解析模型对象（resolveModel 单点产物——与主会话同轨）。 */
  readonly model: Model<any>;
  /** provider → apiKey（静态表或 getter——每请求读现值）。 */
  readonly apiKeys: Record<string, string> | (() => Record<string, string>);
  /** provider 目录（压缩摘要调用与测试 fake catalog 共用面）。 */
  readonly models?: Models;
  /** 管家八工具中立规格（经 StewardToolBridge 投影进 resolveTools）。 */
  readonly tools: readonly StewardToolSpec[];
  /** 挂闸策略：命中的工具调用挂闸（写类工具集；空集 = 不装闸）。 */
  readonly gatedTools: ReadonlySet<string>;
  /** 跨 run 常驻事件监听（管家投影/驱动消费面——必传）。 */
  readonly persistentListener: AgentEngineListener;
  /** dialog 懒加载回填的首问历史窗口（port 消息形状——builder 内转 pi transcript）。 */
  readonly initialMessages?: readonly import("../../../application/ports/outbound/StewardLlmPort").StewardLlmMessage[];
  /** 压缩参数（profile.compaction 声明——AgentRuntime 装配 CompactionHook；缺省不装）。
   *  reserveTokens = contextWindow - thresholdTokens（管家阈值语义映射 pi 预留语义）；
   *  summarize = 摘要单轮覆写（管家 LLM port 承载——窗口/重建机器仍 pi 同套）。 */
  readonly compaction?: CompactionSettings & {
    readonly customInstructions?: string;
    readonly summarize?: (systemPrompt: string, messages: readonly import("../../../application/ports/outbound/StewardLlmPort").StewardLlmMessage[]) => Promise<string>;
    /** 触发档位：缺省 "request"（管家口径——纯问答轮也压）；"turn" = 主会话口径。 */
    readonly trigger?: "turn" | "request";
  };
  /** 测试剧本通道（streamFnOverride 标准接缝——主会话测试同款）。 */
  readonly streamFnOverride?: StreamFn;
}

/** 管家引擎构造（唯一配方——生产与测试共用）。 */
export function buildStewardEngine(options: StewardEngineOptions): PiAgentEngineAdapter {
  return new PiAgentEngineAdapter({
    profile: {
      ...StewardProfile,
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      tools: options.tools.map((t) => t.name),
      ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
    },
    model: options.model,
    apiKeys: options.apiKeys,
    models: options.models,
    resolveTools: () => projectStewardTools(options.tools),
    ...(options.gatedTools.size > 0
      ? {
          approvalGate: {
            shouldGate: (toolName: string) => options.gatedTools.has(toolName),
          },
        }
      : {}),
    persistentListener: options.persistentListener,
    ...(options.initialMessages !== undefined && options.initialMessages.length > 0
      ? { initialMessages: stewardMessagesToPi(options.initialMessages) }
      : {}),
    ...(options.streamFnOverride !== undefined ? { streamFnOverride: options.streamFnOverride } : {}),
    ...(options.compaction?.customInstructions !== undefined
      ? { compactionCustomInstructions: options.compaction.customInstructions }
      : {}),
    ...(options.compaction?.trigger !== undefined ? { compactionTrigger: options.compaction.trigger } : {}),
    ...(options.compaction?.summarize !== undefined
      ? {
          compactionSummarizeRequest: (async (aiContext: unknown, _options: unknown, context: unknown) => {
            // 管家摘要单轮：aiContext(systemPrompt+messages) → port summarize → assistant 消息
            const ctx = aiContext as { systemPrompt?: string; messages: readonly import("@earendil-works/pi-ai").Message[] };
            const summary = await options.compaction!.summarize!(
              ctx.systemPrompt ?? "",
              piMessagesToSteward(ctx.messages ?? []),
            );
            void context;
            return {
              role: "assistant",
              content: [{ type: "text" as const, text: summary }],
              api: options.model.api,
              provider: options.model.provider,
              model: options.model.id,
              stopReason: "stop",
              // 摘要回包必带零值 usage（同一 pi-ai estimate 无判空面——回填/合成
              // assistant 缺 usage 即抛；单源 ZERO_USAGE 见 SessionMapper）
              usage: ZERO_USAGE,
              timestamp: Date.now(),
            };
          }) as never,
        }
      : {}),
  });
}
