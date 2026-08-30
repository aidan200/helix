/**
 * KgViewerService —— P-1 数据面六命令应用编排（§9，CL-5 F5.0~F5.5，T5.3）。
 *
 * ws-server handlers/kg.ts 的唯一 service 面（driving 只转发不决策）：
 * kg.projects / kg.list / kg.node.detail / kg.change.report /
 * kg.node.confirm / kg.index.status 六操作在此编排（per-project：project
 * 参数经 KgProjectService 单点解析后作 projectRoot 作用域，跨项目不串）。
 *
 * 错误模型（契约 kg-viewer-api）：结构化错误码 + 字段路径，driving 层
 * 映射 connection.error 回执——
 * - KG_E_PARAM：project 无法解析 / 过滤值非法；
 * - KG_E_NOT_FOUND：节点不存在（含 absent 项目上的详情/转正）；
 * - KG_E_STATE：confirm 非 draft 节点；
 * - KG_E_REBUILD_FAILED：rebuild 触发失败（面板保持 degraded 可重试）。
 *
 * 写路径边界（CL-5.A4/A5）：confirm 是唯一写命令（经 KgWriteService =
 * F2.3 API 唯一写入口，非旁路直写）；indexStatus rebuild 只调
 * KgSyncService.triggerManual（纯 codegraph 构建+sync，无知识层写；absent
 * 态触发即首次构建 B1——同一入口无分支）。其余四命令零写路径；absent
 * 项目上的读命令短路空结果（读面绝不新建库文件）。
 */

import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { ChangeReport } from "./KgReportService";
import type { KgReportService } from "./KgReportService";
import { KG_DEGRADED_NOTE, type KgProjectRowView, type KgProjectService } from "./KgProjectService";
import type { KgSyncService, KgIndexPhase } from "./KgSyncService";
import type { KgVerifyService } from "./KgVerifyService";
import type { KgWriteService } from "./KgWriteService";
import type {
  KnowledgeNode,
  NodeDigestRow,
  NodeDetail,
  SupersedeChainLink,
} from "../../../domain/kg/types";

// ── 结果形状（应用层视图；协议 DTO 由 driving 层逐字段映射） ──

/** kg.list 结果行（NodeDigestRow 直用：契约 NodeListRow 同形）。 */
export type KgListRow = NodeDigestRow;

export interface KgListView {
  readonly total: number;
  readonly matched: number;
  readonly rows: readonly KgListRow[];
}

/** 锚点行（契约 AnchorRow 应用层形状）。 */
export interface KgAnchorView {
  readonly symbol?: string;
  readonly path: string;
  readonly line?: number;
  readonly state: "ok" | "dead" | "stale";
}

/** 关系行（对方节点 digest 引用——前端渲染 name+徽章+digest 首行）。 */
export interface KgRelationView {
  readonly verb: string;
  readonly peer: NodeDigestRow;
}

/** 变更日志行（契约 LogRow；eventText 无裸 id，AD-16）。 */
export interface KgLogView {
  readonly date: string;
  readonly iterationId: string;
  readonly eventText: string;
}

/** kg.node.detail 结果（聚合视图；body=节点正文原文单段直返，不拆分）。 */
export interface KgNodeDetailView {
  readonly node: KnowledgeNode;
  readonly body: string;
  readonly anchors: readonly KgAnchorView[];
  readonly relations: readonly KgRelationView[];
  readonly supersede: { readonly history: readonly NodeDigestRow[]; readonly current: NodeDigestRow };
  readonly log: readonly KgLogView[];
}

/** kg.index.status 结果（四态面板视图）。 */
export interface KgIndexStatusView {
  readonly state: KgIndexPhase;
  readonly syncedAt?: string;
  readonly symbolCount?: number;
  readonly degradedNote?: string;
}

/** kg.node.confirm 结果（翻转后状态回读）。 */
export interface KgConfirmView {
  readonly applied: true;
  readonly row: KgListRow;
}

