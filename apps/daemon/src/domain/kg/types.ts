/**
 * kg 子系统共享数据类型（domain/kg，framework-free 纯类型 + 封闭词表常量）。
 *
 * 架构锚：iter-20260825-11fo architecture.md §3.1（统一 .kg 单库表模型）、
 * §3.3（kg service API / Port 定义）；AD-8/AD-9（SoT 下沉 db）、AD-11
 * （status 预留）、AD-13（三级作用域锚）、AD-16（id 策略/词表继承）。
 *
 * 本文件是被 application/ports（读写 Port）与 adapters/driven/sqlite-kg
 * 共同 import 的唯一类型源（AG-01：port 只接口；类型收口 domain）。
 * 附着面共享类型（AttachmentSnapshot/AttachmentInput 等）按 T1.2 brief
 * 契约定稿（并行冲突裁决：以 T1.2 brief 契约为准回写对齐）。
 */

// ── 节点基础 ────────────────────────────────────────────────

/** 节点类别（AD-16：rule→TR-n，entity→E-n；v1 kind 收窄沿用）。 */
export type NodeKind = "rule" | "entity";

/**
 * 节点生命周期（AD-11 预留 + AD-14/16 supersede 翻转目标态）：
 * draft=待审，confirmed=已确认，superseded=已被推翻（终态）。
 */
export type NodeStatus = "draft" | "confirmed" | "superseded";

/** 知识域（AD-16：tech/business 降为属性，不进 id）。 */
export type NodeDomain = "tech" | "business";

/** bootstrap 分层（AD-11：L0 核心层 / L1 领域层 / L2 实体层；下迭代消费，schema 先定形）。 */
export type NodeLayer = "L0" | "L1" | "L2";

/** 节点 id（系统 join 键：TR-n / E-n；id 永不做人类界面语汇，AD-16）。 */
export type NodeId = string;

