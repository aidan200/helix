import type { Agent, AgentLoopTurnUpdate, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Entry } from "@earendil-works/pi-agent-core";
import {
  BACKGROUND_CONTEXT,
  compact,
  createCompactionSummaryMessage,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  withAbortSignal,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { AgentEngineUsage } from "../../../../../application/ports/outbound/AgentEnginePort";
import { usageOfPi } from "../../mappers/SessionMapper";
import type { CompactionSettings } from "../AgentProfile";
import type { HookSet } from "../HookSet";

/**
 * CompactionHook —— turn 边界上下文压缩接线（prepareNextTurn 挂点）。
 *
 * 触发链：estimateContextTokens → shouldCompact
 * （contextTokens > contextWindow - reserveTokens）→ messagesToEntries 转换桥
 * （compaction 函数族吃 Entry[]，而 agent transcript 是 AgentMessage[]）→
 * prepareCompaction → compact（摘要走 models.completeSimple，provider 约束 =
 * 支持流式，契约 §8-4；apiKey 经 Models 装饰显式注入，code-review H5）→
 * compactionSummary 消息 + retainedTail 重建上下文（0.85 起 buildSessionContext
 * 包未导出，等价语义内联）→ 复算 tokensAfter。
 *
 * 契约：失败不抛出（prepareNextTurn 钩子禁抛）——上抛 onFailed（上层转
 * engine_error 可观测），返回 undefined 保持现状继续 turn，会话无损。
 * 阈值可配：settings 全部来自 profile 声明（reserveTokens/keepRecentTokens）。
 *
 * 【pi 0.84.4 同步契约（code-review M7⑤ 源码核实留档，pi-agent-core
 * dist/agent.js processEvents + dist/agent-loop.js）】prepareNextTurn 时点
 * agent.state.messages ≡ turn.context.messages：loop 内所有入列消息
 * （prompts/steering/toolResults/assistant final）都经 message_end 事件
 * 镜像进 state.messages，turn_end 后两者同步——压缩源读 state.messages
 * 与读 turn.context.messages 等价。推荐读面 = turn.context.messages
 * （turn 现场权威，McpDeferredHooks 同口径）；本钩子保留 state 读面的
 * 理由 = 压缩后须双写 agent.state（跨 run 持久），读写同面更直接。pi
 * 升级若变 message_end 镜像语义，压缩源须改读 turn.context.messages，
 * 否则以陈旧历史为源。
 */
export interface CompactionHookDeps {
  /** 压缩参数声明（profile.compaction 透传）。 */
  readonly settings: CompactionSettings;
  /** pi 模型目录（摘要调用 completeSimple 走它；装配期必传）。 */
  readonly models: Models;
  /** 装配期兑底模型（运行期换模前/现场模型缺席时兜底；正常路径读 agent.state.model——code-review H7）。 */
  readonly model: Model<any>;
  /**
   * 摘要调用显式 key 查询（code-review H5）：与主链路 agent-loop 同一
   * hook 面（AG-08/AD-11/13——每调用按摘要模型 provider 解析，不走
   * env）。pi compact() 的 options 组装无 apiKey 通道（回落 pi 自身
   * CredentialStore，helix 从不写入），故经 Models 装饰注入
   * completeSimple 的 options.apiKey。缺省不注入（现状透传，测试替身
   * 零破坏）；抛错（explicitGetApiKey 缺 key fail-fast）经外层 catch
   * 降级 onFailed——文案与主链路同源，不崩会话。
   */
  readonly getApiKey?: (provider: string) => string | undefined;
  /** 压缩完成上抛（adapter → port compaction_completed 事件）。 */
  readonly onCompleted?: (result: CompactionOutcome) => void;
  /** 压缩失败上抛（adapter → port engine_error 事件；会话继续）。 */
  readonly onFailed?: (message: string) => void;
}

/** 压缩产物上抛形状（CompactResult 防腐映射；tokensAfter 为复算值）。 */
export interface CompactionOutcome {
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly summary: string;
  readonly usage?: AgentEngineUsage;
}

export class CompactionHook implements HookSet {
  readonly name = "compaction";

  private agent: Agent | null = null;

  constructor(private readonly deps: CompactionHookDeps) {}

  bind(agent: Agent): void {
    this.agent = agent;
  }

  async prepareNextTurn(
    _turn: Parameters<NonNullable<HookSet["prepareNextTurn"]>>[0],
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> {
    const agent = this.agent;
    if (!agent) return undefined;
    const { settings, models } = this.deps;
    // 运行期换模跟随（code-review H7）：阈值基准与摘要目标读 agent 现场模型——
    // 装配期固化的 deps.model 不随 setModel 演进，换到更小窗口模型时压缩
    // 可能永不触发（上下文溢出）且摘要调用走旧 provider。
    const model = (agent.state.model ?? this.deps.model) as Model<any>;
    try {
      // 摘要调用显式 apiKey（code-review H5）：在 pi 重试环外解析一次（缺
      // key 抛错不进 pi retry 风暴，直接降级 onFailed），经 Models 装饰注入
      // completeSimple options.apiKey——与主链路 agent-loop 每请求解析
      // （AG-08）同源同面：给谁做摘要就用谁的 key。
      const apiKey = this.deps.getApiKey?.(model.provider);
      const summaryModels = apiKey !== undefined ? withApiKey(models, apiKey) : models;
      // 压缩源 = state.messages（≡ turn.context.messages，同步契约见头注释 M7⑤）
      const messages = agent.state.messages;
      const est = estimateContextTokens(messages);
      if (!shouldCompact(est.tokens, model.contextWindow, settings)) return undefined;

      // 转换桥：AgentMessage[] → Entry[]（compaction 函数族吃 Entry[]）
      const entries = messagesToEntries(messages);
      const prep = prepareCompaction(entries, settings);
      if (!prep.ok) {
        this.deps.onFailed?.(`compaction 准备失败：${JSON.stringify(prep.error).slice(0, 200)}`);
        return undefined;
      }
      if (!prep.value) return undefined; // 无可压缩内容（如刚压缩完）：保持现状

      // signal 折进 chord Context（0.85：compact 末参为必传 Context）。
      const context = signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);
      const result = await compact(prep.value, summaryModels, model, undefined, undefined, undefined, undefined, context);
      if (!result.ok) {
        this.deps.onFailed?.(`compaction 摘要失败：${JSON.stringify(result.error).slice(0, 200)}`);
        return undefined;
      }
      const cr = result.value;

      // 上下文重建（0.85：buildSessionContext 不再从包导出——等价内联其
      // compaction 分支语义）：上下文 = compactionSummary 消息 + retainedTail
      // （滤除 error/aborted/deferred 终态的 assistant 消息，与 pi
      // sessionEntryToContextMessages 同口径）+ 后续新消息。
      // 0.87 补丁：prompt/工具声明由 leading SystemMessage 承载
      //（AgentState.systemPrompt 只读回放）——pi prepareCompaction 切点不豁免
      // 首条 system 消息（几乎必入摘要窗口），重建时回插防丢 prompt；
      // retainedTail 内可能残留的 system 消息（窗口极短时）滤除防双回放。
      const first = agent.state.messages[0];
      const leadingSystem = first !== undefined && first.role === "system" ? first : undefined;
      const rebuiltMessages: AgentMessage[] = [
        ...(leadingSystem !== undefined ? [leadingSystem] : []),
        createCompactionSummaryMessage(cr.summary, cr.tokensBefore, Date.now()),
        ...cr.retainedTail.filter(isContextMessage).filter((m) => m.role !== "system"),
      ];
      const tokensAfter = estimateContextTokens(rebuiltMessages).tokens;
      // 双写：agent.state（跨 run 持久）+ 返回替换 context（本 run 下一请求生效）
      agent.state.messages = rebuiltMessages;
      this.deps.onCompleted?.({
        tokensBefore: cr.tokensBefore,
        tokensAfter,
        summary: cr.summary,
        ...(cr.usage !== undefined ? { usage: usageOfPi(cr.usage) } : {}),
      });
      return {
        context: {
          messages: rebuiltMessages,
          tools: agent.state.tools,
        },
      };
    } catch (err) {
      // 钩子禁抛契约：任何意外失败降级为上抛（不崩会话，继续 turn）
      this.deps.onFailed?.(`compaction 执行异常：${(err as Error).message}`);
      return undefined;
    }
  }
}

/** transcript → message Entry 链（id/seq 按位次合成；timestamp 取消息自带）。 */
function messagesToEntries(messages: AgentMessage[]): Entry[] {
  return messages.map((message, i) => ({
    type: "message" as const,
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    seq: i,
    timestamp: (message as { timestamp?: number }).timestamp ?? Date.now(),
    message,
  }));
}

/** pi sessionEntryToContextMessages 的上下文消息过滤口径（0.85 同构内联——该函数包未导出）。 */
function isContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred")
  );
}

/**
 * Models 装饰：completeSimple 注入显式 apiKey，其余成员透传真体（bind
 * 保持 this 语义）。pi compact()/generateSummaryWithUsage() 内部组装
 * options 无 apiKey 参（pi-agent-core 0.84.4 签名核实），但 pi-ai
 * ProviderRequestOptions 契约带 apiKey 字段——唯一无损补链点 = Models
 * 装饰面。Proxy 形态对真体（原型方法）与替身（自有属性）都成立。
 */
function withApiKey(models: Models, apiKey: string): Models {
  return new Proxy(models, {
    get(target, prop) {
      if (prop === "completeSimple") {
        const completeSimple: Models["completeSimple"] = (model, context, options) =>
          target.completeSimple(model, context, { ...options, apiKey });
        return completeSimple;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
