import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { readdirSync } from "node:fs";
import { join } from "node:path";
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
      enum: ["createNode", "supersede", "batchCreateNodes", "proposeCandidate", "decideCandidate"],
      description:
        "操作：createNode 新知识落账 / supersede 推翻既有节点 / batchCreateNodes 批量建点（O-5：按写入量自选单条/批量）/ " +
        "proposeCandidate 提候选（仅 MainAgent 可用）/ decideCandidate 裁决候选（仅 MainAgent 可用）",
    },
    // ── createNode ──
    kind: { type: "string", enum: ["rule", "entity"], description: "createNode 节点类型（rule=规则 / entity=实体）" },
    name: { type: "string", description: "createNode 节点名（重名合法，靠 digest 区分）" },
    digest: { type: "string", description: "createNode 摘要（≤2 行——LLM 面默认展示粒度）" },
    scene: {
      type: "string",
      description:
        "适用场景（R23 沉淀必填——createNode/batchCreateNodes 缺了写不进去）：一句话「本规则适用于：改动 X 类文件 / 做 Y 类决策前」",
    },
    body: { type: "string", description: "createNode 正文（可选，全文详情）" },
    domain: { type: "string", enum: ["tech", "business"], description: "createNode 作用域（可选）" },
    layer: { type: "string", enum: ["L0", "L1", "L2"], description: "createNode 分层（可选，AD-11）" },
    status: {
      type: "string",
      enum: ["draft", "confirmed"],
      description: "建库态（可选；缺省 draft）——任务批次产出按 SOP 以 confirmed 落库（bootstrap 无 draft）",
    },
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
      description: "batchCreateNodes 批量节点载荷：[{kind, name, digest, scene, body?, domain?, layer?}]（scene 必填同单条；逐项自动发号；任一项失败整批拒绝零落库）",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["rule", "entity"], description: "节点类型（rule=规则 / entity=实体）" },
          name: { type: "string", description: "节点名（重名合法，靠 digest 区分）" },
          digest: { type: "string", description: "摘要（≤2 行）" },
          scene: { type: "string", description: "适用场景（必填：「本规则适用于：改动 X 类文件 / 做 Y 类决策前」）" },
          body: { type: "string", description: "正文（可选）" },
          domain: { type: "string", enum: ["tech", "business"], description: "作用域（可选）" },
          layer: { type: "string", enum: ["L0", "L1", "L2"], description: "分层（可选，AD-11）" },
        },
        required: ["kind", "name", "digest", "scene"],
        additionalProperties: false,
      },
    },
    // ── supersede ──
    nodeId: { type: "string", description: "supersede 目标节点 id（取自 kg search 返回行 / 附着块指针）" },
    reason: { type: "string", description: "supersede 推翻理由（入 change_log 审计链）" },
    replacement: {
      type: "object",
      description: "supersede 可选替换新节点草稿（新号自动发放，链上双侧可见；scene 建议携带）",
      properties: {
        kind: { type: "string", enum: ["rule", "entity"] },
        name: { type: "string" },
        digest: { type: "string" },
        scene: { type: "string", description: "适用场景（可选——replacement 走创建语义建议携带）" },
        body: { type: "string" },
        domain: { type: "string", enum: ["tech", "business"] },
        layer: { type: "string", enum: ["L0", "L1", "L2"] },
      },
      required: ["kind", "name", "digest"],
      additionalProperties: false,
    },
    // ── proposeCandidate / decideCandidate（仅 MainAgent 可用） ──
    candidateKind: {
      type: "string",
      enum: ["sediment"],
      description: "proposeCandidate 候选类型（封闭词表：sediment=闭环发现沉淀）",
    },
    title: { type: "string", description: "proposeCandidate 候选标题（人审台账的一行识别语）" },
    candidateId: { type: "string", description: "decideCandidate 目标候选 id（CAND-<seq>，取自 proposeCandidate 回执）" },
    decision: {
      type: "string",
      enum: ["applied", "discarded", "deferred"],
      description: "decideCandidate 裁决：applied 采纳 / discarded 丢弃（必带 reason）/ deferred 暂缓（defer_age+1）",
    },
    formalId: { type: "string", description: "decideCandidate applied 时签发的正式编号（TR-n/E-n；可选）" },
    appliedNodeId: { type: "string", description: "decideCandidate applied 后落到的节点 id（溯源；可选）" },
    // ── 通用 ──
    iterationId: {
      type: "string",
      description:
        "当前迭代 id（可选覆盖——缺省服务端机械解析：workspace 当前迭代（.helix/iterations 最新）→ 目标库最近迭代锚；均缺时才需显式传参。change_log 每行必含）",
    },
    project: { type: "string", description: "createNode 目标项目目录名（workspace 只有一个项目时可省；多项目必填）" },
    taskId: {
      type: "string",
      description: "任务来源 id（可选）：任务批次上下文由接线层机械注入默认值（落 change_log.task_id 记账溯源），仅需显式传参覆盖时才携带",
    },
    originBatchId: {
      type: "string",
      description: "产出批次 id（可选）：任务批次上下文由接线层机械注入默认值（产出分组/幂等重跑判据），仅需显式传参覆盖时才携带",
    },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

