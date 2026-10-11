/**
 * KgVectorService —— kg 节点向量编排面（批1 WP-B）。
 *
 * 职责（设计稿 §4.3/§4.4）：
 * - 写入口挂钩（KgWriteService 单点消费面）：createNode / batchCreateNodes /
 *   updateNode 成功后**异步嵌入 upsert** node_vectors（fire-and-forget——
 *   失败 WARN 不阻塞知识写入，写入可靠性优先于向量完整性，缺失向量可回填
 *   修复）；supersede → 被推翻节点向量**删除**（不参与后续相似度比对，防
 *   相似度噪声源），replacement 新节点走 createNode 路径正常嵌入；
 * - 增量重嵌判据（§4.2 公式单源 node-vector.ts）：content_hash（doc 变才
 *   嵌）∧ model（换版全量重嵌，E-215 先例——dim/model 记行上）；
 * - 缺失向量修复路径：syncAll（kg.index.status rebuild 顺带重算 / 回填脚本
 *   共用同一实现；hash 判据跳过未变节点，天然幂等）。
 *
 * 嵌入调用一律经 EmbeddingPort + resolveDefault()（复用记忆面同款 OpenAI
 * 兼容端点基建）；默认端点缺失/失效 = 向量面不可用 → 降级 warn（可选件
 * 纪律——绝不抛错挡知识写入）。
 */
import type { EmbeddingEndpointConfig, EmbeddingPort } from "../../ports/outbound/EmbeddingPort";
import type { NodeVectorStorePort } from "../../ports/outbound/NodeVectorStorePort";
import type { KnowledgeWriteOp, WriteResult } from "../../../domain/kg/types";
import { buildNodeVectorDoc } from "../../../domain/kg/node-vector";

/** 单节点嵌入结局（embedNode 读面）。 */
export type KgVectorEmbedOutcome = "embedded" | "skipped" | "degraded" | "failed";

/** syncAll / 回填报告（计数 + warn 留档清单）。 */
export interface KgVectorSyncReport {
  /** 实际嵌入并落行数（dryRun = 预估可嵌数——判定照跑零落库）。 */
  readonly embedded: number;
  /** hash/model 未变跳过数。 */
  readonly skipped: number;
  /** 嵌入失败数（逐条 warn 留档，下次重跑修复）。 */
  readonly failed: number;
  /** 端点缺失降级数（向量面不可用——配置后重跑补）。 */
  readonly degraded: number;
  /** warn 留档清单（含节点定位）。 */
  readonly warnings: readonly string[];
}

export interface KgVectorServiceDeps {
  readonly store: NodeVectorStorePort;
  readonly embedding: EmbeddingPort;
  /** 默认端点解析（resolveDefault 单点窄投影——model 换版判据 + 可用性）。 */
  readonly resolveEndpoint: () => EmbeddingEndpointConfig | null;
  /** content_hash 计算（sha256(doc) hex；实现注入——application 层禁
   *  node:crypto（AG-02②），组合根注入 node-vector-codec.nodeVectorContentHash）。 */
  readonly contentHash: (doc: string) => string;
  readonly logger?: { warn(message: string): void };
  readonly clock?: () => number;
}

export class KgVectorService {
  private readonly deps: KgVectorServiceDeps;
  private readonly now: () => number;
  /** fire-and-forget 在途集（drain 测试/收尾落定用）。 */
  private readonly pending = new Set<Promise<void>>();

  constructor(deps: KgVectorServiceDeps) {
    this.deps = deps;
    this.now = deps.clock ?? Date.now;
  }

  /** 默认端点在场判据（回填前置检查消费面——可选件纪律）。 */
  endpointAvailable(): boolean {
    return this.deps.resolveEndpoint() !== null;
  }

  /**
   * 写入口挂钩（KgWriteService 唯一写入口消费面）：成功写 op → 向量联动
   * （fire-and-forget；失败 WARN 不阻塞写）。
   */
  onWriteSuccess(projectRoot: string, op: KnowledgeWriteOp, result: Extract<WriteResult, { ok: true }>): void {
    switch (op.kind) {
      case "createNode":
      case "updateNode":
        if (result.nodeId !== undefined) this.track(this.embedNode(projectRoot, result.nodeId));
        return;
      case "batchCreateNodes": {
        const ids = result.nodeIds ?? (result.nodeId !== undefined ? [result.nodeId] : []);
        for (const id of ids) this.track(this.embedNode(projectRoot, id));
        return;
      }
      case "supersede":
        // 被推翻节点向量删除；replacement 新节点走 createNode 路径正常嵌入
        this.deleteVector(projectRoot, op.nodeId);
        if (op.replacementNodeDraft !== undefined && result.nodeId !== undefined) {
          this.track(this.embedNode(projectRoot, result.nodeId));
        }
        return;
      default:
        return; // 非节点写 op 零动作
    }
  }

