/**
 * KgDedupService —— kg 写入口语义查重闸（批2 WP-C §5.1）。
 *
 * 触发点 = kg-update 的 createNode / batchCreateNodes（updateNode 不触发——
 * 改既有节点不该被拦；supersede/declareAnchors/prune 同样不触发）。流程：
 *
 * ```
 * 落库（不阻塞，先行——工具面已写完才调本服务）→ 异步嵌入新节点
 *  （复用批1 增量重嵌链 KgVectorService.embedNode）→ 与同库活跃节点全量余弦
 *  （新节点自身与同批后位节点除外——同批无序对只报一次，防批量刷屏；
 *   superseded 不入面，store 读面保证）
 *  ├─ ≥ warnThreshold（kg.similarityWarn 缺省 0.80）→ 软警告 + 自动
 *  │    addEdge(new, "similarTo", existing)（幂等，复合主键去重）
 *  └─ ≥ dupThreshold（kg.similarityDup 缺省 0.92）→ 以上 + 自动 proposeCandidate
 *       （疑似重复候选，body 带双方 digest 对照与建议合并方向——TR-56 三要素，
 *        TR-147 姿势 reason/evidence 内嵌 body；进候选台账人审）
 * ```
 *
 * **软闸纪律**：查重失败/端点缺失 → 降级 warn，绝不阻塞知识写入（可选件
 * 纪律——本服务在装配面即为可选件，缺席 = 零查重行为）；警告/连线/候选
 * 三件套全部是**附加动作**，任一失败只 warn 不回滚、不改写工具结果主文案。
 *
 * 相似度比对 = node_vectors 余弦（cosineSimilarity 纯函数）；比对面 =
 * NodeVectorStorePort.listActiveNodeVectors（活跃节点向量全量读面——批2
 * 开面）。缺向量节点不参与比对（回填修复后自然入面）。
 */
import type { KnowledgeWriteOp, NodeId, WriteResult } from "../../../domain/kg/types";
import { cosineSimilarity } from "../../../domain/kg/node-vector";
import type { NodeVectorStorePort } from "../../ports/outbound/NodeVectorStorePort";
import type { KgVectorService, KgVectorEmbedOutcome } from "./KgVectorService";
import type { KgSimilarityThresholds } from "./kgConfig";

/** 单条查重命中（工具面文案与测试消费的结构化产物）。 */
export interface KgDedupFinding {
  /** 新节点（查重发起方——疑似冗余标的）。 */
  readonly newNodeId: NodeId;
  readonly newNodeName: string;
  /** 相似既有节点（全量余弦命中）。 */
  readonly existingNodeId: NodeId;
  readonly existingNodeName: string;
  /** 余弦相似度。 */
  readonly similarity: number;
  /** 命中档位：warn = 软警告 + 连线；dup = 以上 + 自动疑似重复候选。 */
  readonly level: "warn" | "dup";
  /** similarTo 连线是否落成（自动 addEdge——失败降级 warn 仍在 findings 可见）。 */
  readonly edgeLinked: boolean;
  /** dup 档自动候选号（CAND-n；落账失败 = undefined）。 */
  readonly candidateId?: string;
}

/** 查重结局（工具面附加文案的结构化输入）。 */
export interface KgDedupCheckResult {
  /** 命中清单（工具面按 §5.1 文案渲染为软警告——每对恰一行）。 */
  readonly findings: readonly KgDedupFinding[];
  /** 降级/失败 warn 清单（软闸不阻塞的可观测面）。 */
  readonly warnings: readonly string[];
}

/** 查重上下文（自动 addEdge / proposeCandidate 的审计元数据——工具面透传）。 */
export interface KgDedupContext {
  readonly iterationId?: string | null;
  readonly taskId?: string;
  readonly originBatchId?: string;
}

export interface KgDedupServiceDeps {
  /** 批1 增量重嵌链（复用——嵌入新节点；hash 判据天然幂等）。 */
  readonly vectors: Pick<KgVectorService, "embedNode">;
  /** 查重邻居读面（活跃节点向量全量——superseded 不入面）。 */
  readonly store: Pick<NodeVectorStorePort, "listActiveNodeVectors">;
  /** 唯一写入口（自动 addEdge / proposeCandidate——绝不旁路直写，AD-9）。 */
  readonly write: { write(projectRoot: string, op: KnowledgeWriteOp): WriteResult };
  /** 查重阈值生效对（运行期即热——每次触发前实时读，KgConfigStore 单源）。 */
  readonly thresholds: () => KgSimilarityThresholds;
  readonly logger?: { warn(message: string): void };
}

