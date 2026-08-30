/**
 * KgMaintenanceService —— kg 维护批两命令应用编排（C1：kg.graph.purge /
 * kg.index.delete；契约 = PROTOCOL.md §22）。
 *
 * ws-server handlers/kg.ts 两命令的唯一 service 面（driving 只转发不决策，
 * kg 族既有口径）。与 KgViewerService（P-1 读面）/ KgBootstrapService
 *（bootstrap 面）并列——additive 新面，既有命令零改动。
 *
 * 【purge 范围决策（留档）】全量清 + 索引态复位：知识面（nodes/edges/
 * anchor_decl/materialized_anchors/change_log）与符号面（files/symbols/
 * contains_edges）及 meta（sync 基准戳 + seq 发号计数器）一并清零。
 * 理由：状态机自洽——若清 symbols 但留 meta 基线，sync 增量判定会以
 * mtime/hash 未变跳过全部文件，符号面永不再导入（破窗）；全量清后
 * 下一次 triggerManual 走全量域重建符号面，bootstrap 准入经「索引
 * synced ∧ 知识层空」机械恢复 eligible。purge 不动 .codegraph（那是
 * index-delete 的职责）；purge 不停 watcher——watcher 是兜底信号面，
 * 事件驱动的增量 sync 在清后库上行为自洽（等价手动重建）。
 *
 * 【purge 安全门禁】存在运行中（running/pending）的 kg-bootstrap 任务时
 * 拒绝（kg.graph.purge_blocked）——防 done 任务悬挂引用（验证期手工清库
 * 后的悬挂态教训）；判定口径 = TaskStorePort.listJobs 按 type=kg-bootstrap
 * ∧ status ∈ {running,pending} ∧ projects 含本项目名（目录名，与
 * KgBootstrapService 的 job.projects 写入键同源）。paused 不在门禁内
 *（brief 口径：running/pending）。
 *
 * 【index-delete 范围】删除 .codegraph（引擎 deleteIndex）+ kg 索引态
 * 复位 absent（store.resetIndexFace：清符号面同步基准，**知识层不动**——
 * 与 purge 职责严格分层）。联动：先停 watcher（KgFsWatchService.stopWatching
 * 接缝，B3）再删目录（事件源截断在状态变更前）；重建经既有
 * KgSyncService.onSynced 钩子自动重挂。
 *
 * 两命令共同纪律：读面绝不新建库文件——目标项目无 .helix-kg/kg.db 时
 * purge = 幂等空清（计数全 0，不开连接）、index-delete 跳过库面复位
 * （仅删目录 + 停 watcher）。
 */

import type { CodegraphEnginePort } from "../../ports/outbound/CodegraphEnginePort";
import type { KnowledgeStorePort } from "../../ports/outbound/KnowledgeStorePort";
import type { TaskStorePort } from "../../ports/outbound/TaskStorePort";
import type { KgFsWatchService } from "./KgFsWatchService";
import type { KgProjectService } from "./KgProjectService";
import type { KgSyncService } from "./KgSyncService";

// ── 结果形状（应用层视图；协议 DTO 由 driving 层逐字段映射） ──

/** kg.graph.purge 结果（全清汇总 + 判别位）。 */
export interface KgGraphPurgeView {
  readonly purged: true;
  readonly nodesRemoved: number;
  readonly symbolsRemoved: number;
  readonly filesRemoved: number;
}

/** kg.index.delete 结果（state 恒 absent——状态机自洽断言位）。 */
export interface KgIndexDeleteView {
  readonly deleted: true;
  readonly state: "absent";
  readonly watcherStopped: boolean;
}

/** 结构化错误（契约词表；KG_E_PARAM 与 kg 族同码，purge_blocked 为本面专属）。 */
export type KgMaintenanceErrorCode = "KG_E_PARAM" | "kg.graph.purge_blocked";

export interface KgMaintenanceError {
  readonly code: KgMaintenanceErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type KgMaintenanceResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: KgMaintenanceError };

/** purge 门禁覆盖的任务状态（brief 口径：running/pending；paused 不在内）。 */
const PURGE_GATE_STATUSES: ReadonlySet<string> = new Set(["running", "pending"]);

