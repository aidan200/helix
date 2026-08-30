import type { KnowledgeStorePort } from "../../ports/outbound/KnowledgeStorePort";
import { CANDIDATE_KINDS, EDGE_VERBS } from "../../../domain/kg/types";
import type {
  AnchorScopeKind,
  CandidateDecision,
  KgWriteError,
  KnowledgeWriteOp,
  NodeDraft,
  NodeStatus,
  WriteResult,
} from "../../../domain/kg/types";
import { parseCandidateId, parseMigrationId } from "../../../domain/kg/node-id";

/**
 * KgWriteService —— kg service API（F2.3，AD-9「schema 校验即防线」的
 * 知识层唯一写入口）。
 *
 * 全部写 op 先过参数校验器：非法形态返回结构化错误（code/message/字段
 * 路径——字段路径定位到 op 内叶子，如 op.draft.digest / op.anchors[1]），
 * **不透传 port、不落任何部分写入**（校验前置）。校验通过才经
 * KnowledgeStorePort 落库（事务内编号/引用完整性由 port 承担）。
 *
 * 消费场景（architecture.md §3.3）：F1.2 协议行兑现（edit 附着后 agent
 * supersede）、CL-3 落账（closure findings）、T5.2 存量迁移（显式保号 id）。
 *
 * 校验器为轻量手写守卫（daemon 无 zod 类依赖先例；错误码封闭于
 * KG_E_SCHEMA / KG_E_VERB，落库层补 KG_E_ID / KG_E_STATE / KG_E_INTERNAL）。
 */
export interface KgWriteServiceDeps {
  readonly store: KnowledgeStorePort;
}

export class KgWriteService {
  private readonly deps: KgWriteServiceDeps;

  constructor(deps: KgWriteServiceDeps) {
    this.deps = deps;
  }

  /** 唯一写入口：schema 校验（前置）→ 透传 port（事务内发号/落库）。 */
  write(projectRoot: string, op: KnowledgeWriteOp): WriteResult {
    const error = validateKnowledgeWriteOp(op);
    if (error !== null) return { ok: false, error };
    return this.deps.store.writeKnowledge(projectRoot, op);
  }
}

// ── 参数校验器（纯函数，无 IO） ────────────────────────────

const OP_KINDS = new Set<KnowledgeWriteOp["kind"]>([
  "createNode",
  "updateNode",
  "supersede",
  "declareAnchors",
  "addEdge",
  "batchCreateNodes",
  "proposeCandidate",
  "decideCandidate",
]);
const NODE_KINDS = new Set(["rule", "entity"]);
const NODE_DOMAINS = new Set(["tech", "business"]);
const NODE_LAYERS = new Set(["L0", "L1", "L2"]);
const CREATABLE_STATUSES = new Set<NodeStatus>(["draft", "confirmed"]);
const SCOPE_KINDS = new Set<AnchorScopeKind>(["global", "path", "symbol"]);
const CANDIDATE_DECISIONS = new Set<CandidateDecision>(["applied", "discarded", "deferred"]);

/**
 * op 形态校验（未知结构/缺必填/枚举越界/digest 超行/verb 越界/显式 id
 * 形态与前缀）→ 结构化错误；合法 → null。字段路径锚定 op 内叶子位置。
 */
export function validateKnowledgeWriteOp(op: unknown): KgWriteError | null {
  if (op === null || typeof op !== "object" || Array.isArray(op)) {
    return schemaError("op 必须是对象", "op");
  }
  const candidate = op as Record<string, unknown>;
  if (typeof candidate.iterationId !== "string" || candidate.iterationId.trim() === "") {
    return schemaError("iterationId 必填（change_log 每行含迭代 id）", "op.iterationId");
  }
  // 任务元数据（T2.1，AD-10）：全可选——携带则必为非空字符串；不携带时后续
  // 行为与既有逐字节一致（两列 NULL）。任务系统零「处置」概念，元数据仅
  // 登记不进任何状态机。
  if (candidate.taskId !== undefined && (typeof candidate.taskId !== "string" || candidate.taskId.trim() === "")) {
    return schemaError("taskId 若携带必须为非空字符串（任务产出元数据，AD-10）", "op.taskId");
  }
  if (
    candidate.originBatchId !== undefined &&
    (typeof candidate.originBatchId !== "string" || candidate.originBatchId.trim() === "")
  ) {
    return schemaError("originBatchId 若携带必须为非空字符串（产出批次元数据，AD-10）", "op.originBatchId");
  }
  const kind = candidate.kind;
  if (typeof kind !== "string" || !OP_KINDS.has(kind as KnowledgeWriteOp["kind"])) {
    return schemaError(
      `未知 op kind（合法集合：${[...OP_KINDS].join(" / ")}）`,
      "op.kind",
    );
  }
  switch (kind) {
    case "createNode":
      return validateCreateNode(candidate);
    case "updateNode":
      return validateUpdateNode(candidate);
    case "supersede":
      return validateSupersede(candidate);
    case "declareAnchors":
      return validateDeclareAnchors(candidate);
    case "addEdge":
      return validateAddEdge(candidate);
    case "batchCreateNodes":
      return validateBatchCreateNodes(candidate);
    case "proposeCandidate":
      return validateProposeCandidate(candidate);
    case "decideCandidate":
      return validateDecideCandidate(candidate);
    default:
      // kind 已在上方 OP_KINDS 校验，走到 default 不可达；静态兑底防未来加 kind 漏 case。
      return schemaError("未知 op.kind", "op.kind");
  }
}