  /** 删向量（supersede 消费面；幂等——缺失零动作）。 */
  deleteVector(projectRoot: string, nodeId: string): void {
    try {
      this.deps.store.deleteNodeVector(projectRoot, nodeId);
    } catch (err) {
      this.warn(`kg 向量删除失败（${nodeId}）：${(err as Error).message}`);
    }
  }

  /**
   * 单节点增量重嵌（hash/model 判据单点）：非活跃/不存在 → skipped 零动作；
   * 默认端点缺失 → degraded warn；hash 未变 ∧ model 未变 → skipped 零调用；
   * 嵌入失败 → failed warn（不抛错）。dryRun = 判定照跑零落库（回填预演）；
   * warn 钩子（可选）＝ 报告收集面（syncAll 用——logger 与报告双出口）。
   */
  async embedNode(
    projectRoot: string,
    nodeId: string,
    opts?: { readonly dryRun?: boolean; readonly warn?: (message: string) => void },
  ): Promise<KgVectorEmbedOutcome> {
    const target = this.deps.store.getNodeEmbedTarget(projectRoot, nodeId);
    if (target === null) return "skipped";
    const endpoint = this.deps.resolveEndpoint();
    if (endpoint === null) {
      this.emit(opts, `kg 向量嵌入降级（${nodeId}）：未配置默认 embedding 端点——跳过（配置后可回填修复）`);
      return "degraded";
    }
    const doc = buildNodeVectorDoc(target);
    const hash = this.deps.contentHash(doc);
    const meta = target.vector;
    if (meta !== null && meta.contentHash === hash && meta.model === endpoint.model) return "skipped";
    try {
      const { vectors, dim } = await this.deps.embedding.embed([doc]);
      const vector = vectors[0];
      if (vector === undefined) throw new Error("嵌入响应缺向量");
      if (opts?.dryRun !== true) {
        this.deps.store.upsertNodeVector(projectRoot, {
          nodeId,
          contentHash: hash,
          model: endpoint.model,
          dim,
          embeddedAt: this.now(),
          embedding: vector,
        });
      }
      return "embedded";
    } catch (err) {
      this.emit(opts, `kg 向量嵌入失败（${nodeId}）：${(err as Error).message}——留缺失向量待回填修复`);
      return "failed";
    }
  }

  /**
   * 全量同步（缺失向量修复 + 存量回填共用路径）：活跃节点逐个走 embedNode
   * 判据（hash 未变跳过——天然幂等）；逐条失败 warn 留档不影响其余节点。
   */
  async syncAll(projectRoot: string, opts?: { readonly dryRun?: boolean }): Promise<KgVectorSyncReport> {
    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    let degraded = 0;
    const warnings: string[] = [];
    for (const target of this.deps.store.listEmbedTargets(projectRoot)) {
      const outcome = await this.embedNode(projectRoot, target.nodeId, {
        ...(opts?.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
        warn: (message) => warnings.push(message),
      });
      if (outcome === "embedded") embedded += 1;
      else if (outcome === "skipped") skipped += 1;
      else if (outcome === "failed") failed += 1;
      else degraded += 1;
    }
    return { embedded, skipped, failed, degraded, warnings };
  }

  /** drain：等 fire-and-forget 在途全部落定（测试/收尾判据）。 */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // ── 内部 ──────────────────────────────────────────────────

  /** 告警双出口：logger（daemon 日志）+ 可选 warn 钩子（报告收集面）。 */
  private emit(opts: { readonly warn?: (message: string) => void } | undefined, message: string): void {
    this.deps.logger?.warn(message);
    opts?.warn?.(message);
  }

  private track(promise: Promise<KgVectorEmbedOutcome>): void {
    const settled = promise
      .then(() => undefined)
      .catch((err: unknown) => {
        this.warn(`kg 向量联动异常（已吞——写入不阻塞）：${(err as Error).message}`);
      });
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }

  private warn(message: string): void {
    this.deps.logger?.warn(message);
  }
}
