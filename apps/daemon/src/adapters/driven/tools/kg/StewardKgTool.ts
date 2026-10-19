import type {
  KgAffectedHit,
  KgCandidateHit,
  KgHit,
  KgNodeHit,
  KgQueryService,
} from "../../../../application/services/kg/KgQueryService";
import type { CandidateListQuery } from "../../../../domain/kg/types";
import type { StewardKgSource } from "../../../../application/steward/StewardService";
import { createKgTool } from "./KgTool";
/**
 * 管家 kg 只读检索面适配器（批A）——StewardKgSource 实现体：
 *
 * **只接线复用，零改本体**：渲染与校验语义全部复用 createKgTool（search =
 * digest+指针形态摘要行 / get = 节点全量聚合，id 形态校验与「先 search 再
 * get」引导同源），KgTool.ts / KgQueryService.ts 本体零改动；全链路零写
 * （本文件与 createKgTool 均无任何写路径——写面不进管家工具面）。
 *
 * 两件薄壳增量：
 * 1. **project 范围**（多项目 workspace）：projectRoot 显式 → search/get 经
 *    范围化查询门面（search 行过滤 / get 走 locate 按项目取）限定单项目；
 *    缺省 → 活跃项目域（kgProjects）——单项目即「当前活跃项目」原样渲染，
 *    多项目聚合时逐项目分块加「【项目 <名>】」头（行归属可辨，单项目渲染
 *    与 createKgTool 逐字节一致）。
 * 2. **装配缺席抛错**（workspace 未绑定/栈未建）：执行体在管家层兜底转引导
 *    文本——不炸轮。
 */

export interface StewardKgSourceDeps {
  /** KgQueryService 现值读口（workspace 重绑跟随——组合根晚绑惰性）。 */
  readonly queryOf: () => Pick<KgQueryService, "search" | "searchUnion" | "get" | "locate"> | undefined;
  /** 当前 kg 项目域（已建 .helix-kg 的项目根列表——workspace-scan/
   *  scanProjects 口径；空集 = absent）。 */
  readonly kgProjects: () => readonly string[];
}

/** 范围化查询门面（createKgTool 消费面同形——affected/candidates 两 op
 *  管家工具不暴露，空集占位保类型闭合；searchUnion = 双轨并集（检索语义化
 *  批）——与 createKgTool 语义复用同源，范围化过滤作用于并集命中行）。 */
function scopedQuery(
  query: Pick<KgQueryService, "search" | "searchUnion" | "get" | "locate">,
  projectRoot: string | undefined,
): Pick<KgQueryService, "searchUnion" | "get" | "affected" | "listCandidates" | "locate"> {
  return {
    searchUnion: async (q: string): Promise<readonly KgHit[]> => {
      const hits = await query.searchUnion(q);
      return projectRoot === undefined ? hits : hits.filter((h) => h.project === projectRoot);
    },
    get: (nodeId: string): KgNodeHit | null =>
      projectRoot === undefined ? query.get(nodeId) : (query.locate(nodeId).find((h) => h.project === projectRoot) ?? null),
    locate: (nodeId: string): readonly KgNodeHit[] =>
      projectRoot === undefined ? query.locate(nodeId) : query.locate(nodeId).filter((h) => h.project === projectRoot),
    affected: (): readonly KgAffectedHit[] => [],
    listCandidates: (_query: CandidateListQuery): readonly KgCandidateHit[] => [],
  };
}

function projectLabel(projectRoot: string): string {
  const parts = projectRoot.split("/");
  return parts[parts.length - 1] || projectRoot;
}

export function createStewardKgSource(deps: StewardKgSourceDeps): StewardKgSource {
  const runOp = async (params: Record<string, unknown>, projectRoot: string | undefined): Promise<string> => {
    const query = deps.queryOf();
    if (query === undefined) {
      throw new Error("知识图谱栈未装配（workspace 未绑定——请先绑定 workspace 再检索）");
    }
    const tool = createKgTool({ query: scopedQuery(query, projectRoot) });
    // 薄壳调用（六参 harness 签名的两参收窄——onUpdate/ctx/invocation 用不到）
    const exec = tool.execute.bind(tool) as unknown as (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: readonly { type: string; text?: string }[] }>;
    const result = await exec("steward-kg", params);
    return result.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  };
  return {
    kgProjects: () => deps.kgProjects(),
    async search(q, projectRoot) {
      const roots = projectRoot !== undefined ? [projectRoot] : [...deps.kgProjects()];
      if (roots.length <= 1) return runOp({ op: "search", q }, roots[0]);
      // 多项目聚合（缺省路径）：逐项目分块 + 项目头标注；空命中项目整块省略。
      const query = deps.queryOf();
      if (query === undefined) {
        throw new Error("知识图谱栈未装配（workspace 未绑定——请先绑定 workspace 再检索）");
      }
      // 判空与渲染必须同轨（F2 #15）：渲染走 searchUnion（关键词+语义并集），
      // 判空若用关键词轨 search，仅语义命中的项目会被当空块跳过（命中漏渲染）。
      // 并集取一次、逐项目过滤复用——每项目不再多一次检索。
      const union = await query.searchUnion(q);
      const blocks: string[] = [];
      for (const root of roots) {
        if (!union.some((hit) => hit.project === root)) continue;
        blocks.push(`【项目 ${projectLabel(root)}】\n${await runOp({ op: "search", q }, root)}`);
      }
      if (blocks.length > 0) return blocks.join("\n\n");
      // 全空：走未过滤原样渲染（「无命中」引导文案与 createKgTool 同源）
      return runOp({ op: "search", q }, undefined);
    },
    async get(nodeId, projectRoot) {
      return runOp({ op: "get", nodeId }, projectRoot);
    },
  };
}