/**
 * createNode 载荷校验（单条与批量逐项共用，O-5 混用等价；basePath 定位到
 * op（单条）或 op.nodes[i]（批量）——错误路径同源）。 */
function validateCreateNodePayload(record: Record<string, unknown>, basePath: string): KgWriteError | null {
  // R23 沉淀必填：自动发号通道 scene 必带（机械强制，缺了写不进去）；
  // 显式保号 id（迁移通道）豁免——存量节点回填归 kg-review，不在写入面强制。
  const sceneRequired = record.id === undefined;
  const draftError = validateNodeDraft(record.draft, `${basePath}.draft`, { sceneRequired });
  if (draftError !== null) return draftError;
  if (record.id !== undefined) {
    const id = record.id;
    if (typeof id !== "string" || parseMigrationId(id) === null) {
      return schemaError(
        "显式 id 仅限保号迁移场景，形态必须为 TR-*/E-* 存量形态（TR-AD-47 / TR-TEST-8 / E-客户）或新号空间（TR-n / E-n）",
        `${basePath}.id`,
      );
    }
    const parsed = parseMigrationId(id)!;
    const draftKind = (record.draft as NodeDraft).kind;
    if (parsed.kind !== draftKind) {
      return schemaError(`显式 id 前缀与 kind 不符（${id} 前缀属 ${parsed.kind}）`, `${basePath}.id`);
    }
  }
  return null;
}

function validateCreateNode(op: Record<string, unknown>): KgWriteError | null {
  return validateCreateNodePayload(op, "op");
}

/**
 * batchCreateNodes 校验（T2.1，O-5）：节点数组非空 + 逐项与单条 createNode
 * 同构校验（draft/id 同规则）——错误路径携带非法项序号（op.nodes[i]…）。 */
function validateBatchCreateNodes(op: Record<string, unknown>): KgWriteError | null {
  if (!Array.isArray(op.nodes) || op.nodes.length === 0) {
    return schemaError("nodes 必填且为非空数组（批量建点，O-5）", "op.nodes");
  }
  for (let i = 0; i < op.nodes.length; i += 1) {
    const payload = op.nodes[i];
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return schemaError("批量节点载荷必须为对象（draft/id 同单条 createNode）", `op.nodes[${i}]`);
    }
    const payloadError = validateCreateNodePayload(payload as Record<string, unknown>, `op.nodes[${i}]`);
    if (payloadError !== null) return payloadError;
  }
  return null;
}

function validateUpdateNode(op: Record<string, unknown>): KgWriteError | null {
  const nodeError = requireNodeId(op.nodeId);
  if (nodeError !== null) return nodeError;
  const patch = op.patch;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return schemaError("patch 必填且为对象", "op.patch");
  }
  const known = new Set(["name", "digest", "body", "domain", "layer", "status", "reason"]);
  const keys = Object.keys(patch as Record<string, unknown>);
  if (keys.length === 0) {
    return schemaError("patch 至少含一个可更新字段", "op.patch");
  }
  for (const key of keys) {
    if (!known.has(key)) {
      return schemaError(`patch 不支持字段 ${key}（可更新：${[...known].join(" / ")}）`, `op.patch.${key}`);
    }
  }
  const record = patch as Record<string, unknown>;
  if (record.name !== undefined) {
    const e = requireNonEmptyString(record.name, "名称");
    if (e !== null) return withPath(e, "op.patch.name");
  }
  if (record.digest !== undefined) {
    const e = requireDigest(record.digest);
    if (e !== null) return withPath(e, "op.patch.digest");
  }
  if (record.body !== undefined && typeof record.body !== "string") {
    return schemaError("body 必须为字符串", "op.patch.body");
  }
  if (record.domain !== undefined && record.domain !== null && !NODE_DOMAINS.has(String(record.domain))) {
    return schemaError("domain 仅接受 tech / business（或 null 清除）", "op.patch.domain");
  }
  if (record.layer !== undefined && record.layer !== null && !NODE_LAYERS.has(String(record.layer))) {
    return schemaError("layer 仅接受 L0 / L1 / L2（或 null 清除；AD-11）", "op.patch.layer");
  }
  if (record.status !== undefined && !CREATABLE_STATUSES.has(record.status as NodeStatus)) {
    return schemaError("status 仅接受 draft / confirmed（superseded 只能经 supersede op 到达）", "op.patch.status");
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    return schemaError("reason 仅接受字符串（审计叙述落 change_log）", "op.patch.reason");
  }
  return null;
}