/** 结构化错误（契约错误模型：错误码+字段路径）。 */
export type KgViewerErrorCode = "KG_E_PARAM" | "KG_E_NOT_FOUND" | "KG_E_STATE" | "KG_E_REBUILD_FAILED";

export interface KgViewerError {
  readonly code: KgViewerErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type KgViewerResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: KgViewerError };

/** confirm 的 change_log 审计叙述（契约 F5.4 钉死文案）。 */
export const CONFIRM_LOG_TEXT = "草稿转正（页面人工确认）";

export interface KgViewerServiceDeps {
  readonly project: KgProjectService;
  readonly graph: KnowledgeGraphPort;
  readonly verify: KgVerifyService;
  readonly report: KgReportService;
  readonly write: KgWriteService;
  readonly sync: Pick<KgSyncService, "getStatus" | "triggerManual" | "isBuilding">;
}

/** change_log op → 事件叙述（确定性中文标签 + reason；无裸 id，AD-16）。 */
export function logEventText(op: string, reason: string | null): string {
  switch (op) {
    case "createNode":
      return "创建节点（新知识入库）";
    case "updateNode":
      return reason === null || reason === "" ? "更新节点内容" : `更新节点内容：${reason}`;
    case "supersede":
      return reason === null || reason === "" ? "推翻（进入取代链）" : `推翻：${reason}`;
    case "declareAnchors":
      return "声明锚点作用域";
    case "addEdge":
      return "添加知识边（约束/依赖关系）";
    default:
      return op;
  }
}

export class KgViewerService {
  private readonly deps: KgViewerServiceDeps;

  constructor(deps: KgViewerServiceDeps) {
    this.deps = deps;
  }

  // ── F5.0 kg.projects（只读；absent 短路在 projectService 内） ──

  projects(): readonly KgProjectRowView[] {
    return this.deps.project.listProjects();
  }

  // ── F5.1 kg.list（三路过滤叠加 + total/matched） ──

  list(project: string, filter: { q?: string; kind?: string; status?: string }): KgViewerResult<KgListView> {
    const kindError = this.enumError(filter.kind, ["rule", "entity"], "payload.kind");
    if (kindError !== null) return { ok: false, error: kindError };
    const statusError = this.enumError(filter.status, ["draft", "confirmed", "superseded"], "payload.status");
    if (statusError !== null) return { ok: false, error: statusError };
    const resolved = this.resolveIndexed(project);
    if (!resolved.ok) return resolved;

    // total = 项目内全部节点数（过滤前；COUNT 查询）；matched = q×kind×status 叠加后
    const total = this.deps.graph.countNodes(resolved.value);
    const matched = this.deps.graph.search(resolved.value, filter.q ?? "").filter(
      (row) =>
        (filter.kind === undefined || row.kind === filter.kind) &&
        (filter.status === undefined || row.status === filter.status),
    );
    return { ok: true, value: { total, matched: matched.length, rows: matched } };
  }

  // ── F5.2 kg.node.detail（六段聚合） ──

  nodeDetail(project: string, id: string): KgViewerResult<KgNodeDetailView> {
    const resolved = this.resolveIndexed(project);
    if (!resolved.ok) return resolved;
    const detail = this.deps.graph.getNode(resolved.value, id);
    if (detail === null) {
      return { ok: false, error: { code: "KG_E_NOT_FOUND", message: `节点 ${id} 不存在`, path: "payload.id" } };
    }
    return { ok: true, value: this.assembleDetail(resolved.value, detail) };
  }

  // ── F5.3 kg.change.report（KgReportService 直传；缺省=当前迭代） ──

  changeReport(project: string, iterationId?: string): KgViewerResult<ChangeReport> {
    const resolved = this.resolveIndexed(project);
    if (!resolved.ok) return resolved;
    const iteration = iterationId !== undefined && iterationId.trim() !== ""
      ? iterationId
      : (this.deps.graph.latestIteration(resolved.value) ?? "");
    return { ok: true, value: this.deps.report.buildChangeReport(resolved.value, iteration) };
  }

  // ── F5.4 kg.node.confirm（唯一写命令；仅 draft 可转正） ──

