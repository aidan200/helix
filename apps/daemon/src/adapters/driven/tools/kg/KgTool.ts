import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { KgQueryService } from "../../../../application/services/kg/KgQueryService";
import { isValidNodeRef } from "../../../../domain/kg/node-id";

/**
 * kg 工具（T3.3，CL-4 F4.1，AD-16）——单工具两操作只读薄壳：
 *
 * - search(q)：name/digest LIKE 确定性匹配（无 embedding，F-6）→ 摘要列表
 *   （digest+指针形态：粗体 name + kind 徽章 + digest + `kg get <id>` 指针；
 *   无裸 id 主展示）。重名多行共存靠 digest 区分。
 * - get(nodeId)：节点全量聚合（节点/锚/关系/supersede 链/变更日志）。
 *
 * **ID 永远取自上一步返回**（参数供给闭环，CL-4.A3）：search 返回行必含
 * 指针 id；get 校验 id 形态（TR-n/E-n 或保号复合形态）——非法结构化报错
 * 而非空结果。全链路零写（只读保证，CL-4.A4——本文件无任何写路径）。
 *
 * 薄壳调 application service（KgQueryService；与编排工具→port 既有模式
 * 同构），不 import sqlite-kg（禁绕 port）。
 */

const kgParameters = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["search", "get"], description: "操作：search 关键词检索 / get 节点全量" },
    q: { type: "string", description: "search 关键词（name/digest 子串匹配，确定性非语义）" },
    nodeId: { type: "string", description: "get 目标节点 id（TR-n / E-n——永远取自 search 返回行的 kg get 指针）" },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

export interface KgToolDeps {
  readonly query: Pick<KgQueryService, "search" | "get">;
}

/** kg 只读工具：注册名 "kg"。 */
export function createKgTool(deps: KgToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "kg",
    label: "kg",
    description:
      "查询项目知识图谱（.kg，只读）。两步用法：先 search(q) 按关键词（名称/摘要子串）" +
      "检索得到摘要列表（每行含 digest 与 `kg get <id>` 指针，重名靠 digest 区分），" +
      "再用返回行指针中的 id 调 get(nodeId) 取节点全量（描述/锚/关系/supersede 链/变更日志）。" +
      "id 永远取自上一步返回，不要自行构造或猜测。",
    parameters: kgParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { op, q, nodeId } = params as { op?: string; q?: string; nodeId?: string };
      if (op === "search") {
        if (typeof q !== "string" || q.trim() === "") {
          throw new Error("kg search 需要 q（非空关键词——name/digest 子串匹配）");
        }
        const hits = deps.query.search(q);
        return text(renderSearch(q, hits));
      }
      if (op === "get") {
        if (typeof nodeId !== "string" || nodeId.trim() === "") {
          throw new Error("kg get 需要 nodeId（取自 search 返回行的 kg get 指针）");
        }
        if (!isValidNodeRef(nodeId)) {
          throw new Error(
            `nodeId "${nodeId}" 形态非法（合法：TR-n / E-n 或保号复合形态如 TR-AD-47）——id 必须取自 kg search 返回行的指针`,
          );
        }
        const hit = deps.query.get(nodeId);
        if (hit === null) {
          throw new Error(`节点 ${nodeId} 不存在（id 必须取自 kg search 返回行——先 search 再 get）`);
        }
        return text(renderDetail(hit.detail, hit.project));
      }
      throw new Error(`未知 op "${op}"（合法：search / get）`);
    },
  };
}

// ── 渲染（digest+指针形态，AD-16） ──────────────────────────

interface HitRow {
  readonly project: string;
  readonly row: { readonly id: string; readonly kind: string; readonly name: string; readonly digest: string; readonly status?: string };
}

function renderSearch(q: string, hits: readonly HitRow[]): string {
  if (hits.length === 0) {
    return `无命中（q="${q}"）——换更短或更宽泛的关键词重试（name/digest 子串匹配）`;
  }
  const lines = [`命中 ${hits.length} 条（q="${q}"）：`];
  for (const { row } of hits) {
    const statusBadge = row.status === "superseded" ? "（superseded，已被推翻）" : "";
    lines.push(`- **${row.name}** [${row.kind}]${statusBadge} — ${row.digest}`);
    lines.push(`  ↳ kg get ${row.id}`);
  }
  return lines.join("\n");
}

interface DetailShape {
  readonly node: {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly digest: string;
    readonly body?: string | null;
    readonly domain?: string | null;
    readonly layer?: string | null;
    readonly status: string;
  };
  readonly anchorDeclarations: readonly { readonly scopeKind: string; readonly pattern?: string }[];
  readonly materializedAnchors: readonly { readonly anchorKind: string; readonly anchorPath: string; readonly anchorSymbol: string | null }[];
  readonly edges: readonly { readonly verb: string; readonly otherId: string; readonly direction: string }[];
  readonly supersedeChain: readonly { readonly nodeId: string; readonly name: string; readonly status: string; readonly relation: string }[];
  readonly changeLog: readonly { readonly iterationId: string; readonly op: string; readonly supersedeOf: string | null; readonly reason: string | null }[];
}

function renderDetail(detail: DetailShape, project: string): string {
  const n = detail.node;
  const lines: string[] = [
    `${n.id} ${n.name} [${n.kind}] — ${n.status}`,
    `digest: ${n.digest}`,
  ];
  if (n.body != null && n.body !== "") lines.push(`body: ${n.body}`);
  const meta = [
    n.domain != null ? `domain=${n.domain}` : null,
    n.layer != null ? `layer=${n.layer}` : null,
    `project=${projectName(project)}`,
  ].filter((v): v is string => v !== null);
  lines.push(meta.join(" "));
  lines.push("锚声明:");
  if (detail.anchorDeclarations.length === 0) lines.push("  （无）");
  for (const a of detail.anchorDeclarations) lines.push(`- ${a.scopeKind} ${a.pattern ?? ""}`.trimEnd());
  lines.push("物化锚:");
  if (detail.materializedAnchors.length === 0) lines.push("  （无）");
  for (const a of detail.materializedAnchors) {
    lines.push(`- ${a.anchorKind} ${a.anchorSymbol !== null ? `${a.anchorPath}#${a.anchorSymbol}` : a.anchorPath}`);
  }
  lines.push("关系:");
  if (detail.edges.length === 0) lines.push("  （无）");
  for (const e of detail.edges) {
    lines.push(`- ${e.verb} ${e.direction === "out" ? "→" : "←"} ${e.otherId}`);
  }
  lines.push("supersede 链:");
  if (detail.supersedeChain.length === 0) lines.push("  （无）");
  for (const link of detail.supersedeChain) {
    const label = link.relation === "newer" ? "取代者" : link.relation === "older" ? "被取代" : "本节点";
    lines.push(`- ${label} ${link.nodeId}（${link.name}，${link.status}）`);
  }
  lines.push("变更日志:");
  for (const entry of detail.changeLog) {
    const chain = entry.supersedeOf !== null ? ` → ${entry.supersedeOf}` : "";
    const reason = entry.reason !== null ? `（${entry.reason}）` : "";
    lines.push(`- [${entry.iterationId}] ${entry.op}${chain}${reason}`);
  }
  return lines.join("\n");
}

function projectName(projectRoot: string): string {
  const parts = projectRoot.split("/");
  return parts[parts.length - 1] || projectRoot;
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}
