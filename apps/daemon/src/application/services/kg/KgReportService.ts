/**
 * KgReportService —— F3.3 变化报告数据面（T5.1，AD-5/AD-16）。
 *
 * 按迭代聚合四类条目（CL-3.A10；与 contracts/kg-viewer-api.md 的
 * ChangeReport 契约对齐，T5.3 kg.change.report 的直接数据源）：
 * - rule_conflict（warn）：KgVerifyService.findConflicts；
 * - dead_anchor（warn）：findOrphans 的腐烂锚口径（orphan_node 归验证
 *   清单，不进报告四类模板）；
 * - suspect_stale（info）：findActivityMismatch（疑似限定词强制）；
 * - knowledge_change（ok）：change_log 按迭代过滤（T4.1 落账含迭代 id）。
 *
 * 人类可读原则（AD-5 两面性的人类面，CL-3.A8）在数据层强制：
 * ①事件导向：body 主语=本迭代，完整因果叙述句（代码事实→知识影响→
 *   检查判定）；②因果链完整：叙述句含因果连接。报告=通知面非审核面
 *   （条目全部来自代码事实的机械检查/变更流水，无人审核逻辑）——
 *   条目不携带 options 行动项。
 *
 * AD-16 引用规范在数据层强制：refs.nodes={id,name,kind,digestFirstLine}
 * /refs.symbols={name,path,line?}；label/body 等人类可读字段不
 * 出现 TR-n/E-n 裸形态（id 仅供链接）。
 *
 * O-7：查询时现算（每次 buildChangeReport 重跑检查与聚合），不预生成
 * 不缓存；零写路径（AD-6）。
 */

import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { KgVerifyService } from "./KgVerifyService";
import type { ChangeLogEntry, KnowledgeNode, NodeRef, SymbolRef } from "../../../domain/kg/types";
import { toNodeRef } from "../../../domain/kg/types";

/** 四类条目（契约判别值，封闭集）。 */
export type ReportEntryKind = "dead_anchor" | "rule_conflict" | "suspect_stale" | "knowledge_change";

/** 严重级：warn→⚠ / info→? / ok→✓（前端 glyph 映射，契约口径）。 */
export type ReportSev = "warn" | "info" | "ok";

/** 报告条目（契约形状：kind/sev/label/body/refs；通知面无行动项）。 */
export interface ReportEntry {
  readonly kind: ReportEntryKind;
  readonly sev: ReportSev;
  readonly label: string;
  readonly body: string;
  readonly refs: { readonly nodes: readonly NodeRef[]; readonly symbols: readonly SymbolRef[] };
}

/** 变化报告（按迭代聚合；供 T5.3 kg.change.report 直传）。 */
export interface ChangeReport {
  readonly iterationId: string;
  readonly entries: readonly ReportEntry[];
}

export interface KgReportServiceDeps {
  readonly graph: KnowledgeGraphPort;
  readonly verify: KgVerifyService;
}

function kindLabel(kind: NodeRef["kind"]): string {
  return kind === "rule" ? "规则" : "实体";
}

/** 锚 → 人类面代码符号引用：符号锚=path#symbol；文件锚=文件名+路径。 */
function symbolRefOf(anchorPath: string, anchorSymbol: string | null): SymbolRef {
  if (anchorSymbol === null || anchorSymbol === "") {
    const segments = anchorPath.split("/");
    return { name: segments[segments.length - 1] ?? anchorPath, path: anchorPath };
  }
  return { name: anchorSymbol, path: anchorPath };
}

export class KgReportService {
  private readonly deps: KgReportServiceDeps;

  constructor(deps: KgReportServiceDeps) {
    this.deps = deps;
  }

