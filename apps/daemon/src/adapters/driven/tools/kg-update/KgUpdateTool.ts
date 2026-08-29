import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { KgQueryService } from "../../../../application/services/kg/KgQueryService";
import type { KgWriteService } from "../../../../application/services/kg/KgWriteService";
import type {
  AnchorDeclaration,
  KnowledgeWriteOp,
  NodeDraft,
  NodeDomain,
  NodeId,
  NodeLayer,
  WriteResult,
} from "../../../../domain/kg/types";

/**
 * kg-update 工具（T3.3，CL-3 F3.1 即时通道，AD-14）——即时落账薄壳。
 *
 * 两操作，全部经 KgWriteService（.kg 唯一写入口——schema 校验前置，
 * **绝不旁路直写**）：
 *
 * - supersede(nodeId, reason, iterationId, replacement?)：推翻知识——
 *   status 翻转 + 理由 + 迭代 id 入 change_log（无人审即时兑现，AD-14
 *   协议行「随改动提交 supersede」的现场通道）；replacement 可选携带
 *   新节点草稿（新号自动发放，链上双侧可见）。
 * - createNode(kind, name, digest, ...)：新知识即时落账——自动发号
 *   （AD-16）；anchors 可选组合锚声明（第二笔 declareAnchors op）。
 * - batchCreateNodes(nodes[])（T2.1，O-5 裁决）：批量建点——LLM 按写入量
 *   自选单条/批量，两 op 并存且结果等价（CL-2-T14）；逐项自动发号，
 *   任一项失败整批拒绝（先全量校验后单事务）。
 *
 * 与 ClosureDto.findings 收口通道（T4.1）非竞争关系：共用同一 API 入口，
 * 本工具承载 edit 现场的即时兑现（O-2 决策消解）。
 */

const kgUpdateParameters = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["createNode", "supersede", "batchCreateNodes"],
      description: "操作：createNode 新知识落账 / supersede 推翻既有节点 / batchCreateNodes 批量建点（O-5：按写入量自选单条/批量）",
    },
    // ── createNode ──
    kind: { type: "string", enum: ["rule", "entity"], description: "createNode 节点类型（rule=规则 / entity=实体）" },
    name: { type: "string", description: "createNode 节点名（重名合法，靠 digest 区分）" },
    digest: { type: "string", description: "createNode 摘要（≤2 行——LLM 面默认展示粒度）" },
    body: { type: "string", description: "createNode 正文（可选，全文详情）" },
    domain: { type: "string", enum: ["tech", "business"], description: "createNode 作用域（可选）" },
    layer: { type: "string", enum: ["L0", "L1", "L2"], description: "createNode 分层（可选，AD-11）" },
    anchors: {
      type: "array",
      description: "createNode 锚声明（可选）：[{scopeKind: global|path|symbol, pattern}]（global 不携带 pattern）",
      items: {
        type: "object",
        properties: {
          scopeKind: { type: "string", enum: ["global", "path", "symbol"] },
          pattern: { type: "string", description: "path→glob；symbol→path#symbol；global 省略" },
        },
        required: ["scopeKind"],
        additionalProperties: false,
      },
    },
    // ── batchCreateNodes ──
    nodes: {
      type: "array",
      description: "batchCreateNodes 批量节点载荷：[{kind, name, digest, body?, domain?, layer?}]（逐项自动发号；任一项失败整批拒绝零落库）",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["rule", "entity"], description: "节点类型（rule=规则 / entity=实体）" },
          name: { type: "string", description: "节点名（重名合法，靠 digest 区分）" },
          digest: { type: "string", description: "摘要（≤2 行）" },
          body: { type: "string", description: "正文（可选）" },
          domain: { type: "string", enum: ["tech", "business"], description: "作用域（可选）" },
          layer: { type: "string", enum: ["L0", "L1", "L2"], description: "分层（可选，AD-11）" },
        },
        required: ["kind", "name", "digest"],
        additionalProperties: false,
      },
    },
    // ── supersede ──
    nodeId: { type: "string", description: "supersede 目标节点 id（取自 kg search 返回行 / 附着块指针）" },
    reason: { type: "string", description: "supersede 推翻理由（入 change_log 审计链）" },
    replacement: {
      type: "object",
      description: "supersede 可选替换新节点草稿（新号自动发放，链上双侧可见）",
      properties: {
        kind: { type: "string", enum: ["rule", "entity"] },
        name: { type: "string" },
        digest: { type: "string" },
        body: { type: "string" },
        domain: { type: "string", enum: ["tech", "business"] },
        layer: { type: "string", enum: ["L0", "L1", "L2"] },
      },
      required: ["kind", "name", "digest"],
      additionalProperties: false,
    },
    // ── 通用 ──
    iterationId: { type: "string", description: "当前迭代 id（change_log 每行必含，如 iter-20260825-11fo）" },
    project: { type: "string", description: "createNode 目标项目目录名（workspace 只有一个项目时可省；多项目必填）" },
  },
  required: ["op", "iterationId"],
  additionalProperties: false,
} as const;