function validateSupersede(op: Record<string, unknown>): KgWriteError | null {
  const nodeError = requireNodeId(op.nodeId);
  if (nodeError !== null) return nodeError;
  if (typeof op.reason !== "string" || op.reason.trim() === "") {
    return schemaError("reason 必填（推翻理由进 change_log 审计链）", "op.reason");
  }
  if (op.replacementNodeDraft !== undefined) {
    // replacement 草稿 scene 可缺省（brief 范围：必填仅 createNode/batchCreateNodes）；携带则须合法
    return validateNodeDraft(op.replacementNodeDraft, "op.replacementNodeDraft", { sceneRequired: false });
  }
  return null;
}

function validateDeclareAnchors(op: Record<string, unknown>): KgWriteError | null {
  const nodeError = requireNodeId(op.nodeId);
  if (nodeError !== null) return nodeError;
  if (!Array.isArray(op.anchors)) {
    return schemaError("anchors 必填且为数组（空数组 = 显式清空声明）", "op.anchors");
  }
  const seen = new Set<string>();
  for (let i = 0; i < op.anchors.length; i += 1) {
    const anchor = op.anchors[i];
    if (anchor === null || typeof anchor !== "object" || Array.isArray(anchor)) {
      return schemaError("锚声明必须为对象", `op.anchors[${i}]`);
    }
    const record = anchor as Record<string, unknown>;
    if (typeof record.scopeKind !== "string" || !SCOPE_KINDS.has(record.scopeKind as AnchorScopeKind)) {
      return schemaError(
        "scopeKind 仅接受 global / path / symbol（AD-13 三级作用域）",
        `op.anchors[${i}].scopeKind`,
      );
    }
    const pattern = record.pattern ?? "";
    if (typeof pattern !== "string") {
      return schemaError("pattern 必须为字符串", `op.anchors[${i}].pattern`);
    }
    if (record.scopeKind === "global") {
      if (pattern !== "") {
        return schemaError("global 声明不携带 pattern（常驻层系统提示到达，永不物化）", `op.anchors[${i}].pattern`);
      }
    } else if (pattern.trim() === "") {
      return schemaError(
        `scopeKind=${record.scopeKind} 的 pattern 必填（path→glob；symbol→path#symbol）`,
        `op.anchors[${i}].pattern`,
      );
    }
    const dedupeKey = `${record.scopeKind}\u0000${pattern}`;
    if (seen.has(dedupeKey)) {
      return schemaError("重复锚声明（同一作用域+pattern 只声明一次）", `op.anchors[${i}]`);
    }
    seen.add(dedupeKey);
  }
  return null;
}

function validateAddEdge(op: Record<string, unknown>): KgWriteError | null {
  const srcError = requireNodeId(op.srcId);
  if (srcError !== null) return withPath(srcError, "op.srcId");
  const dstError = requireNodeId(op.dstId);
  if (dstError !== null) return withPath(dstError, "op.dstId");
  if (typeof op.verb !== "string" || !(EDGE_VERBS as readonly string[]).includes(op.verb)) {
    return {
      code: "KG_E_VERB",
      message: `verb 不在封闭词表（合法集合：${EDGE_VERBS.join(" / ")}；v1 词表继承）`,
      path: "op.verb",
    };
  }
  return null;
}

// ── 候选台账 op 校验（D0/R2） ─────────────────────────────

function validateProposeCandidate(op: Record<string, unknown>): KgWriteError | null {
  if (typeof op.candidateKind !== "string" || !(CANDIDATE_KINDS as readonly string[]).includes(op.candidateKind)) {
    return schemaError(
      `candidateKind 不在封闭词表（合法集合：${CANDIDATE_KINDS.join(" / ")}）`,
      "op.candidateKind",
    );
  }
  const titleError = requireNonEmptyString(op.title, "title");
  if (titleError !== null) return withPath(titleError, "op.title");
  if (op.body !== undefined && typeof op.body !== "string") {
    return schemaError("body 必须为字符串", "op.body");
  }
  for (const key of ["sourceTaskId", "sourceIterationId"] as const) {
    if (op[key] !== undefined && (typeof op[key] !== "string" || (op[key] as string).trim() === "")) {
      return schemaError(`${key} 若携带必须为非空字符串（溯源列）`, `op.${key}`);
    }
  }
  if (op.id !== undefined) {
    if (typeof op.id !== "string" || parseCandidateId(op.id) === null) {
      return schemaError("显式 id 仅限 md 台账迁移保号场景，形态必须为 CAND-<seq>（如 CAND-12）", "op.id");
    }
  }
  return null;
}