export class KgDedupService {
  private readonly deps: KgDedupServiceDeps;

  constructor(deps: KgDedupServiceDeps) {
    this.deps = deps;
  }

  /**
   * 对给定新节点逐条查重（软闸：本方法不抛错——任何异常降级 warn 收口）。
   * nodeIds 顺序 = 建点顺序（同批无序对 {Xi, Xj} 只从后位节点视角报一次）。
   */
  async check(
    projectRoot: string,
    nodeIds: readonly NodeId[],
    ctx?: KgDedupContext,
  ): Promise<KgDedupCheckResult> {
    const findings: KgDedupFinding[] = [];
    const warnings: string[] = [];
    if (nodeIds.length === 0) return { findings, warnings };
    let thresholds: KgSimilarityThresholds;
    try {
      thresholds = this.deps.thresholds();
    } catch (err) {
      warnings.push(`查重降级：阈值读取失败（${(err as Error).message}）——本次跳过查重，落库不受影响`);
      return { findings, warnings };
    }
    const checked: NodeId[] = [];
    for (const nodeId of nodeIds) {
      const outcome = await this.embedQuietly(projectRoot, nodeId, warnings);
      if (outcome === "degraded") {
        warnings.push(`查重降级（${nodeId}）：未配置默认 embedding 端点——跳过查重（写入不受影响，配置端点后可回填修复）`);
        continue;
      }
      if (outcome === "failed") {
        warnings.push(`查重降级（${nodeId}）：嵌入失败——跳过查重（写入不受影响，缺失向量可回填修复）`);
        continue;
      }
      checked.push(nodeId);
    }
    if (checked.length === 0) return { findings, warnings };
    // 比对面一次取全（同批逐条查重复用同一快照——逐条重读无谓）
    let neighbors;
    try {
      neighbors = this.deps.store.listActiveNodeVectors(projectRoot);
    } catch (err) {
      warnings.push(`查重降级：向量读面失败（${(err as Error).message}）——本次跳过查重，落库不受影响`);
      return { findings, warnings };
    }
    const byId = new Map(neighbors.map((n) => [n.nodeId, n]));
    const position = new Map(nodeIds.map((id, i) => [id, i]));
    for (const nodeId of checked) {
      const self = byId.get(nodeId);
      if (self === undefined) {
        warnings.push(`查重降级（${nodeId}）：向量缺失——跳过比对（可回填修复）`);
        continue;
      }
      for (const neighbor of neighbors) {
        if (neighbor.nodeId === nodeId) continue;
        // 同批无序对只报一次：后位节点视角 vs 前位节点（前位检查时跳过后位）
        const neighborPos = position.get(neighbor.nodeId);
        const selfPos = position.get(nodeId);
        if (neighborPos !== undefined && selfPos !== undefined && neighborPos >= selfPos) continue;
        let similarity: number;
        try {
          similarity = cosineSimilarity(self.embedding, neighbor.embedding);
        } catch (err) {
          warnings.push(`查重降级（${nodeId} vs ${neighbor.nodeId}）：${(err as Error).message}——跳过该对`);
          continue;
        }
        if (similarity < thresholds.warn) continue;
        const level: "warn" | "dup" = similarity >= thresholds.dup ? "dup" : "warn";
        // 自动 similarTo 连线（幂等——复合主键 OR IGNORE；失败只 warn）
        const edgeResult = this.writeOp(projectRoot, {
          kind: "addEdge",
          iterationId: ctx?.iterationId ?? null,
          srcId: nodeId,
          verb: "similarTo",
          dstId: neighbor.nodeId,
          ...(ctx?.taskId !== undefined ? { taskId: ctx.taskId } : {}),
          ...(ctx?.originBatchId !== undefined ? { originBatchId: ctx.originBatchId } : {}),
        });
        if (!edgeResult.ok) {
          warnings.push(`similarTo 连线落账失败（${nodeId} → ${neighbor.nodeId}）：${edgeResult.error.code} ${edgeResult.error.message}`);
        }
        // dup 档：自动疑似重复候选（TR-56 三要素 + TR-147 姿势；失败只 warn）
        let candidateId: string | undefined;
        if (level === "dup") {
          const candResult = this.writeOp(projectRoot, {
            kind: "proposeCandidate",
            iterationId: ctx?.iterationId ?? null,
            candidateKind: "sediment",
            title: `疑似重复：${nodeId} ↔ ${neighbor.nodeId}（相似度 ${similarity.toFixed(2)}）`,
            body: buildDuplicateCandidateBody({
              newNodeId: nodeId,
              newNodeName: self.name,
              newDigest: self.digest,
              existingNodeId: neighbor.nodeId,
              existingNodeName: neighbor.name,
              existingDigest: neighbor.digest,
              similarity,
              thresholds,
            }),
            targetNode: nodeId,
            ...(ctx?.taskId !== undefined ? { sourceTaskId: ctx.taskId } : {}),
            ...(ctx?.iterationId != null ? { sourceIterationId: ctx.iterationId } : {}),
            ...(ctx?.taskId !== undefined ? { taskId: ctx.taskId } : {}),
            ...(ctx?.originBatchId !== undefined ? { originBatchId: ctx.originBatchId } : {}),
          });
          if (candResult.ok) {
            candidateId = candResult.nodeId;
          } else {
            warnings.push(`疑似重复候选落账失败（${nodeId} vs ${neighbor.nodeId}）：${candResult.error.code} ${candResult.error.message}`);
          }
        }
        findings.push({
          newNodeId: nodeId,
          newNodeName: self.name,
          existingNodeId: neighbor.nodeId,
          existingNodeName: neighbor.name,
          similarity,
          level,
          edgeLinked: edgeResult.ok,
          ...(candidateId !== undefined ? { candidateId } : {}),
        });
      }
    }
    return { findings, warnings };
  }