export interface KgUpdateToolDeps {
  readonly query: Pick<KgQueryService, "locate"> & {
    /**
     * 目标库最近迭代锚（iterationId 机械解析的库内回落；A4 任务二）。可选——
     * 结构性缺席（同形测试记录器）时仅退化该级回落，workspace 迭代状态
     * 解析与显式传参不受影响。
     */
    readonly latestIteration?: (projectRoot: string) => string | null;
  };
  /** KgWriteService 面（结构化注入——测试记录器同形）。 */
  readonly write: { write(projectRoot: string, op: KnowledgeWriteOp): WriteResult };
  /** workspace 根（project 名 → projectRoot 解析）。 */
  readonly workspaceRoot: string;
  /** workspace 全项目扫描（createNode 目标解析；含未建 .kg 项目）。 */
  readonly scanProjects: () => readonly string[];
  /**
   * 任务归属上下文（T4.2 机械注入，AD-10/AF-T4.1.4/T4.1.6）：批次子进程
   * 接线层（ChildMain，HELIX_DB_PATH 同面）从任务台账解析本实例归属
   * jobId/batchId，对三写路径（单条/批量/supersede replacement）注入
   * taskId/originBatchId 默认值——LLM 显式传参优先（透传降级为可选覆盖）。
   * 缺席/返回 undefined = 非任务上下文（主会话/chat 子进程）→ 零注入，
   * task_id 保持 NULL（kg 更新不强制关联任务），行为与现状逐字节一致。
   */
  readonly taskContext?: () => { readonly taskId: string; readonly originBatchId: string } | undefined;
}

/** kg-update 即时落账工具：注册名 "kg-update"。 */
export function createKgUpdateTool(deps: KgUpdateToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "kg-update",
    label: "kg-update",
    description:
      "知识图谱即时落账（经唯一写入口，schema 校验前置）。supersede：本次改动推翻某知识节点时" +
      "（📎 附着块或任务切片尾部的协议行触发）立即声明——status 翻转 + 理由 + iterationId 入审计链，" +
      "可选 replacement 草稿（新号自动发放）。createNode：沉淀新规则/实体（自动发号，可选锚声明）；" +
      "scene 适用场景必填（「本规则适用于：改动 X 类文件 / 做 Y 类决策前」，缺了写不进去）。" +
      "proposeCandidate/decideCandidate：候选台账操作——**仅 MainAgent 可用**（SubAgent 闭环发现经 " +
      "findings 上报自动落候选，不得直接调用候选 op）。" +
      "iterationId 缺省服务端机械解析（workspace 当前迭代 → 目标库最近迭代锚），显式传参仅作覆盖；" +
      "多项目 workspace 的 createNode 需 project（项目目录名）。",
    parameters: kgUpdateParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const args = params as Record<string, unknown>;
      const op = args["op"];
      if (op === "supersede") {
        return text(execSupersede(deps, args));
      }
      if (op === "createNode") {
        return text(execCreateNode(deps, args));
      }
      if (op === "batchCreateNodes") {
        return text(execBatchCreateNodes(deps, args));
      }
      if (op === "proposeCandidate") {
        return text(execProposeCandidate(deps, args));
      }
      if (op === "decideCandidate") {
        return text(execDecideCandidate(deps, args));
      }
      throw new Error(
        `未知 op "${String(op)}"（合法：createNode / supersede / batchCreateNodes / proposeCandidate / decideCandidate）`,
      );
    },
  };
}