  confirm(project: string, id: string): KgViewerResult<KgConfirmView> {
    const resolved = this.resolveIndexed(project);
    if (!resolved.ok) return resolved;
    const detail = this.deps.graph.getNode(resolved.value, id);
    if (detail === null) {
      return { ok: false, error: { code: "KG_E_NOT_FOUND", message: `节点 ${id} 不存在`, path: "payload.id" } };
    }
    if (detail.node.status !== "draft") {
      return {
        ok: false,
        error: {
          code: "KG_E_STATE",
          message: `节点当前状态为 ${detail.node.status}，仅 draft 可转正`,
          path: "payload.id",
        },
      };
    }
    const iterationId = this.deps.graph.latestIteration(resolved.value);
    if (iterationId === null) {
      return {
        ok: false,
        error: { code: "KG_E_STATE", message: "库内无迭代锚（change_log 空），无法归属审计行" },
      };
    }
    const write = this.deps.write.write(resolved.value, {
      kind: "updateNode",
      iterationId,
      nodeId: id,
      patch: { status: "confirmed", reason: CONFIRM_LOG_TEXT },
    });
    if (!write.ok) {
      return {
        ok: false,
        error: { code: write.error.code === "KG_E_ID" ? "KG_E_NOT_FOUND" : "KG_E_STATE", message: write.error.message, path: "payload.id" },
      };
    }
    const after = this.deps.graph.getNode(resolved.value, id);
    if (after === null) {
      return { ok: false, error: { code: "KG_E_NOT_FOUND", message: `节点 ${id} 转正后回读失败`, path: "payload.id" } };
    }
    const { node } = after;
    return {
      ok: true,
      value: {
        applied: true,
        row: {
          id: node.id,
          kind: node.kind,
          name: node.name,
          digest: node.digest,
          status: node.status,
          domain: node.domain,
        },
      },
    };
  }

  // ── F5.5 kg.index.status（四态透传；rebuild=纯 codegraph 无知识层写） ──

