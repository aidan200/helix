/**
 * KgProjectService —— workspace 项目发现/解析/四态聚合编排（§3.5，F5.0，
 * T5.3）。
 *
 * 单点收口（v1 教训）：project 参数（名称或绝对路径）→ projectRoot 的
 * 解析与 workspace 扫描全部经本 service（纯逻辑 = domain/kg/
 * project-discovery.ts）；handlers/service 层禁自带 join 解析、零 env 读取。
 * workspace 根 = daemon 启动 cwd（组合根注入；TR-AD-6 零 env 键）。
 *
 * 读面绝不新建库文件：absent 项目（无 .helix-kg/kg.db）在触达任何读 port 之前
 * 先行短路——status=absent 不带计数/时间（KgDatabase 连接是建库副作用，
 * 读面禁触发）。零写路径（只读命令 CL-5.A8）。
 */

import type { ProjectDirEntry } from "../../../domain/kg/project-discovery";
import { resolveProjectArg } from "../../../domain/kg/project-discovery";
import type { KgIndexPhase, KgIndexStatus } from "./KgSyncService";

/** 项目行（应用层形状；协议 DTO 由 driving 层逐字段映射）。 */
export interface KgProjectRowView {
  readonly name: string;
  readonly path: string;
  readonly status: KgIndexPhase;
  readonly symbolCount?: number;
  readonly nodeCount?: number;
  readonly syncedAt?: string;
  readonly degradedNote?: string;
  /** 该项目存在非终态 kg-bootstrap job（P0① 入口卡 running 态数据源；
   *  终态后回落 false）。 */
  readonly bootstrapRunning: boolean;
  /** 该项目存在非终态 kg-review job（体检面板运行态数据源，bootstrapRunning
   *  同规；终态后回落 false——体检仅禁并发不绑一次性）。 */
  readonly reviewRunning: boolean;
  /** 该项目存在非终态 code-review job（体检区代码评审入口运行态数据源，
   *  reviewRunning 同规）。 */
  readonly codeReviewRunning: boolean;
}

export interface KgProjectServiceDeps {
  /** workspace 根（= daemon 启动 cwd，组合根注入；§3.1/TR-AD-6）。 */
  readonly workspaceRoot: string;
  /** 一层扫描 IO（adapters/driven/workspace-scan.scanProjectEntries 注入）。 */
  readonly scan: () => readonly ProjectDirEntry[];
  /** .helix-kg/kg.db 存在性探测 IO（读面绝不新建库文件的判定输入）。 */
  readonly hasIndex: (projectRoot: string) => boolean;
  /** 索引四态读面（KgSyncService.getStatus 注入）。 */
  readonly indexStatus: (projectRoot: string) => KgIndexStatus;
  /** 非 superserved 节点计数（KnowledgeGraphPort.countActiveNodes 注入；T3.2
   *  准入口径——contracts/kg-bootstrap-api.md §1，留史行不计入）。 */
  readonly countActiveNodes: (projectRoot: string) => number;
  /** 该项目存在非终态 kg-bootstrap job 判定（P0① TaskStorePort 查询注入；
   *  缺省 = 恒 false——未装配任务栈的组装面/测试 rig）。 */
  readonly hasRunningBootstrapJob?: (projectName: string) => boolean;
  /** 该项目存在非终态 kg-review job 判定（体检面板运行态数据源，
   *  hasRunningBootstrapJob 同规；缺省 = 恒 false）。 */
  readonly hasRunningReviewJob?: (projectName: string) => boolean;
  /** 该项目存在非终态 code-review job 判定（code-review v1.5 体检区代码
   *  评审入口运行态数据源，hasRunningReviewJob 同规；缺省 = 恒 false）。 */
  readonly hasRunningCodeReviewJob?: (projectName: string) => boolean;
}

/** degraded 态影响说明（F5.5 面板口径的确定性文案）。 */
export const KG_DEGRADED_NOTE = "codegraph 引擎不可用：符号层降级（按上次基准滞后呈现，符号锚物化暂停）";

export class KgProjectService {
  private readonly deps: KgProjectServiceDeps;

  constructor(deps: KgProjectServiceDeps) {
    this.deps = deps;
  }

  /** workspace 根（组合根同源注入值；诊断/日志面）。 */
  get workspaceRoot(): string {
    return this.deps.workspaceRoot;
  }

  /** 项目列表（宽松口径 V-3：扫描全集入列，含 absent；只读零写）。 */
  listProjects(): readonly KgProjectRowView[] {
    return this.deps.scan().map((entry) => this.rowOf(entry));
  }

  /**
   * project 参数单点解析：名称（一级目录名）或绝对路径 → projectRoot；
   * 不在扫描全集内 → undefined（调用方回 KG_E_PARAM，§3.5/契约总则）。
   */
  resolve(project: string): string | undefined {
    return resolveProjectArg(this.deps.scan(), project);
  }

  /** .kg 存在性（读面 absent 短路判定；viewer 共用）。 */
  hasIndex(projectRoot: string): boolean {
    return this.deps.hasIndex(projectRoot);
  }

  /** 单项目行组装（absent 短路：不触任何读 port——连接即建库；
   *  bootstrapRunning/reviewRunning 机械定义与索引态无关：job 查询不触 kg 库）。 */
  private rowOf(entry: ProjectDirEntry): KgProjectRowView {
    const bootstrapRunning = this.deps.hasRunningBootstrapJob?.(entry.name) ?? false;
    const reviewRunning = this.deps.hasRunningReviewJob?.(entry.name) ?? false;
    const codeReviewRunning = this.deps.hasRunningCodeReviewJob?.(entry.name) ?? false;
    if (!this.deps.hasIndex(entry.path)) {
      return { name: entry.name, path: entry.path, status: "absent", bootstrapRunning, reviewRunning, codeReviewRunning };
    }
    const status = this.deps.indexStatus(entry.path);
    switch (status.phase) {
      case "synced":
        return {
          name: entry.name,
          path: entry.path,
          status: "synced",
          symbolCount: status.symbolCount,
          nodeCount: this.deps.countActiveNodes(entry.path),
          ...(status.syncedAt !== null ? { syncedAt: status.syncedAt } : {}),
          bootstrapRunning,
          reviewRunning,
          codeReviewRunning,
        };
      case "degraded":
        // nodeCount 同步补齐（T3.2 契约 §1：准入判定覆盖 synced ∧ degraded；
        // 缺省 = 未知 = 前端视为非空不显示入口——降级行不给计数会永不可发起）
        return { name: entry.name, path: entry.path, status: "degraded", degradedNote: KG_DEGRADED_NOTE, nodeCount: this.deps.countActiveNodes(entry.path), bootstrapRunning, reviewRunning, codeReviewRunning };
      case "building":
        return { name: entry.name, path: entry.path, status: "building", bootstrapRunning, reviewRunning, codeReviewRunning };
      case "absent":
        return { name: entry.name, path: entry.path, status: "absent", bootstrapRunning, reviewRunning, codeReviewRunning };
    }
  }
}