  /** 按迭代聚合变化报告（O-7 现算；确定性序：冲突→失效锚→疑似→知识变化）。 */
  buildChangeReport(projectRoot: string, iterationId: string): ChangeReport {
    const conflicts = this.deps.verify.findConflicts(projectRoot);
    const orphans = this.deps.verify.findOrphans(projectRoot);
    const suspects = this.deps.verify.findActivityMismatch(projectRoot);
    const log = this.deps.graph.getChangeLog(projectRoot, iterationId);

    const entries: ReportEntry[] = [];
    for (const conflict of conflicts) {
      entries.push({
        kind: "rule_conflict",
        sev: "warn",
        label: "规则冲突",
        body: `本迭代机械检查发现：${conflict.summary}`,
        refs: { nodes: conflict.nodes, symbols: [] },
      });
    }
    for (const orphan of orphans) {
      if (orphan.kind !== "dead_anchor") continue; // orphan_node 归验证清单
      entries.push({
        kind: "dead_anchor",
        sev: "warn",
        label: "失效锚点",
        body: `本迭代机械检查发现：${orphan.summary}`,
        refs: {
          nodes: [orphan.node],
          symbols: [symbolRefOf(orphan.anchor.anchorPath, orphan.anchor.anchorSymbol)],
        },
      });
    }
    for (const suspect of suspects) {
      entries.push({
        kind: "suspect_stale",
        sev: "info",
        label: "疑似过时",
        body: suspect.summary, // 已含「本迭代」主语与「疑似过时/非结论」限定词
        refs: {
          nodes: [suspect.node],
          symbols: [symbolRefOf(suspect.anchor.anchorPath, suspect.anchor.anchorSymbol)],
        },
      });
    }
    const nodesById = new Map(
      this.deps.graph.getVerifyView(projectRoot).nodes.map((n: KnowledgeNode) => [n.id, toNodeRef(n)] as const),
    );
    for (const entry of log) {
      const body = this.knowledgeChangeBody(entry, nodesById);
      if (body === null) continue; // 节点缺失（防御，正常不可达）
      const refs: NodeRef[] = [];
      const primary = nodesById.get(entry.nodeId);
      if (primary !== undefined) refs.push(primary);
      const chainPeer = entry.supersedeOf === null ? undefined : nodesById.get(entry.supersedeOf);
      if (chainPeer !== undefined && chainPeer.id !== primary?.id) refs.push(chainPeer);
      entries.push({
        kind: "knowledge_change",
        sev: "ok",
        label: "知识变化",
        body,
        refs: { nodes: refs, symbols: [] },
      });
    }

    return { iterationId, entries };
  }

  /** change_log 行 → 事件导向因果叙述句（主语=本迭代；节点缺失返回 null）。 */
  private knowledgeChangeBody(
    entry: ChangeLogEntry,
    nodesById: ReadonlyMap<string, NodeRef>,
  ): string | null {
    const node = nodesById.get(entry.nodeId);
    if (node === undefined) return null;
    const label = kindLabel(node.kind);
    switch (entry.op) {
      case "createNode": {
        const reason = entry.reason?.trim();
        if (entry.supersedeOf !== null) {
          const old = nodesById.get(entry.supersedeOf);
          const by = reason === undefined || reason === "" ? "" : `以「${reason}」为由`;
          return `本迭代${by}新增了${label}「${node.name}」（${node.digestFirstLine}）${old === undefined ? "" : `接替${kindLabel(old.kind)}「${old.name}」`}——过时知识完成事后修正（AD-5）。`;
        }
        return `本迭代新增了${label}「${node.name}」（${node.digestFirstLine}）——代码侧改动沉淀为一条新知识。`;
      }
      case "updateNode":
        return `本迭代更新了${label}「${node.name}」（${node.digestFirstLine}）——既有知识随事实演进完成修订。`;
      case "supersede": {
        const reason = entry.reason ?? "";
        return `本迭代以「${reason}」为由推翻了${label}「${node.name}」——旧知识进入取代链，不再约束后续实现。`;
      }
      case "declareAnchors":
        return `本迭代为${label}「${node.name}」声明了锚点作用域——知识锚定到具体代码位置，可随符号同步自动维护。`;
      case "addEdge":
        // change_log 行不携带 verb/对手方（仅记 srcId）——叙述不含臆造细节，对手方见节点详情
        return `本迭代为${label}「${node.name}」添加了一条知识边（约束/依赖关系）——关系结构更新，对手方见节点详情。`;
      default:
        return null;
    }
  }
}