  async indexStatus(project: string, rebuild: boolean): Promise<KgViewerResult<KgIndexStatusView>> {
    const resolved = this.deps.project.resolve(project);
    if (resolved === undefined) {
      return { ok: false, error: this.paramError(project) };
    }
    const projectRoot = resolved;
    if (rebuild) {
      // absent 态触发即首次构建（B1 冷启动，同一入口无分支，AD-10）
      try {
        await this.deps.sync.triggerManual(projectRoot);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "KG_E_REBUILD_FAILED",
            message: `索引构建触发失败：${(err as Error).message}`,
          },
        };
      }
    } else if (this.deps.sync.isBuilding(projectRoot)) {
      // 构建进行中（含冷启动首建、库文件尚未创建）——先于 absent 短路
      return { ok: true, value: { state: "building" } };
    } else if (!this.deps.project.hasIndex(projectRoot)) {
      // absent 短路：读面绝不新建库文件（getStatus 触库连接即建库）
      return { ok: true, value: { state: "absent" } };
    }
    return { ok: true, value: this.statusView(projectRoot) };
  }

  // ── 内部 ────────────────────────────────────────────────

  /** project 解析 + absent 短路（读命令统一前置；rebuild 面单独放行 absent）。 */
  private resolveIndexed(project: string): KgViewerResult<string> {
    const resolved = this.deps.project.resolve(project);
    if (resolved === undefined) return { ok: false, error: this.paramError(project) };
    if (!this.deps.project.hasIndex(resolved)) {
      return {
        ok: false,
        error: {
          code: "KG_E_NOT_FOUND",
          message: `项目 ${project} 尚未建立索引（absent；构建入口 = kg.index.status rebuild）`,
          path: "payload.project",
        },
      };
    }
    return { ok: true, value: resolved };
  }

  private paramError(project: string): KgViewerError {
    return {
      code: "KG_E_PARAM",
      message: `project 无法解析（不在 workspace 项目列表内）：${project}`,
      path: "payload.project",
    };
  }

  private enumError(value: string | undefined, allowed: readonly string[], path: string): KgViewerError | null {
    if (value === undefined || allowed.includes(value)) return null;
    return { code: "KG_E_PARAM", message: `${path} 越界（合法集合：${allowed.join(" / ")}）`, path };
  }

  private statusView(projectRoot: string): KgIndexStatusView {
    const status = this.deps.sync.getStatus(projectRoot);
    switch (status.phase) {
      case "synced":
        return {
          state: "synced",
          symbolCount: status.symbolCount,
          ...(status.syncedAt !== null ? { syncedAt: status.syncedAt } : {}),
        };
      case "degraded":
        return { state: "degraded", degradedNote: KG_DEGRADED_NOTE };
      case "building":
        return { state: "building" };
      case "absent":
        return { state: "absent" };
    }
  }

  /** 详情聚合：body 原文单段直返 + 锚态标注（dead=orphan / stale=活跃度启发命中）+ 行号 + 关系 peer + 链 + 日志。 */
  private assembleDetail(projectRoot: string, detail: NodeDetail): KgNodeDetailView {
    const { node } = detail;
    const suspects = new Set(
      this.deps.verify
        .findActivityMismatch(projectRoot)
        .map((s) => anchorKey(s.anchor.nodeId, s.anchor.anchorPath, s.anchor.anchorSymbol)),
    );
    const spanByKey = new Map(
      this.deps.graph
        .getAttachmentSnapshot(projectRoot)
        .symbolAnchors.map((a) => [anchorKey(a.nodeId, a.path, a.symbol), a.span?.startLine] as const),
    );
    const anchors: KgAnchorView[] = detail.materializedAnchors.map((anchor) => {
      const key = anchorKey(node.id, anchor.anchorPath, anchor.anchorSymbol);
      const state: KgAnchorView["state"] =
        anchor.orphan === true ? "dead" : suspects.has(key) ? "stale" : "ok";
      const line = spanByKey.get(key);
      return {
        ...(anchor.anchorSymbol !== null ? { symbol: anchor.anchorSymbol } : {}),
        path: anchor.anchorPath,
        ...(line !== undefined ? { line } : {}),
        state,
      };
    });

    const digestById = new Map(this.deps.graph.search(projectRoot, "").map((row) => [row.id, row] as const));
    const peerOf = (id: string): NodeDigestRow =>
      // 防御分支（addEdge 事务内已校引用存在）：不可达时不用裸 id 充 name（AD-16）
      digestById.get(id) ?? { id, kind: node.kind, name: "已删除节点", digest: "", status: "superseded", domain: null };
    const relations: KgRelationView[] = detail.edges.map((edge) => ({
      verb: edge.verb,
      peer: peerOf(edge.otherId),
    }));

    const chain = detail.supersedeChain;
    const currentIdx = lastIndexOfNewest(chain);
    const current = peerOf(chain[currentIdx]?.nodeId ?? node.id);
    const history = chain
      .filter((_, i) => i !== currentIdx)
      .map((link) => peerOf(link.nodeId));

    const log: KgLogView[] = [...detail.changeLog]
      .reverse() // 最新在上
      .map((entry) => ({
        date: entry.ts,
        iterationId: entry.iterationId,
        eventText: logEventText(entry.op, entry.reason),
      }));

    return { node, body: node.body, anchors, relations, supersede: { history, current }, log };
  }
}

// ── 纯 helper ────────────────────────────────────────────

/** anchor 去重键（锚态/行号两数据源 join 键）。 */
function anchorKey(nodeId: string, path: string, symbol: string | null): string {
  return `${nodeId}\u0000${path}\u0000${symbol ?? ""}`;
}

/** 链上现行项下标（有 newer 取最新 newer；否则 self）。 */
function lastIndexOfNewest(chain: readonly SupersedeChainLink[]): number {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (chain[i]!.relation === "newer") return i;
  }
  const selfIdx = chain.findIndex((link) => link.relation === "self");
  return selfIdx >= 0 ? selfIdx : chain.length - 1;
}
