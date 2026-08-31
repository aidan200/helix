/**
 * KgBootstrapService —— /project 页 bootstrap 数据面五命令应用编排
 *（iter-20260829-ys7q T3.2，CL-1 F1.1/F1.2 + CL-4 F4.1~F4.3；契约 =
 * development/contracts/kg-bootstrap-api.md）。
 *
 * ws-server handlers/kg.ts 五命令（kg.bootstrap.create / kg.bootstrap.produce /
 * kg.node.update / kg.node.supersede / kg.bootstrap.impact）的唯一 service 面
 * （driving 只转发不决策，§9 kg 族既有口径）。与 KgViewerService（P-1 六命令）
 * 并列——既有六命令零改动，本服务为 additive 新面。
 *
 * V-1 语义锚：bootstrap 无 draft——产出落盘即 confirmed；修正 = updateNode /
 * supersede（理由必填）走 KgWriteService 唯一写入口（不另开写通道）；
 * 受影响连带标记 = edges 只读推导（不落库、零自动写）；呈现区操作不触
 * task.* 命令（F4.4 审阅不阻塞——本服务读任务表但不写任务域）。
 *
 * 错误模型（契约 §2/§4）：kg.bootstrap.not_eligible（message 带原因
 * index_absent / index_building / knowledge_not_empty / task_running（P0①
 * 双启动防护：已有非终态 kg-bootstrap job 拒绝，终态后可再发））/
 * kg.node.not_found / task.validation_failed（createTask 透传 + 空 patch /
 * 空理由双防线——KgWriteService KG_E_SCHEMA 归一为契约词表）。
 */

import type { TaskEnginePort } from "../../ports/inbound/TaskEnginePort";
import type { TaskStorePort, JobData, BatchData } from "../../ports/outbound/TaskStorePort";
import type { TaskSkillRegistryPort } from "../../ports/outbound/TaskSkillRegistryPort";
import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { KgProjectService } from "./KgProjectService";
import type { KgSyncService } from "./KgSyncService";
import type { KgWriteService } from "./KgWriteService";
import type { KnowledgeNode, NodeDigestRow } from "../../../domain/kg/types";
import { hasActiveJob, projectNameOf } from "./job-activity";

// ── 结果形状（应用层视图；协议 DTO 由 driving 层逐字段映射） ──

/** 准入复核结论（create 前置；reason = 契约词表 index_absent / index_building /
 * knowledge_not_empty / task_running（P0① 第四条：非终态同类型 job 并发禁入））。 */
export type BootstrapEligibility = { readonly eligible: true } | { readonly eligible: false; readonly reason: "index_absent" | "index_building" | "knowledge_not_empty" | "task_running" };

/** kg.bootstrap.create 结果。 */
export interface KgBootstrapCreateView {
  readonly jobId: string;
}

/** 产出节点条目（契约 ProduceNodeDto 应用层形状）。 */
export interface ProduceNodeView {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: "confirmed" | "superseded";
  readonly digest: string;
  readonly body: string;
  readonly anchors: readonly { symbol: string; path: string; line: number | null }[];
  readonly rationale: string;
  readonly origin: { readonly taskTitle: string; readonly batchScope: string };
  readonly supersedeReason?: string;
}

export interface ProduceBatchView {
  readonly batchId: string;
  readonly scope: string;
  readonly nodes: readonly ProduceNodeView[];
}

export interface ProduceStageView {
  readonly layer: "L0" | "L1" | "L2";
  readonly name: string;
  readonly batches: readonly ProduceBatchView[];
}

export interface ProduceGroupView {
  readonly jobId: string;
  readonly title: string;
  readonly stages: readonly ProduceStageView[];
}

/** kg.bootstrap.impact 结果（引用方人类面投影）。 */
export interface KgImpactView {
  readonly affected: readonly NodeDigestRow[];
  readonly count: number;
}

/** kg.node.update 结果（修改后回读）。 */
export interface KgNodeUpdateView {
  readonly node: ProduceNodeView;
}

/** 结构化错误（契约词表；与 KgViewerError 同构但码域不同——本面归 task.* 词表）。 */
export type KgBootstrapErrorCode = "kg.bootstrap.not_eligible" | "kg.node.not_found" | "task.validation_failed" | "task.type_unknown" | "KG_E_PARAM";