// ── op 执行（全部经 KgWriteService——库内唯一写路径） ────────

function execSupersede(deps: KgUpdateToolDeps, args: Record<string, unknown>): string {
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
  const iterationId = resolveIterationId(deps, args, project);
  const context = deps.taskContext?.();
  const draft = draftOf(args["replacement"]);
  // T4.2（AF-T4.1.6）：批次上下文内 replacement 默认 confirmed（bootstrap
  // 无 draft 自约束的机械兑现）；非批次上下文 status 语义不变（缺省 draft）
  const replacement =
    draft !== null && context !== undefined && draft.status === undefined
      ? { ...draft, status: "confirmed" as const }
      : draft;
  const writeOp: KnowledgeWriteOp = createOp(deps, args, {
    kind: "supersede",
    iterationId,
    nodeId,
    reason,
    ...(replacement !== null ? { replacementNodeDraft: replacement } : {}),
  });
  const result = writeOrThrow(deps, project, writeOp);
  return replacement === null
    ? `已 supersede：${nodeId}（status 翻转，理由已入 change_log）`
    : `已 supersede：${nodeId} → 新节点 ${result.nodeId}（理由已入 change_log，链上双侧可见）`;
}

function execCreateNode(deps: KgUpdateToolDeps, args: Record<string, unknown>): string {
  const draft: NodeDraft = {
    kind: requireString(args, "kind", "（rule / entity）") === "entity" ? "entity" : "rule",
    name: requireString(args, "name", "（节点名）"),
    digest: requireString(args, "digest", "（≤2 行摘要）"),
    scene: requireString(args, "scene", "（R23 沉淀必填——「本规则适用于：改动 X 类文件 / 做 Y 类决策前」）"),
    ...(optionalString(args, "body") !== undefined ? { body: optionalString(args, "body")! } : {}),
    ...(optionalEnum<NodeDomain>(args, "domain") !== undefined ? { domain: optionalEnum<NodeDomain>(args, "domain")! } : {}),
    ...(optionalEnum<NodeLayer>(args, "layer") !== undefined ? { layer: optionalEnum<NodeLayer>(args, "layer")! } : {}),
    ...(optionalEnum<DraftStatus>(args, "status") !== undefined ? { status: optionalEnum<DraftStatus>(args, "status")! } : {}),
  };
  const anchors = anchorsOf(args["anchors"]);
  const project = resolveTargetProject(deps, args);
  const iterationId = resolveIterationId(deps, args, project);
  const result = writeOrThrow(deps, project, createOp(deps, args, { kind: "createNode", iterationId, draft }));
  let summary = `已建节点 ${result.nodeId}（project: ${projectName(project)}，自动发号）`;
  if (anchors !== null) {
    // 锚声明组合落账（第二笔 op）：失败不回滚建点——结构化报错携带已建 id（可重声明）。
    // A4：组合 op 同走 createOp 注入面——批次上下文内 declareAnchors 的
    // change_log 行机械落 task_id（实证首跑该路径全 NULL 的丢章裂口修复）
    const anchorResult = deps.write.write(
      project,
      createOp(deps, args, { kind: "declareAnchors", iterationId, nodeId: result.nodeId, anchors }),
    );
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
function writeOrThrow(deps: KgUpdateToolDeps, project: string, op: KnowledgeWriteOp): { nodeId: NodeId; warning?: string } {
  const result = deps.write.write(project, op);
  if (!result.ok) {
    const path = result.error.path !== undefined ? `（${result.error.path}）` : "";
    throw new Error(`${result.error.code}：${result.error.message}${path}`);
  }
  return { nodeId: result.nodeId, ...(result.warning !== undefined ? { warning: result.warning } : {}) };
}

/**
 * proposeCandidate 执行（R2，仅 MainAgent 可用——description 纪律面）：
 * title/candidateKind/body → pending 行（自动发号 CAND-<seq>）；
 * source_task_id 批次上下文机械注入（AD-10 三路径同源；LLM 显式传参优先——
 * 复用 taskId 参数位）；source_iteration_id 取解析后迭代 id（显式 sourceIterationId
 * 覆盖暂不提供——与 change_log 迭代锚同值即可溯源）。
 */
function execProposeCandidate(deps: KgUpdateToolDeps, args: Record<string, unknown>): string {
  const candidateKind = requireString(args, "candidateKind", "（封闭词表：sediment）");
  const title = requireString(args, "title", "（候选标题）");
  const project = resolveTargetProject(deps, args);
  const iterationId = resolveIterationId(deps, args, project);
  const context = deps.taskContext?.();
  const sourceTaskId = optionalString(args, "taskId") ?? context?.taskId;
  const result = writeOrThrow(
    deps,
    project,
    createOp(deps, args, {
      kind: "proposeCandidate",
      iterationId,
      candidateKind: candidateKind as "sediment",
      title,
      ...(optionalString(args, "body") !== undefined ? { body: optionalString(args, "body")! } : {}),
      ...(sourceTaskId !== undefined ? { sourceTaskId } : {}),
      sourceIterationId: iterationId,
    }),
  );
  return `已提候选 ${result.nodeId}（project: ${projectName(project)}，status=pending——终验人审裁决）`;
}

/**
 * decideCandidate 执行（R2，仅 MainAgent 可用）：pending/deferred → applied/
 * discarded/deferred；defer 软上限警告（只警告不拒绝）透传回执。
 */
function execDecideCandidate(deps: KgUpdateToolDeps, args: Record<string, unknown>): string {
  const candidateId = requireString(args, "candidateId", "（CAND-<seq>，取自 proposeCandidate 回执）");
  const decision = requireString(args, "decision", "（applied / discarded / deferred）");
  const project = resolveTargetProject(deps, args);
  const iterationId = resolveIterationId(deps, args, project);
  const result = writeOrThrow(
    deps,
    project,
    createOp(deps, args, {
      kind: "decideCandidate",
      iterationId,
      candidateId,
      decision: decision as "applied" | "discarded" | "deferred",
      ...(optionalString(args, "reason") !== undefined ? { reason: optionalString(args, "reason")! } : {}),
      ...(optionalString(args, "formalId") !== undefined ? { formalId: optionalString(args, "formalId")! } : {}),
      ...(optionalString(args, "appliedNodeId") !== undefined ? { appliedNodeId: optionalString(args, "appliedNodeId")! } : {}),
    }),
  );
  const warning = result.warning !== undefined ? `；警告：${result.warning}` : "";
  return `已裁决候选 ${result.nodeId} → ${decision}（decision_reason 已落账，change_log 审计同行）${warning}`;
}

/**
 * 任务产出元数据（T4.2 机械注入）：LLM 显式传参优先；未传用接线层注入的
 * 任务归属默认值（批次子进程上下文）；无任务上下文 → 不携带（task_id
 * 保持 NULL——kg 更新不强制关联任务，非任务上下文零行为变化）。
 */
function createOp<T extends KnowledgeWriteOp>(deps: KgUpdateToolDeps, args: Record<string, unknown>, op: T): T {
  const context = deps.taskContext?.();
  const taskId = optionalString(args, "taskId") ?? context?.taskId;
  const originBatchId = optionalString(args, "originBatchId") ?? context?.originBatchId;
  return {
    ...op,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(originBatchId !== undefined ? { originBatchId } : {}),
  };
}

/**
 * batchCreateNodes 执行（O-5）：逐项薄壳组载荷（自动发号——工具面不暴露
 * 显式 id，保号迁移不入 LLM 面），单笔 op 经唯一写入口；项目解析同单条
 * createNode（多项目必填 project）；op 级 status/taskId/originBatchId 逐节点
 * 同源（任务批次产出的批量落账形态，T4.1）。
 */
function execBatchCreateNodes(deps: KgUpdateToolDeps, args: Record<string, unknown>): string {
  const value = args["nodes"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("nodes 必填且为非空数组（批量建点：[{kind, name, digest, …}]）");
  }
  const opStatus = optionalEnum<DraftStatus>(args, "status");
  // op 级 layer 逐节点同源（T4.1 修正：与 status/taskId/originBatchId 同型——
  // 任务批次产出的批量落账形态，layer 在 op 级携带；单条 createNode 先例 :199）
  const opLayer = optionalEnum<NodeLayer>(args, "layer");
  const nodes = value.map((item, i) => {
    const draft = draftOf(item, `nodes[${i}]`, { requireScene: true });
    if (draft === null) {
      throw new Error(`nodes[${i}] 必须为节点草稿对象（kind/name/digest）`);
    }
    const stamped = opStatus !== undefined ? { ...draft, status: opStatus } : draft;
    return { draft: opLayer !== undefined ? { ...stamped, layer: opLayer } : stamped };
  });
  const project = resolveTargetProject(deps, args);
  const iterationId = resolveIterationId(deps, args, project);
  const result = writeOrThrow(deps, project, createOp(deps, args, { kind: "batchCreateNodes", iterationId, nodes }));
  return `已批量建节点 ${nodes.length} 个（project: ${projectName(project)}，自动发号；末节点 ${result.nodeId}）`;
}

/**
 * iterationId 解析（A4 任务二，服务端机械解析为主）：LLM 显式传参优先
 * （覆盖语义保持）；缺省 → ① workspace 当前迭代（<workspaceRoot>/.helix/
 * iterations 最新 iter-* 目录——真实迭代锚，任务上下文无迭代归属时继承
 * workspace 现值）→ ② 目标库最近迭代锚（change_log 末行，滞后兑底）；
 * 皆缺 → 结构化报错不猜（不写无归属审计行）。
 */
function resolveIterationId(deps: KgUpdateToolDeps, args: Record<string, unknown>, project: string): string {
  const explicit = optionalString(args, "iterationId");
  if (explicit !== undefined) return explicit;
  const workspaceIteration = workspaceCurrentIteration(deps.workspaceRoot);
  if (workspaceIteration !== undefined) return workspaceIteration;
  const anchor = deps.query.latestIteration?.(project);
  if (anchor !== undefined && anchor !== null) return anchor;
  throw new Error(
    "缺少必填参数 iterationId（change_log 每行必含迭代 id；服务端机械解析双锚均缺——" +
      "workspace 无 .helix/iterations 迭代状态且目标库 change_log 为空，请显式传参）",
  );
}

/** workspace 当前迭代（.helix/iterations 最新 iter-* 目录名；目录缺席/为空 → undefined）。 */
function workspaceCurrentIteration(workspaceRoot: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(join(workspaceRoot, ".helix", "iterations"));
  } catch {
    return undefined; // 目录缺席（无迭代状态的 workspace）——不猜
  }
  const iterations = entries.filter((e) => e.startsWith("iter-")).sort();
  return iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
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

/** 建库态枚举（draft/confirmed——superseded 只能经 supersede op 到达）。 */
type DraftStatus = NonNullable<NodeDraft["status"]>;

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

/** 节点草稿组载荷（label 定位错误消息：单条 replacement / 批量 nodes[i]；requireScene=批量必填——replacement 可选）。 */
function draftOf(value: unknown, label = "replacement", options: { requireScene?: boolean } = {}): NodeDraft | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须为节点草稿对象（kind/name/digest${options.requireScene === true ? "/scene" : ""}）`);
  }
  const record = value as Record<string, unknown>;
  return {
    kind: record["kind"] === "entity" ? "entity" : "rule",
    name: requireString(record, "name", `（${label} 草稿）`),
    digest: requireString(record, "digest", `（${label} 草稿）`),
    ...(options.requireScene === true
      ? { scene: requireString(record, "scene", `（${label} 草稿——R23 沉淀必填）`) }
      : typeof record["scene"] === "string" && record["scene"] !== ""
        ? { scene: record["scene"] }
        : {}),
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