/** 节点完整行（读面形状；ts ISO 8601）。 */
export interface KnowledgeNode {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly name: string;
  readonly digest: string;
  readonly body: string;
  readonly domain: NodeDomain | null;
  readonly layer: NodeLayer | null;
  readonly status: NodeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── 边（封闭词表） ─────────────────────────────────────────

/**
 * 知识边封闭词表（v1 kg DDL「核心封闭词表」继承：supersedes | changed |
 * dependsOn | partOf | governs | affects | references）。写入校验唯一来源
 * （AD-9 校验即防线：越界 verb → KG_E_VERB）。
 */
export const EDGE_VERBS = [
  "supersedes",
  "changed",
  "dependsOn",
  "partOf",
  "governs",
  "affects",
  "references",
] as const;

export type EdgeVerb = (typeof EDGE_VERBS)[number];

/** 知识边行（edges 表形状）。 */
export interface EdgeRow {
  readonly srcId: NodeId;
  readonly verb: EdgeVerb;
  readonly dstId: NodeId;
}

// ── 锚（AD-13 三级作用域） ─────────────────────────────────

/** 锚作用域声明级别：global（不建锚）/ path（文件级）/ symbol（符号级）。 */
export type AnchorScopeKind = "global" | "path" | "symbol";

/**
 * 锚作用域声明（写入时声明）：pattern 语义按 scopeKind——global 恒空串
 * （可省略，读面归一为 ""）；path→glob/path pattern；symbol→path#symbol 锚定。
 */
export interface AnchorDeclaration {
  readonly scopeKind: AnchorScopeKind;
  readonly pattern?: string;
}

/** 物化锚 anchorKind（global 声明永不物化，故物化面只有 path/symbol 两值）。 */
export type AnchorKind = "path" | "symbol";

/** 物化锚行（materialized_anchors 表形状；path 锚 anchorSymbol=null）。 */
export interface MaterializedAnchor {
  readonly nodeId: NodeId;
  readonly anchorPath: string;
  readonly anchorSymbol: string | null;
  readonly anchorKind: AnchorKind;
}

// ── 变更日志（supersede 链载体，AD-9 库内审计界面） ──────────

/** 写 op 种类（KnowledgeWriteOp 判别值；change_log.op 取值同源）。 */
export type KnowledgeWriteOpKind =
  | "createNode"
  | "updateNode"
  | "supersede"
  | "declareAnchors"
  | "addEdge";

/**
 * 变更日志行：每 op 自动追加（迭代 id/op/nodeId/supersede_of/理由/时间）。
 * supersede_of 语义：本条变更挂入哪个节点的取代链——supersede op 记自身
 * （目标节点翻态进自身历史链）；supersede+replacement 的 replacement
 * createNode 行记被取代者（新节点挂旧节点链）。
 */
export interface ChangeLogEntry {
  readonly seq: number;
  readonly iterationId: string;
  readonly op: KnowledgeWriteOpKind;
  readonly nodeId: NodeId;
  readonly supersedeOf: NodeId | null;
  readonly reason: string | null;
  readonly ts: string;
}

// ── 写 op（kg service API 判别式联合） ──────────────────────

/** 节点草稿（createNode / supersede.replacementNodeDraft 共用形状）。 */
export interface NodeDraft {
  readonly kind: NodeKind;
  readonly name: string;
  /** ≤2 行摘要（v1 digest 约定沿用；越界 → KG_E_SCHEMA）。 */
  readonly digest: string;
  readonly body?: string;
  readonly domain?: NodeDomain;
  readonly layer?: NodeLayer;
  /** 建库态只接受 draft/confirmed；superseded 只能经 supersede op 到达。 */
  readonly status?: Exclude<NodeStatus, "superseded">;
}

/** 节点内容补丁（updateNode；status 不接受 superseded——归 supersede op）。 */
export interface NodePatch {
  readonly name?: string;
  readonly digest?: string;
  readonly body?: string;
  readonly domain?: NodeDomain | null;
  readonly layer?: NodeLayer | null;
  readonly status?: Exclude<NodeStatus, "superseded">;
}

/** 写 op 公共字段：change_log 每行必含迭代 id。 */
export interface KnowledgeWriteOpBase {
  readonly iterationId: string;
}

/**
 * 知识层写 op 判别式联合（AD-9「schema 校验即防线」的校验对象）：
 * - createNode：日常自动发号；显式 id 仅保号迁移场景（T5.2），冲突在事务内查出；
 * - supersede：翻 status 不换号（supersede.ts 状态机），replacement 另发新号。
 */
export type KnowledgeWriteOp =
  | (KnowledgeWriteOpBase & { readonly kind: "createNode"; readonly draft: NodeDraft; readonly id?: NodeId })
  | (KnowledgeWriteOpBase & { readonly kind: "updateNode"; readonly nodeId: NodeId; readonly patch: NodePatch })
  | (KnowledgeWriteOpBase & {
      readonly kind: "supersede";
      readonly nodeId: NodeId;
      readonly reason: string;
      readonly replacementNodeDraft?: NodeDraft;
    })
  | (KnowledgeWriteOpBase & {
      readonly kind: "declareAnchors";
      readonly nodeId: NodeId;
      readonly anchors: readonly AnchorDeclaration[];
    })
  | (KnowledgeWriteOpBase & {
      readonly kind: "addEdge";
      readonly srcId: NodeId;
      readonly verb: EdgeVerb;
      readonly dstId: NodeId;
    });

// ── 写结果（结构化错误） ────────────────────────────────────

/**
 * 结构化错误码（AD-9：写错形态从「损坏的文档」变成「被拒绝的请求」）：
 * - KG_E_SCHEMA：参数形态非法（未知 op kind/缺必填/超约束/枚举越界）；
 * - KG_E_VERB：边 verb 不在封闭词表；
 * - KG_E_ID：id 引用不存在或与现存冲突；
 * - KG_E_STATE：状态机非法迁移（如重复 supersede）；
 * - KG_E_INTERNAL：落库层意外故障（事务已回滚，不落半态）。
 */
export type KgWriteErrorCode = "KG_E_SCHEMA" | "KG_E_VERB" | "KG_E_ID" | "KG_E_STATE" | "KG_E_INTERNAL";

/** 结构化错误（code/message/字段路径——字段路径定位到 op 内叶子，如 op.draft.name）。 */
export interface KgWriteError {
  readonly code: KgWriteErrorCode;
  readonly message: string;
  readonly path?: string;
}

/** 写结果：nodeId = 受影响节点（create/supersede+replacement = 新发号）。 */
export type WriteResult = { readonly ok: true; readonly nodeId: NodeId } | { readonly ok: false; readonly error: KgWriteError };

// ── 符号层（sync 管道数据面，T2.2 产生） ────────────────────

/** 文件清单行（增量基准：mtime/sha256）。 */
export interface SymbolFileRecord {
  readonly path: string;
  readonly mtime: number;
  readonly sha256: string;
}

/** 符号行（name/kind/span 行区间/file）。 */
export interface SymbolRecord {
  readonly name: string;
  readonly kind: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly file: string;
}

/** 符号包含边（类含方法；AD-7 类级上溯依赖）。 */
export interface SymbolContainsEdge {
  readonly outerSymbol: string;
  readonly innerSymbol: string;
  readonly file: string;
}

/**
 * sync 单事务批次（applySync 入参，T2.2 消费）：符号层三表 + 物化锚 +
 * meta（导入基准戳——时序可判定关键，AD-15；degraded 显式状态，F5.5 上报）。
 */
export interface SymbolBatch {
  readonly files: readonly SymbolFileRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly containsEdges: readonly SymbolContainsEdge[];
  readonly materializedAnchors: readonly MaterializedAnchor[];
  readonly baseline: string;
  readonly degraded: boolean;
}

// ── 读面（附着/注入/详情/状态） ─────────────────────────────

/**
 * 附着锚扁平 join 行（sqlite-kg RowMapper 中间形状：物化锚×节点摘要
 * 单行自足；T3.2 接线时投影为 AttachmentSnapshot 的分组形状）。
 */
export interface AttachmentAnchor extends MaterializedAnchor {
  readonly nodeKind: NodeKind;
  readonly nodeName: string;
  readonly nodeDigest: string;
  readonly nodeStatus: NodeStatus;
}

// ── 附着管线（T1.2 四层递降匹配消费；brief 契约定稿） ────────

/** 附着快照 digest 行（导航与约束层最小暴露面：digest+指针，AD-3）。 */
export interface KgNodeDigestRow {
  readonly id: NodeId;
  readonly kind: NodeKind;
  /** 非唯一键：重名合法，靠 digest 区分（AD-16）。 */
  readonly name: string;
  /** ≤2 行摘要。 */
  readonly digest: string;
  /** 锚作用域域别（global 为防御性过滤键）。 */
  readonly scopeKind: AnchorScopeKind;
}

/** 路径域物化锚投影：nodeId → 文件。 */
export interface FileAnchor {
  readonly nodeId: NodeId;
  readonly path: string;
}

/** 符号行区间：1-based 闭区间（含首尾行）；上次 sync 值，允许滞后（AD-15）。 */
export interface SymbolSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/** 符号域物化锚投影：nodeId → path#symbol（AD-13 确定性 join 产物）。 */
export interface SymbolAnchor extends FileAnchor {
  readonly symbol: string;
  /** 上次 sync 的符号 span；缺省表示无法参与 L3 兜底。 */
  readonly span?: SymbolSpan;
}

/**
 * 符号包含边投影（类含方法；L2 类级上溯唯一步径，AD-7 补充）。
 * 与 SymbolContainsEdge 同形——sync 批次（SymbolBatch）到附着快照的行映射
 * 在 T2.2/T3.2 接线时收口。
 */
export interface ContainsEdge {
  readonly outer: string;
  readonly inner: string;
  readonly file: string;
}

/**
 * 附着快照（附着与任务层注入共用；superseded 由上游过滘、global 上游
 * 不产锚且本层防御性再滤；附着不依赖新鲜度，AD-15）。
 */
export interface AttachmentSnapshot {
  /** 该文件锚域可达节点。 */
  readonly nodes: readonly KgNodeDigestRow[];
  readonly fileAnchors: readonly FileAnchor[];
  readonly symbolAnchors: readonly SymbolAnchor[];
  readonly contains: readonly ContainsEdge[];
}

/** 附着输入：一次成功 edit 的现场（行号 1-based 闭区间；edit 工具接线于 T3.2）。 */
export interface AttachmentInput {
  readonly filePath: string;
  readonly oldText: string;
  readonly newText: string;
  readonly editLineStart: number;
  readonly editLineEnd: number;
  /** 编辑后文件全量行（L3 陈旧 span 回扫与失配判定用）。 */
  readonly fileLines: readonly string[];
}

/** search 返回行（name/digest LIKE 命中；重名多行靠 digest 区分，AD-16）。 */
export interface NodeDigestRow {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly name: string;
  readonly digest: string;
  readonly status: NodeStatus;
  readonly domain: NodeDomain | null;
}

/** 节点关系视图（getNode 聚合：出边/入边统一形状）。 */
export interface NodeEdgeView {
  readonly verb: EdgeVerb;
  readonly otherId: NodeId;
  readonly direction: "out" | "in";
}

/** supersede 链环节（relation：self=本节点 / older=被本节点取代 / newer=取代本节点）。 */
export interface SupersedeChainLink {
  readonly nodeId: NodeId;
  readonly name: string;
  readonly status: NodeStatus;
  readonly relation: "self" | "older" | "newer";
}

/** getNode 聚合详情（含锚/关系/supersede 链/变更日志）。 */
export interface NodeDetail {
  readonly node: KnowledgeNode;
  readonly anchorDeclarations: readonly AnchorDeclaration[];
  readonly materializedAnchors: readonly Omit<MaterializedAnchor, "nodeId">[];
  readonly edges: readonly NodeEdgeView[];
  readonly supersedeChain: readonly SupersedeChainLink[];
  readonly changeLog: readonly ChangeLogEntry[];
}

/** 索引状态（基准戳/符号计数/degraded 标记位；F5.5 面板数据源）。 */
export interface IndexStatus {
  readonly baseline: string | null;
  readonly symbolCount: number;
  readonly degraded: boolean;
}
