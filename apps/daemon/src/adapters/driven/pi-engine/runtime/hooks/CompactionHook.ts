import type { Agent, AgentLoopTurnUpdate, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Entry } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  compact,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { Model, Models, Usage } from "@earendil-works/pi-ai";
import type { AgentEngineUsage } from "../../../../../application/ports/outbound/AgentEnginePort";
import type { CompactionSettings } from "../AgentProfile";
import type { HookSet } from "../HookSet";

/**
 * CompactionHook —— turn 边界上下文压缩接线（prepareNextTurn 挂点，T3.1）。
 *
 * 触发链（spike/03 同构）：estimateContextTokens → shouldCompact
 * （contextTokens > contextWindow - reserveTokens）→ messagesToEntries 转换桥
 * （compaction 函数族吃 Entry[]，而 agent transcript 是 AgentMessage[]）→
 * prepareCompaction → compact（摘要走 models.completeSimple，provider 约束 =
 * 支持流式，契约 §8-4）→ CompactionEntry 插树 + retainedTail 重建上下文 →
 * buildSessionContext 复算 tokensAfter。
 *
 * 契约：失败不抛出（prepareNextTurn 钩子禁抛）——上抛 onFailed（上层转
 * engine_error 可观测），返回 undefined 保持现状继续 turn，会话无损。
 * 阈值可配：settings 全部来自 profile 声明（K2：reserveTokens/keepRecentTokens）。
 */
export interface CompactionHookDeps {
  /** 压缩参数声明（profile.compaction 透传）。 */
  readonly settings: CompactionSettings;
  /** pi 模型目录（摘要调用 completeSimple 走它；装配期必传）。 */
  readonly models: Models;
  /** 当前模型（contextWindow 阈值基准 + 摘要调用目标）。 */
  readonly model: Model<any>;
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

  async prepareNextTurn(signal?: AbortSignal): Promise<AgentLoopTurnUpdate | undefined> {
    const agent = this.agent;
    if (!agent) return undefined;
    const { settings, model, models } = this.deps;
    try {
      const messages = agent.state.messages;
      const est = estimateContextTokens(messages);
      if (!shouldCompact(est.tokens, model.contextWindow, settings)) return undefined;

      // 转换桥：AgentMessage[] → Entry[]（spike/03 messagesToEntries 参照）
      const entries = messagesToEntries(messages);
      const prep = prepareCompaction(entries, settings);
      if (!prep.ok) {
        this.deps.onFailed?.(`compaction 准备失败：${JSON.stringify(prep.error).slice(0, 200)}`);
        return undefined;
      }
      if (!prep.value) return undefined; // 无可压缩内容（如刚压缩完）：保持现状

      const result = await compact(prep.value, models, model, undefined, signal);
      if (!result.ok) {
        this.deps.onFailed?.(`compaction 摘要失败：${JSON.stringify(result.error).slice(0, 200)}`);
        return undefined;
      }
      const cr = result.value;

      // CompactionEntry 插树（retainedTail 存于条目内部——buildSessionContext
      // 对 compaction 条目自动展开 tail，此处不再显式续链否则重复计数；
      // 后续 compaction 经 prepareCompaction 的 virtualRetainedEntries 还原 tail）。
      // 此后上下文 = compactionSummary + retainedTail + 后续新消息
      const postEntries: Entry[] = [
        {
          type: "compaction",
          id: `c${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          seq: entries.length,
          timestamp: Date.now(),
          summary: cr.summary,
          retainedTail: cr.retainedTail,
          tokensBefore: cr.tokensBefore,
          ...(cr.usage !== undefined ? { usage: cr.usage } : {}),
        },
      ];
      const rebuilt = buildSessionContext(postEntries);
      const tokensAfter = estimateContextTokens(rebuilt.messages).tokens;

      // 双写：agent.state（跨 run 持久）+ 返回替换 context（本 run 下一请求生效）
      agent.state.messages = rebuilt.messages;
      this.deps.onCompleted?.({
        tokensBefore: cr.tokensBefore,
        tokensAfter,
        summary: cr.summary,
        ...(cr.usage !== undefined ? { usage: usageOf(cr.usage) } : {}),
      });
      return {
        context: {
          systemPrompt: agent.state.systemPrompt,
          messages: rebuilt.messages,
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

/** pi Usage → 七字段防腐（cost 拍平取 total；reasoning 缺省 0）。 */
function usageOf(usage: Usage): AgentEngineUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning ?? 0,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  };
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
