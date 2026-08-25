/**
 * KgVerifyService —— 验证期三检查编排（T5.1，F3.2，AD-6/AD-14）。
 *
 * 读图谱状态（KnowledgeGraphPort.getVerifyView）→ 调 domain/kg/verify
 * 纯逻辑 → 输出清单。**零写路径**（只列不修，处置权在人）：本服务不
 * 持有任何写 port，执行前后库内容逐字节不变（CL-3.A6 机械判据）。
 *
 * 三检查（漏网三层兑底 AD-14 的前两层）：
 * - findConflicts：逻辑冲突（双向 governs 矛盾/自环/词表外 verb）——确定性；
 * - findOrphans：腐烂锚（T2.2 orphan 标记）+ 无锚无边孤儿节点——确定性；
 * - findActivityMismatch：代码高频变更 × 锚长期未动 → 疑似过时排序——
 *   启发式非结论（输出必含「疑似」限定，CL-3.A7），人审报告终裁。
 *
 * 触发面 O-5：本服务只暴露方法，不自动运行（页面/流程钩子接线归 T5.3+）。
 */

import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import { findEdgeConflicts, type ConflictItem } from "../../../domain/kg/verify/conflicts";
import { findOrphanItems, type OrphanItem } from "../../../domain/kg/verify/orphans";
import {
  sortActivityMismatch,
  type ActivitySignal,
  type SuspectItem,
} from "../../../domain/kg/verify/activity-mismatch";
import type { KnowledgeNode } from "../../../domain/kg/types";

export type { ConflictItem, OrphanItem, SuspectItem };

export interface KgVerifyServiceDeps {
  readonly graph: KnowledgeGraphPort;
}

export class KgVerifyService {
  private readonly deps: KgVerifyServiceDeps;

  constructor(deps: KgVerifyServiceDeps) {
    this.deps = deps;
  }

  /** 逻辑冲突清单：双向 governs 矛盾 / 自环边 / 词表外 verb（机械确定性）。 */
  findConflicts(projectRoot: string): readonly ConflictItem[] {
    const view = this.deps.graph.getVerifyView(projectRoot);
    return findEdgeConflicts({
      edges: view.edges,
      nodesById: new Map(view.nodes.map((n) => [n.id, n])),
    });
  }

  /** 腐烂锚（orphan 标记）+ 无锚无边孤儿节点清单（机械确定性）。 */
  findOrphans(projectRoot: string): readonly OrphanItem[] {
    const view = this.deps.graph.getVerifyView(projectRoot);
    return findOrphanItems({
      nodes: view.nodes,
      edges: view.edges,
      anchors: view.anchors,
      anchorDeclarations: view.anchorDeclarations,
      now: Date.now(),
    });
  }

  /**
   * 活跃度错位启发：活跃锚（orphan≠1，superseded 节点除外——历史节点
   * 无需新鲜度）× 锚定文件 mtime → 疑似过时排序（含强制限定词）。
   */
  findActivityMismatch(projectRoot: string): readonly SuspectItem[] {
    const view = this.deps.graph.getVerifyView(projectRoot);
    const nodesById = new Map(view.nodes.map((n) => [n.id, n]));
    const mtimeByPath = new Map(view.files.map((f) => [f.path, f.mtime] as const));
    const signals: ActivitySignal[] = [];
    for (const anchor of view.anchors) {
      if (anchor.orphan === true) continue; // 失效锚归 findOrphans 口径
      const node: KnowledgeNode | undefined = nodesById.get(anchor.nodeId);
      if (node === undefined || node.status === "superseded") continue;
      signals.push({ node, anchor, fileMtime: mtimeByPath.get(anchor.anchorPath) ?? null });
    }
    return sortActivityMismatch(signals);
  }
}