export interface KgBootstrapError {
  readonly code: KgBootstrapErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type KgBootstrapResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: KgBootstrapError };

/** updateNode 修正的 change_log 审计叙述（固定文案；理由落 change_log.reason）。 */
export const UPDATE_LOG_REASON = "页面人工修正（/project 产出呈现）";

export interface KgBootstrapServiceDeps {
  readonly project: KgProjectService;
  readonly graph: KnowledgeGraphPort;
  readonly write: KgWriteService;
  readonly sync: Pick<KgSyncService, "getStatus" | "isBuilding">;
  /** 任务引擎（TP-2.3a④ 命名避让：字段名不带裸 engine——container arch-guard）。 */
  readonly taskEngine: TaskEnginePort;
  readonly store: TaskStorePort;
  readonly skills: TaskSkillRegistryPort;
}

/** 知识层为空的产出回退任务标题（job 行缺失时防御形态；正常路径 titleOf 组装）。 */
const FALLBACK_TITLE = "知识创建任务";

export class KgBootstrapService {
  private readonly deps: KgBootstrapServiceDeps;

  constructor(deps: KgBootstrapServiceDeps) {
    this.deps = deps;
  }

  // ── CL-1 F1.1/F1.2 kg.bootstrap.create（准入机械复核 + createTask 同源） ──

  /** 准入机械复核（契约 §1；后端不信赖前端）：索引存在 ∧ 非 building ∧ 无带 layer
   *  产出（O-9 精化：「知识层非空」只数带 layer 的产出节点；sediment 沉淀节点
   * （layer 为 NULL）不阻挡 bootstrap 入口）∧ 无非终态同类型 job（P0① 第四条
   * task_running：窗口期（job 已建、首节点未产出）内拒绝重复 create，堵双
   * 编排器并行产出；终态后放行）。 */
  eligibility(projectRoot: string): BootstrapEligibility {
    if (this.deps.sync.isBuilding(projectRoot)) return { eligible: false, reason: "index_building" };
    if (!this.deps.project.hasIndex(projectRoot)) return { eligible: false, reason: "index_absent" };
    const phase = this.deps.sync.getStatus(projectRoot).phase;
    if (phase === "building") return { eligible: false, reason: "index_building" };
    if (phase === "absent") return { eligible: false, reason: "index_absent" };
    if (this.deps.graph.countActiveLayeredNodes(projectRoot) !== 0) return { eligible: false, reason: "knowledge_not_empty" };
    if (hasActiveJob(this.deps.store.listJobs(), "kg-bootstrap", projectNameOf(projectRoot))) return { eligible: false, reason: "task_running" };
    return { eligible: true };
  }