export interface KgMaintenanceServiceDeps {
  /** 项目解析/存在性（§3.5 单点；hasIndex = .helix-kg/kg.db 存在性探测）。 */
  readonly project: KgProjectService;
  /** .kg 写 port（purgeAll 全清 / resetIndexFace 索引面复位）。 */
  readonly store: KnowledgeStorePort;
  /** sync 定时器/内存态清理（结构面子集——只消费 dispose）。 */
  readonly sync: Pick<KgSyncService, "dispose">;
  /** watcher 停止接缝（结构面子集——只消费 stopWatching，B3）。 */
  readonly fsWatch: Pick<KgFsWatchService, "stopWatching">;
  /** 引擎索引目录删除（结构面子集——只消费 deleteIndex；TP-2.3a④ 命名避让）。 */
  readonly codegraph: Pick<CodegraphEnginePort, "deleteIndex">;
  /** purge 门禁数据源（结构面子集——只消费 listJobs）。 */
  readonly taskStore: Pick<TaskStorePort, "listJobs">;
}

export class KgMaintenanceService {
  private readonly deps: KgMaintenanceServiceDeps;

  constructor(deps: KgMaintenanceServiceDeps) {
    this.deps = deps;
  }

  // ── kg.graph.purge（清空图谱：门禁 → 全清 → 索引态复位） ──

  purge(project: string): KgMaintenanceResult<KgGraphPurgeView> {
    const resolved = this.resolve(project);
    if (!resolved.ok) return resolved;
    const projectRoot = resolved.value;

    // 安全门禁：运行中（running/pending）kg-bootstrap 任务存在时拒绝
    const projectName = projectNameOf(projectRoot);
    const blocking = this.deps.taskStore
      .listJobs()
      .filter((j) => j.type === "kg-bootstrap" && PURGE_GATE_STATUSES.has(j.status) && j.projects.includes(projectName))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (blocking !== undefined) {
      return {
        ok: false,
        error: {
          code: "kg.graph.purge_blocked",
          message: `存在运行中的 kg-bootstrap 任务（${projectName}）：清空图谱不可用——请先等待任务完成或取消任务`,
        },
      };
    }

    // 读面纪律同构：无 .helix-kg/kg.db → 幂等空清（不开连接不建库）
    if (!this.deps.project.hasIndex(projectRoot)) {
      return { ok: true, value: { purged: true, nodesRemoved: 0, symbolsRemoved: 0, filesRemoved: 0 } };
    }
    this.deps.sync.dispose(projectRoot); // 清去抖/退避定时器与内存基准态（不清库）
    const summary = this.deps.store.purgeAll(projectRoot);
    return { ok: true, value: { purged: true, ...summary } };
  }

  // ── kg.index.delete（停 watcher → 删 .codegraph → 索引态复位） ──

  async deleteIndex(project: string): Promise<KgMaintenanceResult<KgIndexDeleteView>> {
    const resolved = this.resolve(project);
    if (!resolved.ok) return resolved;
    const projectRoot = resolved.value;

    // 联动顺序：先截事件源（watcher + sync 定时器）再删目录再复位状态
    this.deps.fsWatch.stopWatching(projectRoot);
    this.deps.sync.dispose(projectRoot);
    await this.deps.codegraph.deleteIndex(projectRoot);
    if (this.deps.project.hasIndex(projectRoot)) {
      this.deps.store.resetIndexFace(projectRoot); // 知识层不动（与 purge 分层）
    }
    return { ok: true, value: { deleted: true, state: "absent", watcherStopped: true } };
  }

  // ── 内部 ────────────────────────────────────────────────

  private resolve(project: string): KgMaintenanceResult<string> {
    const resolved = this.deps.project.resolve(project);
    if (resolved === undefined) {
      return {
        ok: false,
        error: { code: "KG_E_PARAM", message: `project 无法解析（不在 workspace 项目列表内）：${project}`, path: "payload.project" },
      };
    }
    return { ok: true, value: resolved };
  }
}

// ── 纯 helper ────────────────────────────────────────────

/** projectRoot → workspace 一级目录名（job.projects 标签匹配键；KgBootstrapService 同口径）。 */
function projectNameOf(projectRoot: string): string {
  return projectRoot.split("/").filter((s) => s !== "").pop() ?? projectRoot;
}
