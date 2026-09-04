/**
 * kg 子系统共享数据类型（domain/kg，framework-free 纯类型 + 封闭词表常量）。
 *
 * 架构锚：iter-20260825-11fo architecture.md §3.1（统一 .helix-kg 单库表模型）、
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
  /** 适用场景（R23：「本规则适用于改动 X 类文件 / 做 Y 类决策前」；存量未回填 = ''）。 */
  readonly scene: string;
  readonly body: string;
  readonly domain: NodeDomain | null;
  readonly layer: NodeLayer | null;
  /** 产出批次元数据（AD-10 任务→kg 唯一衔接面；无任务来源 = null；T2.1 起可落值，读面向前兼容可选）。 */
  readonly originBatchId?: string | null;
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

/**
 * 边原始行（verb 未收窄为 string——词表封闭性破坏检出的输入面，T5.1
 * verify 消费）：库内 edges 表的忠实投影，越界 verb 不在类型层遮蔽。
 */
export interface RawEdgeRow {
  readonly srcId: NodeId;
  readonly verb: string;
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

/**
 * 物化锚行（materialized_anchors 表形状；path 锚 anchorSymbol=null）。
 * orphan=true：符号消亡/锚声明撤销后的失效标记（保留行不物理删，供 T5.1
 * 检出——T2.2 锚失效检测写入；缺省 undefined = 活跃，读面以 orphan=0 过滤）。
 */
export interface MaterializedAnchor {
  readonly nodeId: NodeId;
  readonly anchorPath: string;
  readonly anchorSymbol: string | null;
  readonly anchorKind: AnchorKind;
  readonly orphan?: boolean;
}

// ── 候选台账（D0/R1-R3：md 四分区库内化；写面唯一走 KgWriteService） ──

/** 候选类型封闭词表（service 层校验——同 edges 词表不进 DDL 先例；sediment=闭环发现沉淀）。 */
export const CANDIDATE_KINDS = ["sediment"] as const;

export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/** 候选状态机：pending→applied/discarded/deferred（applied/discarded 为终态；deferred 可再裁决）。 */
export type CandidateStatus = "pending" | "applied" | "discarded" | "deferred";

/** decideCandidate 裁决动作（pending 留在原地非裁决动作，故不在内）。 */
export type CandidateDecision = "applied" | "discarded" | "deferred";

/** defer 软上限（D0：积压 ≤10 条 / 年龄 ≤2——service 层只警告不拒绝，机械只列不修）。 */
export const CANDIDATE_DEFER_MAX_AGE = 2;
export const CANDIDATE_DEFER_MAX_PENDING = 10;

/** 候选行（candidates 表读面形状；ts ISO 8601）。 */
export interface CandidateRow {
  readonly id: string;
  readonly formalId: string | null;
  readonly kind: CandidateKind;
  readonly title: string;
  readonly body: string;
  readonly status: CandidateStatus;
  readonly sourceTaskId: string | null;
  readonly sourceIterationId: string | null;
  readonly deferAge: number;
  /** 目标节点（修改/废弃候选的定位；新增候选恒 NULL——列级演进后可空）。 */
  readonly targetNode: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly appliedNodeId: string | null;
}

/** candidates 台账四态计数（W2-E kg.health 体检看板数据源；缺态 = 0）。 */
export interface CandidateStatusCounts {
  readonly pending: number;
  readonly deferred: number;
  readonly applied: number;
  readonly discarded: number;
}

/** candidates 台账列表查询（读面三件套：status 过滤 + limit/offset 分页；缺省全量最新在前）。 */
export interface CandidateListQuery {
  readonly status?: CandidateStatus;
  readonly limit?: number;
  readonly offset?: number;
}

// ── 变更日志（supersede 链载体，AD-9 库内审计界面） ──────────

/** 写 op 种类（KnowledgeWriteOp 判别值；change_log.op 取值同源）。 */
export type KnowledgeWriteOpKind =
  | "createNode"
  | "updateNode"
  | "supersede"
  | "declareAnchors"
  | "addEdge"
  | "batchCreateNodes"
  | "proposeCandidate"
  | "decideCandidate"
  | "prune";

/**
 * 变更日志行：每 op 自动追加（迭代 id/op/nodeId/supersede_of/理由/时间）。
 * supersede_of 语义：本条变更挂入哪个节点的取代链——supersede op 记自身
 * （目标节点翻态进自身历史链）；supersede+replacement 的 replacement
 * createNode 行记被取代者（新节点挂旧节点链）。taskId（T2.1 AD-10）：
 * 任务产出元数据——op 携带则记账，不携带 = null（旧行为不变）。
 * iterationId 可空（P0 ④ 2026-08-31 裁决「保留可空」）：v1 状态目录回落
 * 移除后双锚缺失不再报错，行落 NULL（溯源主锚切 task_id）。
 */
export interface ChangeLogEntry {
  readonly seq: number;
  readonly iterationId: string | null;
  /** 任务来源（AD-10 唯一衔接面；非任务产出 = null；读面向前兼容可选）。 */
  readonly taskId?: string | null;
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
  /**
   * 适用场景（R23 沉淀必填）：自动发号 createNode/batchCreateNodes 必带
   * （KgWriteService 校验机械强制，缺 → KG_E_SCHEMA）；显式保号 id（迁移
   *   通道）与 supersede replacement 可缺省（存量回填归 kg-review）。
   */
  readonly scene?: string;
  readonly body?: string;
  readonly domain?: NodeDomain;
  readonly layer?: NodeLayer;
  /** 建库态只接受 draft/confirmed；superseded 只能经 supersede op 到达。 */
  readonly status?: Exclude<NodeStatus, "superseded">;
}

/**
 * 节点内容补丁（updateNode；status 不接受 superseded——归 supersede op）。
 * reason（T5.3 kg.node.confirm 消费）：可选审计叙述，落 change_log.reason
 * （如「草稿转正（页面人工确认）」）；缺省 null（既有行为不变）。
 * scene（D8 遗留①，R23）：元数据补全通道——kg-review 体检「scene 缺失 →
 * updateNode 直补」的载体列（携带则非空字符串；存量回填不是内容推翻）。 */
export interface NodePatch {
  readonly name?: string;
  readonly digest?: string;
  readonly body?: string;
  readonly scene?: string;
  readonly domain?: NodeDomain | null;
  readonly layer?: NodeLayer | null;
  readonly status?: Exclude<NodeStatus, "superseded">;
  readonly reason?: string;
}

/**
 * createNode 载荷（kind/iterationId 外的全部字段）：单条 op 的 draft/id 与
 * batchCreateNodes 逐项同形（O-5：批量与单条混用结果等价，CL-2-T14）。
 * anchors（P1 ②）：批量逐项可选携带锚声明（形态同单条 createNode 的组合
 * 第二拍，但同事务原子——锚非法整批拒绝零落库）；单条 op 不携带（单条
 * 走 declareAnchors 组合第二拍先例）。
 */
export interface CreateNodePayload {
  readonly draft: NodeDraft;
  /** 显式保号 id（仅迁移/保号场景；同单条 createNode 语义）。 */
  readonly id?: NodeId;
  /** 锚声明（可选；批量建点直接带锚，免「先建无锚→supersede→重建」噪音）。 */
  readonly anchors?: readonly AnchorDeclaration[];
}

/**
 * 写 op 公共字段：iterationId 可空（P0 ④：v1 迭代状态目录回落移除后，
 * 双锚缺失不再报错——写面永不被溯源章卡死；携带则必非空字符串，溯源
 * 主锚切 task_id）。taskId/originBatchId（T2.1，AD-10 任务→kg 唯一衔接
 * 面）：全部可选带缺省——携带时 createNode/batchCreateNodes 落
 * nodes.origin_batch_id + change_log.task_id；不携带则行为与既有逐字节
 * 一致（两列 NULL）。任务系统零「处置」概念：元数据仅登记，不进任何状态机。
 */
export interface KnowledgeWriteOpBase {
  readonly iterationId: string | null;
  /** 任务来源 id（helix.db job 表 id；任务产出落账时携带）。 */
  readonly taskId?: string;
  /** 产出批次 id（helix.db batch 表 id；批次产出落账时携带）。 */
  readonly originBatchId?: string;
}

/**
 * 知识层写 op 判别式联合（AD-9「schema 校验即防线」的校验对象）：
 * - createNode：日常自动发号；显式 id 仅保号迁移场景（T5.2），冲突在事务内查出；
 * - supersede：翻 status 不换号（supersede.ts 状态机），replacement 另发新号；
 * - batchCreateNodes（T2.1，O-5）：批量建点——先全量校验后单事务，任一节点
 *   失败整批回滚零部分落库；逐项与单条 createNode 同构（含显式 id 保号）。
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
    })
  | (KnowledgeWriteOpBase & {
      readonly kind: "batchCreateNodes";
      readonly nodes: readonly CreateNodePayload[];
    })
  | (KnowledgeWriteOpBase & {
      readonly kind: "proposeCandidate";
      readonly candidateKind: CandidateKind;
      readonly title: string;
      readonly body?: string;
      /** 目标节点（修改/废弃候选的定位；findings targetNode 结构化字段透传，TR-46）。 */
      readonly targetNode?: string;
      /** 来源任务（findings 闭环自动落账时机械注入，AD-10 三路径同源）。 */
      readonly sourceTaskId?: string;
      readonly sourceIterationId?: string;
      /** 显式保号 id（CAND-n；仅 md 台账一次性迁移场景，同 createNode 保号先例）。 */
      readonly id?: string;
    })
  | (KnowledgeWriteOpBase & {
      readonly kind: "decideCandidate";
      readonly candidateId: string;
      readonly decision: CandidateDecision;
      /** 人审理由（discarded 必带；落 decision_reason + change_log 审计）。 */
      readonly reason?: string;
      /** 正式编号（applied 时签发；终验人审前恒 NULL）。 */
      readonly formalId?: string;
      /** apply 后落到的节点 id（溯源）。 */
      readonly appliedNodeId?: string;
    })
  | (KnowledgeWriteOpBase & {
      /**
       * prune（2026-09-03 人审清台缺口补）：物理删除 materialized_anchors
       * orphan=1 tombstone 行（CL-2.A7 失效通道的保留行——符号消亡/声明撤销
       * 的 diff 产物，读面已全排除但永不物理消失）。nodeId 携带 = 只清该
       * 节点；缺省 = 清目标项目全部。审计：按受影响节点逐节点落 change_log
       * （零删除 = 幂等 ok 不落行）。声明层（anchor_decl）不归本 op——
       * declareAnchors 全集替换语义已覆盖。
       */
      readonly kind: "prune";
      readonly nodeId?: NodeId;
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

/** 写结果：nodeId = 受影响节点（create/supersede+replacement = 新发号；候选 op = CAND id）。 */
export type WriteResult =
  | {
      readonly ok: true;
      readonly nodeId: NodeId;
      /** 软告警（defer 上限等「只警告不拒绝」面——机械只列不修；缺省无告警）。 */
      readonly warning?: string;
      /** prune op 物理删除的 tombstone 行数（其余 op 缺省）。 */
      readonly prunedCount?: number;
    }
  | { readonly ok: false; readonly error: KgWriteError };

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

/** 锚声明扁平行（anchor_decl 表形状；KgSyncService 物化 join 输入，T2.2）。 */
export interface AnchorDeclRow {
  readonly nodeId: NodeId;
  readonly scopeKind: AnchorScopeKind;
  readonly pattern: string;
}

/**
 * sync 管道基准读面（KnowledgeGraphPort.getSyncBaseline 返回，T2.2 消费）：
 * 上一基准符号面+ 活跃物化锚 + 锚声明全集——
 * 增量跳过判定 / 符号消亡 diff / 物化全量重算的三项输入。
 */
export interface SyncBaselineView {
  readonly files: readonly SymbolFileRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly activeAnchors: readonly MaterializedAnchor[];
  readonly anchorDeclarations: readonly AnchorDeclRow[];
}

/**
 * sync 单事务批次（applySync 入参，T2.2 产生/消费）：符号层三表 + 物化锚 +
 * meta（导入基准戳——时序可判定关键，AD-15；degraded 显式状态，F5.5 上报）。
 * deletedFiles/orphanedAnchors 为增量 diff 通道（CL-2.A7：符号消亡 →
 * 物化锚 orphan 标记不物理删；可选字段缺省空，向后兼容）。
 */
export interface SymbolBatch {
  readonly files: readonly SymbolFileRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly containsEdges: readonly SymbolContainsEdge[];
  readonly materializedAnchors: readonly MaterializedAnchor[];
  /** 本窗口删除/改名文件（整文件符号行+contains 边+files 行清除）。 */
  readonly deletedFiles?: readonly string[];
  /** 失效锚（orphan 标记保留行；失效信号同步入 SyncResult 供 T5.1 入队）。 */
  readonly orphanedAnchors?: readonly MaterializedAnchor[];
  readonly baseline: string;
  readonly degraded: boolean;
}

// ── 引擎面（CodegraphEnginePort 数据面，T2.1/AF-2 裁决） ────

/**
 * 引擎符号行（codegraph nodes 投影；span 与符号同源同行）。id 形如
 * `<kind>:<hash>`（file 容器行 `file:<path>`）——contains 边 join 键；
 * 投影忠实携带全部行（含 file/import 伪行），消费侧过滤归 KgSyncService。
 */
export interface EngineSymbol {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly language: string | null;
  readonly signature: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

/**
 * 引擎 contains 边（edges WHERE kind='contains' 投影，AD-7 类级上溯依赖）：
 * containerId 为容器 id（`file:<path>` 或容器符号 id），symbolId 为成员符号 id。
 * calls/imports 等其余边类型不导（AF-2：导入范围刻意最小）。
 */
export interface EngineContainsEdge {
  readonly containerId: string;
  readonly symbolId: string;
}

/** 引擎文件面（files 表基准：sync 基准戳与陈旧判定数据源）。 */
export interface EngineFileRecord {
  readonly path: string;
  readonly contentHash: string;
  /** epoch ms（引擎侧 mtime 语义）。 */
  readonly modifiedAt: number;
  /** epoch ms（导入基准戳佐证）。 */
  readonly indexedAt: number;
}

/**
 * 引擎符号投影集（exportSymbols 产物）：空集 = 引擎侧空索引的合法状态，
 * 与 degraded（统一抛 EngineUnavailable，见下）显式区分——上层捕获后产出
 * degraded 标记的空 SymbolBatch（T2.2）。
 */
export interface SymbolSet {
  readonly symbols: readonly EngineSymbol[];
  readonly containsEdges: readonly EngineContainsEdge[];
  readonly files: readonly EngineFileRecord[];
}

/**
 * ensureIndex 成功结果：本次被动构建形态与新鲜度佐证。degraded 不走返回值
 * ——三入口（二进制不可达/schema 版本超限/子进程失败或超时）统一抛
 * EngineUnavailable（AF-2 裁决；上层标 degraded + docs-only 锚，CL-2.A2）。
 */
export interface IndexFreshness {
  readonly initialized: boolean;
  /** init=全量首建 / index=全量重建 / sync=增量。 */
  readonly mode: "init" | "index" | "sync";
  /** 构建 status 探测的引擎侧时间戳（ISO，可能滞后/为 null）。 */
  readonly lastIndexed: string | null;
}

/**
 * 引擎不可用统一降级信号（判别 tag，非异常类——类实现归 adapter，
 * application 层按 kind 鸭子判别，免 import adapters，TR-AD-1）。
 */
export interface EngineUnavailableInfo {
  readonly kind: "EngineUnavailable";
  readonly reason: string;
}

// ── 锚反查（R20：materialized_anchors 反查管辖节点；affected op 数据面） ──

/**
 * 锚反查命中行（reverseAnchorLookup 返回）：目标文件/符号 → 管辖节点摘要。
 * viaDecl=true 表示该命中来自 anchor_decl 声明反查（锚尚未物化——索引未建
 *   或符号面未同步；物化命中恒 false）。scene 存量未回填 = ''（渲染层兑底）。
 */
export interface AnchorReverseHit {
  readonly nodeId: NodeId;
  readonly kind: NodeKind;
  readonly name: string;
  readonly digest: string;
  readonly scene: string;
  readonly anchorKind: AnchorKind;
  readonly anchorPath: string;
  readonly anchorSymbol: string | null;
  readonly viaDecl: boolean;
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
  /** 节点适用场景（R23 渲染数据源）。 */
  readonly nodeScene: string;
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
  /** 适用场景（R23；存量未回填 = ''）。 */
  readonly scene: string;
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
  /** 适用场景（R23 索引面渲染数据源；存量未回填 = ''，渲染层兑底省略）。 */
  readonly scene: string;
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

// ── 验证期检查与报告数据面（T5.1，F3.2/F3.3） ───────────────

/**
 * 人类面节点引用（AD-16）：粗体 name+kind 徽章+digest 首行由前端渲染，
 * 数据层供全字段；id 仅供详情链接，不出现在任何人类可读叙述字段。
 */
export interface NodeRef {
  readonly id: NodeId;
  readonly name: string;
  readonly kind: NodeKind;
  readonly digestFirstLine: string;
}

/** 人类面代码符号引用（AD-16：符号名+路径(:行号)）。 */
export interface SymbolRef {
  readonly name: string;
  readonly path: string;
  readonly line?: number;
}

/** 节点 → 人类面引用投影（digest 首行截断；verify/报告面共用）。 */
export function toNodeRef(node: KnowledgeNode): NodeRef {
  const firstLine = node.digest.split("\n")[0] ?? node.digest;
  return { id: node.id, name: node.name, kind: node.kind, digestFirstLine: firstLine.trim() };
}

/**
 * 验证期检查读面（KnowledgeGraphPort.getVerifyView 返回，T5.1 消费）：
 * 全节点/全边（原始行）/全物化锚（含 orphan 标记）/锚声明全集/文件面
 * （mtime = churn 证据）——三检查与变化报告的共同数据源。
 */
export interface VerifyView {
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly RawEdgeRow[];
  readonly anchors: readonly MaterializedAnchor[];
  readonly anchorDeclarations: readonly AnchorDeclRow[];
  readonly files: readonly SymbolFileRecord[];
}