  async create(project: string, scope?: string): Promise<KgBootstrapResult<KgBootstrapCreateView>> {
    const resolved = this.resolve(project);
    if (!resolved.ok) return resolved;
    const projectRoot = resolved.value;
    const eligibility = this.eligibility(projectRoot);
    if (!eligibility.eligible) {
      const message =
        eligibility.reason === "index_absent"
          ? "index_absent：项目尚未构建索引（先完成一次机械构建，B1 冷启动链）"
          : eligibility.reason === "index_building"
            ? "index_building：索引构建进行中，完成后可发起"
            : eligibility.reason === "task_running"
              ? "task_running：该项目已有进行中的知识创建任务（kg-bootstrap）；可在「任务」页观察进度，任务终态后可再次发起（禁双启动）"
              : "knowledge_not_empty：知识层已有带 layer 的图谱产出（sediment 沉淀不计入；bootstrap 只为有代码积累、无图谱的老项目补图谱）";
      return { ok: false, error: { code: "kg.bootstrap.not_eligible", message } };
    }
    const projectName = projectRoot.split("/").filter((s) => s !== "").pop() ?? project;
    const params: Record<string, unknown> = { projectRoot, ...(scope !== undefined && scope.trim() !== "" ? { scope } : {}) };
    try {
      // createTask 同一 API（type/params/projects/createdBy 与 chat task_create 工具同源，AD-7）；
      // 校验失败（task.validation_failed / task.type_unknown）由引擎抛出透传
      const { jobId } = await this.deps.taskEngine.createTask({
        type: "kg-bootstrap",
        projects: [projectName],
        params,
        createdBy: "page",
      });
      return { ok: true, value: { jobId } };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "task.validation_failed" || code === "task.type_unknown") {
        return { ok: false, error: { code, message } };
      }
      return { ok: false, error: { code: "task.validation_failed", message } };
    }
  }

  // ── CL-4 F4.1 kg.bootstrap.produce（任务→阶段→批次三级分组） ──

  produce(project: string): KgBootstrapResult<readonly ProduceGroupView[]> {
    const resolved = this.resolve(project);
    if (!resolved.ok) return resolved;
    const projectRoot = resolved.value;
    // absent 项目 → 空结果（读面绝不新建库文件；kg.viewer resolveIndexed 同口径）
    if (!this.deps.project.hasIndex(projectRoot)) return { ok: true, value: [] };

    // 产出节点全集（含 superseded 留史——呈现区「已废弃」条目）；日常落账
    //（无 originBatchId）不进本查询（契约 §3 数据源机械定义）
    const produced = this.deps.graph
      .getVerifyView(projectRoot)
      .nodes.filter((n) => n.originBatchId !== null && n.originBatchId !== undefined);

    const jobs = this.deps.store
      .listJobs()
      .filter((j) => j.type === "kg-bootstrap" && j.projects.includes(projectNameOf(projectRoot)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

    // 批次 → 产出节点分桶（batch id 全局唯一，跨 job 无碰撞）
    const nodesByBatch = new Map<string, KnowledgeNode[]>();
    for (const node of produced) {
      const batchId = node.originBatchId!;
      const bucket = nodesByBatch.get(batchId);
      if (bucket === undefined) nodesByBatch.set(batchId, [node]);
      else bucket.push(node);
    }

    const groups: ProduceGroupView[] = [];
    for (const job of jobs) {
      const stages = this.deps.store.getStages(job.id);
      const stageViews: ProduceStageView[] = [];
      for (const stage of stages) {
        const batches = this.deps.store.getBatches(job.id, stage.seq);
        const batchViews: ProduceBatchView[] = [];
        for (const batch of batches) {
          const nodes = nodesByBatch.get(batch.id) ?? [];
          if (nodes.length === 0) continue; // 无产出节点的批次不进产出呈现（任务进度面归 P-2）
          batchViews.push({
            batchId: batch.id,
            scope: batch.scope,
            nodes: nodes.map((n) => this.nodeView(projectRoot, n, job, batch)),
          });
        }
        if (batchViews.length === 0) continue;
        stageViews.push({ layer: layerOfStage(stage.name, stage.seq), name: stage.name, batches: batchViews });
      }
      if (stageViews.length === 0) continue;
      groups.push({ jobId: job.id, title: this.titleOf(job), stages: stageViews });
    }
    return { ok: true, value: groups };
  }

  // ── CL-4 F4.2 kg.node.update / kg.node.supersede（修正写面，KgWriteService 唯一入口） ──

  async update(project: string, nodeId: string, patch: { digest?: string; body?: string }): Promise<KgBootstrapResult<KgNodeUpdateView>> {
    const resolved = this.resolve(project);
    if (!resolved.ok) return resolved;
    const projectRoot = resolved.value;
    if (!this.deps.project.hasIndex(projectRoot) || this.deps.graph.getNode(projectRoot, nodeId) === null) {
      return { ok: false, error: { code: "kg.node.not_found", message: `节点 ${nodeId} 不存在`, path: "payload.nodeId" } };
    }
    const digest = patch.digest?.trim();
    const body = patch.body?.trim();
    if ((digest === undefined || digest === "") && (body === undefined || body === "")) {
      return { ok: false, error: { code: "task.validation_failed", message: "digest / body 至少携带其一（空更新拒绝）" } };
    }
    const iterationId = this.deps.graph.latestIteration(projectRoot);
    if (iterationId === null) {
      return { ok: false, error: { code: "task.validation_failed", message: "库内无迭代锚（change_log 空），无法归属审计行" } };
    }
    const write = this.deps.write.write(projectRoot, {
      kind: "updateNode",
      iterationId,
      nodeId,
      patch: {
        ...(digest !== undefined && digest !== "" ? { digest } : {}),
        ...(body !== undefined && body !== "" ? { body } : {}),
        reason: UPDATE_LOG_REASON,
      },
    });
    if (!write.ok) return { ok: false, error: { code: "task.validation_failed", message: write.error.message, path: write.error.path } };
    return this.afterWriteView(projectRoot, project, nodeId);
  }

  async supersede(project: string, nodeId: string, reason: string): Promise<KgBootstrapResult<{ ok: true }>> {
    const resolved = this.resolve(project);
    if (!resolved.ok) return resolved;
    const projectRoot = resolved.value;
    if (!this.deps.project.hasIndex(projectRoot) || this.deps.graph.getNode(projectRoot, nodeId) === null) {
      return { ok: false, error: { code: "kg.node.not_found", message: `节点 ${nodeId} 不存在`, path: "payload.nodeId" } };
    }
    // 理由必填双防线（前端拦截 + 后端拒绝；空/纯空白 → task.validation_failed）
    if (typeof reason !== "string" || reason.trim() === "") {
      return { ok: false, error: { code: "task.validation_failed", message: "supersede 理由必填（如实记录进入变更日志）", path: "payload.reason" } };
    }
    const iterationId = this.deps.graph.latestIteration(projectRoot);
    if (iterationId === null) {
      return { ok: false, error: { code: "task.validation_failed", message: "库内无迭代锚（change_log 空），无法归属审计行" } };
    }
    const write = this.deps.write.write(projectRoot, { kind: "supersede", iterationId, nodeId, reason: reason.trim() });
    if (!write.ok) return { ok: false, error: { code: "task.validation_failed", message: write.error.message, path: write.error.path } };
    return { ok: true, value: { ok: true } };
  }

  // ── CL-4 F4.3 kg.bootstrap.impact（edges 引用方只读推导，零写） ──

  impact(project: string, nodeId: string): KgBootstrapResult<KgImpactView> {
    const resolved = this.resolve(project);
    if (!resolved.ok) return resolved;
    const projectRoot = resolved.value;
    if (!this.deps.project.hasIndex(projectRoot)) {
      return { ok: false, error: { code: "kg.node.not_found", message: `项目 ${project} 尚未建立索引`, path: "payload.project" } };
    }
    // 受影响 = edges 中存在指向被修正节点的边的 source 节点集（引用方 = 下游），
    // 去重、排除 superseded（契约 §5 机械定义）；只读推导不落库
    const view = this.deps.graph.getVerifyView(projectRoot);
    const statusById = new Map(view.nodes.map((n) => [n.id, n.status] as const));
    const digestById = new Map(this.deps.graph.search(projectRoot, "").map((row) => [row.id, row] as const));
    const sources = new Set<string>();
    for (const edge of view.edges) {
      if (edge.dstId === nodeId) sources.add(edge.srcId);
    }
    const affected: NodeDigestRow[] = [];
    for (const src of [...sources].sort()) {
      if (statusById.get(src) === "superseded") continue;
      const row = digestById.get(src);
      if (row === undefined) continue;
      affected.push(row);
    }
    return { ok: true, value: { affected, count: affected.length } };
  }

  // ── 内部 ────────────────────────────────────────────────

  private resolve(project: string): KgBootstrapResult<string> {
    const resolved = this.deps.project.resolve(project);
    if (resolved === undefined) {
      return {
        ok: false,
        error: { code: "KG_E_PARAM", message: `project 无法解析（不在 workspace 项目列表内）：${project}`, path: "payload.project" },
      };
    }
    return { ok: true, value: resolved };
  }

  /** 任务标题（skill description 首段 + 项目语境——TaskQueryService.titleOf 同构，P-2 列表行同源）。 */
  private titleOf(job: JobData): string {
    const description = this.deps.skills.listTaskTypes().find((t) => t.type === job.type)?.description;
    const base = description === undefined ? FALLBACK_TITLE : (description.split(/[；;\n]/)[0] ?? description);
    return job.projects.length > 0 ? `${base}（${job.projects.join("、")}）` : base;
  }

  /** 产出节点条目组装（锚点行号 join 物化 span；为什么存在段抽取；留史理由取 change_log）。 */
  private nodeView(projectRoot: string, node: KnowledgeNode, job: JobData, batch: BatchData): ProduceNodeView {
    const detail = this.deps.graph.getNode(projectRoot, node.id);
    const spanByKey = new Map(
      this.deps.graph
        .getAttachmentSnapshot(projectRoot)
        .symbolAnchors.map((a) => [`${a.path}\u0000${a.symbol}`, a.span?.startLine ?? null] as const),
    );
    const anchors = (detail?.materializedAnchors ?? [])
      .filter((a) => a.orphan !== true)
      .map((a) => ({
        symbol: a.anchorSymbol ?? a.anchorPath,
        path: a.anchorPath,
        line: a.anchorSymbol === null ? null : (spanByKey.get(`${a.anchorPath}\u0000${a.anchorSymbol}`) ?? null),
      }));
    const supersedeEntry = (detail?.changeLog ?? [])
      .filter((entry) => entry.op === "supersede")
      .slice(-1)[0];
    return {
      nodeId: node.id,
      name: node.name,
      kind: node.kind,
      status: node.status === "superseded" ? "superseded" : "confirmed",
      digest: node.digest,
      body: node.body,
      anchors,
      rationale: extractRationale(node.body),
      origin: { taskTitle: this.titleOf(job), batchScope: batch.scope },
      ...(supersedeEntry !== undefined && supersedeEntry.reason !== null ? { supersedeReason: supersedeEntry.reason } : {}),
    };
  }

  /** update 后回读（nodeView 组装；job/batch 取产出分组上下文——回读条目归位呈现）。 */
  private afterWriteView(projectRoot: string, project: string, nodeId: string): KgBootstrapResult<KgNodeUpdateView> {
    const groups = this.produce(project);
    if (!groups.ok) return groups;
    for (const group of groups.value) {
      for (const stage of group.stages) {
        for (const batch of stage.batches) {
          const hit = batch.nodes.find((n) => n.nodeId === nodeId);
          if (hit !== undefined) return { ok: true, value: { node: hit } };
        }
      }
    }
    // 节点不在任何产出分组（防御：修正面只对产出条目开放）——直接取详情拼装
    const detail = this.deps.graph.getNode(projectRoot, nodeId);
    if (detail === null) {
      return { ok: false, error: { code: "kg.node.not_found", message: `节点 ${nodeId} 回读失败`, path: "payload.nodeId" } };
    }
    const view: ProduceNodeView = {
      nodeId: detail.node.id,
      name: detail.node.name,
      kind: detail.node.kind,
      status: detail.node.status === "superseded" ? "superseded" : "confirmed",
      digest: detail.node.digest,
      body: detail.node.body,
      anchors: [],
      rationale: extractRationale(detail.node.body),
      origin: { taskTitle: FALLBACK_TITLE, batchScope: "" },
    };
    return { ok: true, value: { node: view } };
  }
}

// ── 纯 helper ────────────────────────────────────────────

// projectNameOf / hasActiveJob → job-activity.ts（P0① 起三面共用：bootstrap
// 准入第四条、review 并发禁入、kg.projects 行 bootstrapRunning）

/** 阶段名 → layer（kg-bootstrap manifest 冻结三阶段「L0 核心层」形；解析失败按序兜底）。 */
function layerOfStage(name: string, seq: number): "L0" | "L1" | "L2" {
  const match = /^(L[012])/.exec(name.trim());
  if (match !== null) return match[1] as "L0" | "L1" | "L2";
  return seq === 1 ? "L0" : seq === 2 ? "L1" : "L2";
}

/**
 * 「为什么存在」段抽取（规范 3：每条知识带为什么存在——来源+存在理由）。
 * 确定性规则：①「为什么存在」行标记（含 ：/:）→ 标记后同段文本；②否则取
 * 正文末段（写作规范将 why 收尾）；③无正文 → 空串。
 */
export function extractRationale(body: string): string {
  if (body.trim() === "") return "";
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = /^\s*[-*]?\s*为什么存在\s*[：:]\s*(.*)$/.exec(line);
    if (match !== null) {
      const rest = [match[1]!.trim(), ...lines.slice(i + 1).map((l) => l.trim())].filter((s) => s !== "");
      if (rest.length > 0) return rest.join(" ");
    }
  }
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");
  return paragraphs[paragraphs.length - 1] ?? "";
}
