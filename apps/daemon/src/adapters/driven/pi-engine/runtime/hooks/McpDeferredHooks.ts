import type {
  Agent,
  AgentLoopTurnUpdate,
  PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type { HookSet } from "../HookSet";

/**
 * McpDeferredHooks —— MCP 懒加载同 turn 生效钩子（deferred 批）。
 *
 * 【为什么存在】run 开始时 createContextSnapshot().tools 是 slice 快照
 * （agent.js：run 内定格）——discover meta 工具物化链（refreshAssembly →
 * setTools → state.tools 直改）只改 state，本 run 的 turn context 不变，
 * 模型下一请求仍看不到新工具。本钩子在 turn 边界检测 state.tools 与
 * turn.context.tools 的名字集漂移，漂移即整体替换 context（只换 tools，
 * systemPrompt/messages 保留 turn 现值）。
 *
 * 【pi 0.84.4 同步契约（code-review M7⑤ 源码核实留档）】prepareNextTurn
 * 时点 state.messages ≡ turn.context.messages（message_end 同步镜像，
 * CompactionHook 头注释同口径）——旧注释「messages 可能领先 state，不可
 * 用 state 重建」与 CompactionHook 读 state 作压缩源相互矛盾，已统一：
 * 保留 turn 现值不是因为 state 不可信，而是 context 为本 turn 权威现场、
 * 语义直接，且 pi 升级若变镜像语义时 context 读面天然免疫。推荐读面 =
 * turn.context.messages。
 *
 * 【链位序契约】排在 CompactionHook 之后（AgentRuntime 装配序）：
 * - Compaction 未触发（返回 undefined）→ 本钩子正常检测；
 * - Compaction 触发 → 其替换 context 的 tools 已取 state.tools 现值
 *   （CompactionHook:122），漂移已对齐，本钩子被「首个非空生效」短路
 *   但语义已满足。
 *
 * 【非 MCP 场景零干扰】无 MCP 配置/无物化时 state.tools 恒等于快照
 * （仅 toggle/refreshAssembly 会改 state——改后首 turn 对齐一次即静默）。
 */
export class McpDeferredHooks implements HookSet {
  static readonly hookName = "mcp-deferred";
  get name(): string {
    return McpDeferredHooks.hookName;
  }

  private agent: Agent | null = null;

  bind(agent: Agent): void {
    this.agent = agent;
  }

  prepareNextTurn(turn: PrepareNextTurnContext): AgentLoopTurnUpdate | undefined {
    const agent = this.agent;
    if (!agent) return undefined;
    const turnTools = turn.context.tools ?? [];
    const currentNames = new Set(turnTools.map((t) => t.name));
    const stateNames = new Set(agent.state.tools.map((t) => t.name));
    if (currentNames.size === stateNames.size && [...stateNames].every((n) => currentNames.has(n))) {
      return undefined; // 无漂移：保持现状
    }
    return {
      context: {
        systemPrompt: turn.context.systemPrompt,
        messages: turn.context.messages,
        tools: agent.state.tools.slice(),
      },
    };
  }
}