function validateDecideCandidate(op: Record<string, unknown>): KgWriteError | null {
  if (typeof op.candidateId !== "string" || op.candidateId.trim() === "") {
    return schemaError("candidateId 必填（非空字符串，CAND-<seq>）", "op.candidateId");
  }
  if (typeof op.decision !== "string" || !CANDIDATE_DECISIONS.has(op.decision as CandidateDecision)) {
    return schemaError(
      `decision 仅接受 ${[...CANDIDATE_DECISIONS].join(" / ")}（pending 留在原地非裁决动作）`,
      "op.decision",
    );
  }
  if (op.reason !== undefined && (typeof op.reason !== "string" || op.reason.trim() === "")) {
    return schemaError("reason 若携带必须为非空字符串（人审理由落 decision_reason + change_log）", "op.reason");
  }
  if (op.decision === "discarded" && op.reason === undefined) {
    return schemaError("discarded 必带 reason（丢弃理由是人审审计的最低要求，D0）", "op.reason");
  }
  for (const key of ["formalId", "appliedNodeId"] as const) {
    if (op[key] !== undefined && (typeof op[key] !== "string" || (op[key] as string).trim() === "")) {
      return schemaError(`${key} 若携带必须为非空字符串`, `op.${key}`);
    }
  }
  return null;
}

// ── 叶子校验 ───────────────────────────────────────────────

function validateNodeDraft(draft: unknown, path: string, options: { sceneRequired: boolean }): KgWriteError | null {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft)) {
    return schemaError("节点草稿必须为对象", path);
  }
  const record = draft as Record<string, unknown>;
  if (typeof record.kind !== "string" || !NODE_KINDS.has(record.kind)) {
    return schemaError("kind 仅接受 rule / entity", `${path}.kind`);
  }
  const nameError = requireNonEmptyString(record.name, "名称");
  if (nameError !== null) return withPath(nameError, `${path}.name`);
  const digestError = requireDigest(record.digest);
  if (digestError !== null) return withPath(digestError, `${path}.digest`);
  // R23 适用场景：必填通道缺/空白 → 拒绝；可选通道携带时仍须非空字符串
  if (record.scene === undefined) {
    if (options.sceneRequired) {
      return schemaError(
        "scene 必填（R23 沉淀必填：「本规则适用于：改动 X 类文件 / 做 Y 类决策前」——缺了写不进去）",
        `${path}.scene`,
      );
    }
  } else if (typeof record.scene !== "string" || record.scene.trim() === "") {
    return schemaError("scene 必须为非空字符串（适用场景一句话）", `${path}.scene`);
  }
  if (record.body !== undefined && typeof record.body !== "string") {
    return schemaError("body 必须为字符串", `${path}.body`);
  }
  if (record.domain !== undefined && !NODE_DOMAINS.has(String(record.domain))) {
    return schemaError("domain 仅接受 tech / business", `${path}.domain`);
  }
  if (record.layer !== undefined && !NODE_LAYERS.has(String(record.layer))) {
    return schemaError("layer 仅接受 L0 / L1 / L2（AD-11）", `${path}.layer`);
  }
  if (record.status !== undefined && !CREATABLE_STATUSES.has(record.status as NodeStatus)) {
    return schemaError("建库态 status 仅接受 draft / confirmed", `${path}.status`);
  }
  return null;
}

function requireNodeId(value: unknown): KgWriteError | null {
  if (typeof value !== "string" || value.trim() === "") {
    return schemaError("nodeId 必填（非空字符串）", "op.nodeId");
  }
  return null;
}

function requireNonEmptyString(value: unknown, label: string): KgWriteError | null {
  if (typeof value !== "string" || value.trim() === "") {
    return schemaError(`${label}必填（非空字符串）`, "");
  }
  return null;
}

/** digest ≤2 行（v1 约定沿用；LLM 面默认展示粒度）。 */
function requireDigest(value: unknown): KgWriteError | null {
  if (typeof value !== "string" || value.trim() === "") {
    return schemaError("digest 必填（非空字符串）", "");
  }
  if (value.split("\n").length > 2) {
    return schemaError("digest 至多 2 行（v1 约定沿用）", "");
  }
  return null;
}

// ── 错误构造 ───────────────────────────────────────────────

function schemaError(message: string, path: string): KgWriteError {
  return { code: "KG_E_SCHEMA", message, ...(path !== "" ? { path } : {}) };
}

function withPath(error: KgWriteError, path: string): KgWriteError {
  return { ...error, path };
}