export interface KgUpdateToolDeps {
  readonly query: Pick<KgQueryService, "locate">;
  /** KgWriteService 面（结构化注入——测试记录器同形）。 */
  readonly write: { write(projectRoot: string, op: KnowledgeWriteOp): WriteResult };
  /** workspace 根（project 名 → projectRoot 解析）。 */
  readonly workspaceRoot: string;
  /** workspace 全项目扫描（createNode 目标解析；含未建 .kg 项目）。 */
  readonly scanProjects: () => readonly string[];
}

/** kg-update 即时落账工具：注册名 "kg-update"。 */
export function createKgUpdateTool(deps: KgUpdateToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "kg-update",
    label: "kg-update",
    description:
      "知识图谱即时落账（经唯一写入口，schema 校验前置）。supersede：本次改动推翻某知识节点时" +
      "（📎 附着块或任务切片尾部的协议行触发）立即声明——status 翻转 + 理由 + iterationId 入审计链，" +
      "可选 replacement 草稿（新号自动发放）。createNode：沉淀新规则/实体（自动发号，可选锚声明）。" +
      "两操作均必填 iterationId；多项目 workspace 的 createNode 需 project（项目目录名）。",
    parameters: kgUpdateParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const args = params as Record<string, unknown>;
      const op = args["op"];
      const iterationId = requireString(args, "iterationId", "（change_log 每行必含）");
      if (op === "supersede") {
        return text(execSupersede(deps, args, iterationId));
      }
      if (op === "createNode") {
        return text(execCreateNode(deps, args, iterationId));
      }
      if (op === "batchCreateNodes") {
        return text(execBatchCreateNodes(deps, args, iterationId));
      }
      throw new Error(`未知 op "${String(op)}"（合法：createNode / supersede / batchCreateNodes）`);
    },
  };
}

// ── op 执行（全部经 KgWriteService——库内唯一写路径） ────────

function execSupersede(deps: KgUpdateToolDeps, args: Record<string, unknown>, iterationId: string): string {
  const nodeId = requireString(args, "nodeId", "（取自 kg search 返回行或 📎 附着块指针）") as NodeId;
  const reason = requireString(args, "reason", "（推翻理由入审计链）");
  // 目标定位：跨项目全命中——写操作不猜（多命中/零命中均结构化报错）
  const hits = deps.query.locate(nodeId);
  if (hits.length === 0) {
    throw new Error(`节点 ${nodeId} 不存在（先 kg search 确认；id 取自返回行指针）`);
  }
  if (hits.length > 1) {
    throw new Error(
      `节点 ${nodeId} 在多个项目命中（${hits.map((h) => projectName(h.project)).join("、")}）——不支持跨项目猜测，请人工确认目标项目`,
    );
  }
  const { project } = hits[0]!;
  const replacement = draftOf(args["replacement"]);
  const writeOp: KnowledgeWriteOp = {
    kind: "supersede",
    iterationId,
    nodeId,
    reason,
    ...(replacement !== null ? { replacementNodeDraft: replacement } : {}),
  };
  const result = writeOrThrow(deps, project, writeOp);
  return replacement === null
    ? `已 supersede：${nodeId}（status 翻转，理由已入 change_log）`
    : `已 supersede：${nodeId} → 新节点 ${result.nodeId}（理由已入 change_log，链上双侧可见）`;
}

function execCreateNode(deps: KgUpdateToolDeps, args: Record<string, unknown>, iterationId: string): string {
  const draft: NodeDraft = {
    kind: requireString(args, "kind", "（rule / entity）") === "entity" ? "entity" : "rule",
    name: requireString(args, "name", "（节点名）"),
    digest: requireString(args, "digest", "（≤2 行摘要）"),
    ...(optionalString(args, "body") !== undefined ? { body: optionalString(args, "body")! } : {}),
    ...(optionalEnum<NodeDomain>(args, "domain") !== undefined ? { domain: optionalEnum<NodeDomain>(args, "domain")! } : {}),
    ...(optionalEnum<NodeLayer>(args, "layer") !== undefined ? { layer: optionalEnum<NodeLayer>(args, "layer")! } : {}),
  };
  const anchors = anchorsOf(args["anchors"]);
  const project = resolveTargetProject(deps, args);
  const result = writeOrThrow(deps, project, { kind: "createNode", iterationId, draft });
  let summary = `已建节点 ${result.nodeId}（project: ${projectName(project)}，自动发号）`;
  if (anchors !== null) {
    // 锚声明组合落账（第二笔 op）：失败不回滚建点——结构化报错携带已建 id（可重声明）
    const anchorResult = deps.write.write(project, { kind: "declareAnchors", iterationId, nodeId: result.nodeId, anchors });
    if (!anchorResult.ok) {
      throw new Error(
        `节点 ${result.nodeId} 已建，但锚声明失败：${anchorResult.error.code} ${anchorResult.error.message}` +
          `（path→glob；symbol→path#symbol；global 不携带 pattern）——可用 declare 语义重试`,
      );
    }
    summary += `；锚声明 ${anchors.length} 条`;
  }
  return summary;
}

