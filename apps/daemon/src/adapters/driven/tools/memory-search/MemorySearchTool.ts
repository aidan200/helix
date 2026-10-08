import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "../../../../adapters/driven/tools/vendor/pi-harness";
import type { MemorySearchHit } from "../../../../application/steward/StewardMemoryService";
import { capToolResultText } from "../../../../application/steward/StewardService";

/**
 * memory_search 工具（批E：编码 agent 记忆消费面工具化）——长期记忆只读
 * 语义检索薄壳：
 *
 * - 消费面：主会话（engineFor executor 注入）与 SubAgent worker 家族
 *  （ChildMain 本地栈注入）双面注册；orchestrator 不声明（栈级无会话
 *   项目上下文，与批D 不注入同口径）；
 * - 行为：query = 任务意图/类型描述 → 复用管家 recall 管线底层
 *  （StewardMemoryService.searchMemories：embedding → vec0 KNN 候选池
 *   （scope 预过滤 global + 当前会话项目，E-264 口径——项目由装配面
 *   projectOf 单点供给，工具参数无 project 防伪造）→ 过淡忘 → 资格闸 →
 *   kind 过滤（排除 progress）→ cosine×strength 融合排序 → topK 截断）；
 * - 回执：逐条 id/kind/text/score/updatedAt 紧凑列表（kg 工具返回风格），
 *   capToolResultText 体量护栏兜底；
 * - 主动检索记 markRecalled（批E 预授权——复习强化回写，与批D 被动注入
 *   不记的分野：工具调用是显式消费行为）；
 * - 全链路零写（除 markRecalled 回写外无任何记忆写路径——编码 agent 无
 *   记忆写工具，写入面归管家）。
 *
 * 降级面（kg absent 引导式同族——isError 不置，不炸主链路）：
 * 记忆不可用 → 引导文案；检索异常 → 降级文案（按任务指令继续）。
 */

/** 检索面（StewardMemoryService 窄面——测试注入 fake 同形）。 */
export interface MemorySearchServiceFace {
  isAvailable(): boolean;
  searchMemories(query: string, project?: string): Promise<readonly MemorySearchHit[]>;
}

export interface MemorySearchToolDeps {
  readonly service: MemorySearchServiceFace;
  /** 当前会话项目解析（装配面闭包：主会话 = 调用时写足迹单项目归约现值；
   *  SubAgent 子进程 = spawn 定格 env HELIX_MEMORY_PROJECT）。undefined =
   *  无项目上下文（仅 global）。 */
  readonly projectOf: () => string | undefined;
}

const memorySearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "检索意图（任务意图/类型描述——如「用户对本类任务的偏好」「测试与提交习惯」）；语义匹配用户偏好与工作状态类记忆，非项目知识（项目现实用 codegraph/kg）",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/** memory_search 只读工具：注册名 "memory_search"。 */
export function createMemorySearchTool(deps: MemorySearchToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "memory_search",
    label: "memory_search",
    description:
      "语义检索用户长期记忆（偏好与工作状态类认知，只读）。开工或决策前用任务意图作 query 主动检索——" +
      "命中即遵守（与当前任务指令冲突时以任务指令为准；代码与项目现实以知识图谱约束为准）。" +
      "返回逐条 id/kind/text/score/updatedAt 紧凑列表（kind 仅偏好/事实——进展不检索；" +
      "范围 = 全局 + 当前会话项目）。无记忆写工具：记忆写入归管家，本工具纯读。",
    parameters: memorySearchParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { query } = params as { query?: string };
      if (typeof query !== "string" || query.trim() === "") {
        throw new Error("memory_search 需要 query（非空——任务意图/类型描述，语义匹配用户偏好与工作状态类记忆）");
      }
      if (!deps.service.isAvailable()) {
        return text(
          "长期记忆未启用或未配置（设置 → 通用 → 长期记忆）——本次无用户偏好/工作状态参考，按任务指令与知识图谱约束继续。",
        );
      }
      let hits: readonly MemorySearchHit[];
      try {
        hits = await deps.service.searchMemories(query, deps.projectOf());
      } catch (err) {
        // 失败静默降级（不炸主链路——与管家召回降级同族纪律）
        return text(
          `记忆检索降级（${(err as Error).message}）——按任务指令继续，本次不参考长期记忆。`,
        );
      }
      return text(renderHits(query, deps.projectOf(), hits));
    },
  };
}

// ── 渲染（紧凑行列表——kg 工具风格） ──────────────────────────

const KIND_LABELS: Readonly<Record<"fact" | "preference", string>> = {
  preference: "偏好",
  fact: "事实",
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function renderHits(query: string, project: string | undefined, hits: readonly MemorySearchHit[]): string {
  if (hits.length === 0) {
    return `无相关记忆命中（query="${query}"）——可换更贴近任务意图的措辞重试一次；确无命中则按任务指令与知识图谱约束继续。`;
  }
  const scope = project === undefined ? "global" : `global + ${project}`;
  const lines = [`命中 ${hits.length} 条（query="${query}"，范围：${scope}）——命中即遵守，与当前任务指令冲突时以任务指令为准：`];
  for (const h of hits) {
    lines.push(`- [${KIND_LABELS[h.kind]}] ${h.text}（id=${h.id}, score=${h.score.toFixed(2)}, updatedAt=${isoDate(h.updatedAt)}）`);
  }
  return capToolResultText(lines.join("\n"));
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}