  // ── 内部 ──────────────────────────────────────────────────

  /** 嵌入新节点（复用批1 链）；异常吞为 outcome（软闸——绝不抛）。 */
  private async embedQuietly(
    projectRoot: string,
    nodeId: NodeId,
    warnings: string[],
  ): Promise<KgVectorEmbedOutcome> {
    try {
      return await this.deps.vectors.embedNode(projectRoot, nodeId, {
        warn: (message) => {
          warnings.push(message);
          this.deps.logger?.warn(message);
        },
      });
    } catch (err) {
      this.deps.logger?.warn(`kg 查重嵌入异常（${nodeId}）：${(err as Error).message}`);
      return "failed";
    }
  }

  /** 自动落账（唯一写入口）；异常归一结构化失败（软闸不抛）。 */
  private writeOp(projectRoot: string, op: KnowledgeWriteOp): WriteResult {
    try {
      return this.deps.write.write(projectRoot, op);
    } catch (err) {
      return {
        ok: false,
        error: { code: "KG_E_INTERNAL", message: `查重附加动作异常（已吞——写入不阻塞）：${(err as Error).message}` },
      };
    }
  }
}

/**
 * 疑似重复候选 body（TR-56 裁决叙事三要素 + 双方 digest 对照 + 建议合并
 * 方向；TR-147 姿势——reason/evidence 内嵌 body，非空机械强制 TR-33）。
 */
export function buildDuplicateCandidateBody(args: {
  readonly newNodeId: NodeId;
  readonly newNodeName: string;
  readonly newDigest: string;
  readonly existingNodeId: NodeId;
  readonly existingNodeName: string;
  readonly existingDigest: string;
  readonly similarity: number;
  readonly thresholds: KgSimilarityThresholds;
}): string {
  const sim = args.similarity.toFixed(2);
  return [
    `事实描述：新节点 ${args.newNodeId}《${args.newNodeName}》与既有节点 ${args.existingNodeId}《${args.existingNodeName}》语义相似度 ${sim}，已达疑似重复阈值 ${args.thresholds.dup}（kg.similarityDup）——写入口查重闸机械检出。`,
    `- 新节点 digest：${args.newDigest}`,
    `- 既有节点 digest：${args.existingDigest}`,
    `决策的点：两节点是否为同一知识点的重复沉淀——合并（保留一方为幸存者、另一方 supersede 吸收）还是保留双节点。`,
    `决策后的效果：applied = 合并消歧（幸存者吸收要点后被合并方 supersede，全历史保留、边可迁移）；discarded = 保留双节点（检索/注入面继续双份，需各自 scene 消歧）。`,
    `建议与理由：建议合并方向 = 以内容更完整者为幸存者（多数情形为既有节点——历史与边更丰富），新节点独有要点并入后 supersede 新节点；若确为不同侧面，discard 本候选并补 scene 消歧。`,
    `证据：node_vectors 余弦相似度 ${sim}（向量化 doc = name+scene+digest+body 截断）；查重阈值 warn=${args.thresholds.warn}/dup=${args.thresholds.dup}。`,
  ].join("\n");
}