/** 写结果归一：失败抛结构化错误（code+message+path 全量透传给 agent）。 */
function writeOrThrow(deps: KgUpdateToolDeps, project: string, op: KnowledgeWriteOp): { nodeId: NodeId } {
  const result = deps.write.write(project, op);
  if (!result.ok) {
    const path = result.error.path !== undefined ? `（${result.error.path}）` : "";
    throw new Error(`${result.error.code}：${result.error.message}${path}`);
  }
  return { nodeId: result.nodeId };
}

/**
 * batchCreateNodes 执行（O-5）：逐项薄壳组载荷（自动发号——工具面不暴露
 * 显式 id，保号迁移不入 LLM 面），单笔 op 经唯一写入口；项目解析同单条
 * createNode（多项目必填 project）。
 */
function execBatchCreateNodes(deps: KgUpdateToolDeps, args: Record<string, unknown>, iterationId: string): string {
  const value = args["nodes"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("nodes 必填且为非空数组（批量建点：[{kind, name, digest, …}]）");
  }
  const nodes = value.map((item, i) => {
    const draft = draftOf(item, `nodes[${i}]`);
    if (draft === null) {
      throw new Error(`nodes[${i}] 必须为节点草稿对象（kind/name/digest）`);
    }
    return { draft };
  });
  const project = resolveTargetProject(deps, args);
  const result = writeOrThrow(deps, project, { kind: "batchCreateNodes", iterationId, nodes });
  return `已批量建节点 ${nodes.length} 个（project: ${projectName(project)}，自动发号；末节点 ${result.nodeId}）`;
}

/** createNode 目标项目解析：project 名 → projectRoot；缺省唯一项目自动；多项目必填。 */
function resolveTargetProject(deps: KgUpdateToolDeps, args: Record<string, unknown>): string {
  const scanned = deps.scanProjects();
  const given = optionalString(args, "project");
  if (given !== undefined) {
    const hit = scanned.find((p) => projectName(p) === given);
    if (hit === undefined) {
      throw new Error(
        `项目 "${given}" 不在 workspace（可用：${scanned.map(projectName).join("、") || "（无）"}）`,
      );
    }
    return hit;
  }
  if (scanned.length === 1) return scanned[0]!;
  throw new Error(
    `workspace 有 ${scanned.length} 个项目，createNode 需 project 参数指明目标` +
      `（可用：${scanned.map(projectName).join("、") || "（无）"}）`,
  );
}

// ── 参数叶子 ────────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string, hint: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少必填参数 ${key}${hint}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** domain/layer 枚举叶（非法值交给 KgWriteService 校验器——结构化错误透传）。 */
function optionalEnum<T extends string>(args: Record<string, unknown>, key: string): T | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? (value as T) : undefined;
}

/** 节点草稿组载荷（label 定位错误消息：单条 replacement / 批量 nodes[i]）。 */
function draftOf(value: unknown, label = "replacement"): NodeDraft | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须为节点草稿对象（kind/name/digest）`);
  }
  const record = value as Record<string, unknown>;
  return {
    kind: record["kind"] === "entity" ? "entity" : "rule",
    name: requireString(record, "name", `（${label} 草稿）`),
    digest: requireString(record, "digest", `（${label} 草稿）`),
    ...(typeof record["body"] === "string" ? { body: record["body"] } : {}),
    ...(typeof record["domain"] === "string" ? { domain: record["domain"] as NodeDomain } : {}),
    ...(typeof record["layer"] === "string" ? { layer: record["layer"] as NodeLayer } : {}),
  };
}

function anchorsOf(value: unknown): AnchorDeclaration[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("anchors 必须为数组 [{scopeKind, pattern}]");
  return value.map((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`anchors[${i}] 必须为对象`);
    }
    const record = item as Record<string, unknown>;
    const scopeKind = record["scopeKind"];
    if (scopeKind !== "global" && scopeKind !== "path" && scopeKind !== "symbol") {
      throw new Error(`anchors[${i}].scopeKind 仅接受 global / path / symbol`);
    }
    const pattern = typeof record["pattern"] === "string" ? record["pattern"] : "";
    return { scopeKind, pattern } satisfies AnchorDeclaration;
  });
}

function projectName(projectRoot: string): string {
  const parts = projectRoot.split("/");
  return parts[parts.length - 1] || projectRoot;
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}
