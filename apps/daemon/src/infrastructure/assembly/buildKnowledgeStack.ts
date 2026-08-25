import type { CodegraphEnginePort } from "../../application/ports/outbound/CodegraphEnginePort";
import type { KnowledgeGraphPort } from "../../application/ports/outbound/KnowledgeGraphPort";
import type { KnowledgeStorePort } from "../../application/ports/outbound/KnowledgeStorePort";
import { KgWriteService } from "../../application/services/kg/KgWriteService";
import { KgAttachmentService } from "../../application/services/kg/KgAttachmentService";
import { KgQueryService } from "../../application/services/kg/KgQueryService";
import { KgVerifyService } from "../../application/services/kg/KgVerifyService";
import { KgReportService } from "../../application/services/kg/KgReportService";
import { CodegraphEngineAdapter } from "../../adapters/driven/codegraph-engine/CodegraphEngineAdapter";
import type { CodegraphResolution } from "../../adapters/driven/codegraph-engine/resolve-codegraph";
import { KgDatabase } from "../../adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { FsWatchAdapter } from "../../adapters/driven/fs-watch/FsWatchAdapter";
import { KgSyncService } from "../../application/services/kg/KgSyncService";
import type { EditToolDeps } from "../../adapters/driven/tools/edit/EditTool";
import { existingKgProjects, projectRootOfPath, scanWorkspaceProjects } from "../../adapters/driven/workspace-scan";

// §3.5 扫描/归属/existingKgProjects 已抽取 adapters/driven/workspace-scan.ts
// （T3.3：组合根与 SubAgent 子进程本地 kg 栈共用同一口径）——此处重导出
// 保既有 import 面（container/测试）不变。
export { existingKgProjects, projectRootOfPath, scanWorkspaceProjects };

/**
 * kg 子系统组合根装配（与 buildPersistence / buildSessionStack 同列）。
 *
 * T1.1 骨架：接线 port↔adapter（.kg per-project 连接由 KgDatabase 懒开，
 * projectRoot 在每次调用时传入——无需 daemon 启动期枚举项目）。
 * T2.1（AF-2）：CodegraphEnginePort 适配挂入（三级解析定格产物由组合根
 * 注入——HELIX_CODEGRAPH_PATH/PATH 的 env 读取收束于 container.ts，
 * AG-08 唯一例外面；resolve-codegraph 本体零 env 依赖）。
 * T2.2：KgSyncService 挂入 + startKgSyncBackground（daemon 启动触发 +
 * fs-watch 兑底挂接，container.ts 装配序⑦后调用）。
 * T3.2：KgAttachmentService 挂入（附着编排）+ buildEditToolDeps（edit
 * 工具挂点接线工厂：projectRootOfPath 多项目归属 + notifyWrite + 附着）。
 * T3.3：KgQueryService 挂入（读面聚合 + spawn 派发任务切片注入——
 * projects = 已建 .kg 项目，读面绝不新建库文件）。
 * T5.1：KgVerifyService（三检查，AD-6 只列不修零写路径）+ KgReportService
 * （变化报告数据面，AD-16 引用规范数据层强制）挂入——触发面 O-5 默认
 * 手动：仅暴露 service 方法，daemon 不自动跑（页面接线归 T5.3）。
 *
 * AG-06 计数口径：本函数是 .kg 库第二个写队列实例（独立于 helix.db
 * WriteQueue，AD-15 按表分域两写点）的唯一构造点；codegraph-engine 只读
 * 读点（codegraph.db mode=ro 投影，非写点）；KgAttachmentService 纯读面。
 */
export interface KnowledgeStack {
  /** kg service API 唯一写入口（schema 校验即防线）。 */
  readonly writeService: KgWriteService;
  /** .kg 写 port（writeKnowledge / applySync）。 */
  readonly store: KnowledgeStorePort;
  /** .kg 读 port（附着快照/search/get/索引状态）。 */
  readonly graph: KnowledgeGraphPort;
  /** codegraph 引擎被动封装（ensureIndex 构建 / exportSymbols 只读投影）。 */
  readonly codegraphEngine: CodegraphEnginePort;
  /** sync 管道（T2.2：双源汇队列/去抖/单飞/四步编排；触发面三处）。 */
  readonly syncService: KgSyncService;
  /** 附着编排（T3.2：edit 成功路径 📎 块 + 会话级跨通道去重注册表唯一持有者）。 */
  readonly attachmentService: KgAttachmentService;
  /** 读面聚合 + 任务切片注入（T3.3：kg 工具读面 / spawn 派发注入）。 */
  readonly queryService: KgQueryService;
  /** 验证期三检查（T5.1，F3.2：只列不修零写；触发面 O-5 手动）。 */
  readonly verifyService: KgVerifyService;
  /** 变化报告数据面（T5.1，F3.3：按迭代聚合四类条目；T5.3 kg.change.report 数据源）。 */
  readonly reportService: KgReportService;
  /** 关闭全部 per-project 连接（daemon 退出/测试清理；库文件保留）。 */
  readonly dispose: () => void;
}

export function buildKnowledgeStack(deps: {
  codegraphResolution: CodegraphResolution;
  /** workspace 根（kg 读面项目域扫描/归属；§3.5 = daemon 启动 cwd）。 */
  workspaceRoot: string;
}): KnowledgeStack {
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const writeService = new KgWriteService({ store });
  // 三级解析全 miss ≠ 装配失败：引擎面定格为不可用（binaryPath=null），
  // ensureIndex 抛 EngineUnavailable → 上层标 degraded（AF-2；exportSymbols
  // 与二进制解耦，已建索引照常投影）。
  const codegraphEngine = new CodegraphEngineAdapter({
    binaryPath: deps.codegraphResolution.kind === "resolved" ? deps.codegraphResolution.path : null,
  });
  const syncService = new KgSyncService({ store, graph, engine: codegraphEngine });
  const attachmentService = new KgAttachmentService({ graph });
  const queryService = new KgQueryService({
    graph,
    projects: () => existingKgProjects(deps.workspaceRoot),
    attachment: attachmentService,
  });
  const verifyService = new KgVerifyService({ graph });
  const reportService = new KgReportService({ graph, verify: verifyService });
  return {
    writeService,
    store,
    graph,
    codegraphEngine,
    syncService,
    attachmentService,
    queryService,
    verifyService,
    reportService,
    dispose: () => {
      syncService.dispose();
      database.closeAll();
    },
  };
}

/**
 * workspace 一层扫描（§3.5 宽松口径 V-3：一级目录全部入列，排除清单为
 * 唯一过滤——目录项、非隐藏、非排除段）。§3.5 收口（domain/kg/
 * project-discovery.ts + KgProjectService，T5.x）到位后由单点替换。
 */

/**
 * edit 工具挂点接线工厂（T3.2，CL-1 F1.1）：组合根把 kg 栈接进 EditTool
 * 成功路径——notifyWrite（T2.2 写后通知入队）+ 逐编辑附着（attachAfterEdit
 * 返回 📎 块拼接到工具结果尾部）。sessionId 在调用侧闭合（会话级跨通道
 * 去重键；与 T3.3 任务层注入共用同一 KgAttachmentService 注册表）。
 */
export function buildEditToolDeps(args: {
  readonly workspaceRoot: string;
  readonly syncService: Pick<KgSyncService, "notifyWrite">;
  readonly attachment: KgAttachmentService;
  readonly sessionId: string;
}): EditToolDeps {
  const { syncService, attachment, sessionId } = args;
  return {
    projectRoot: (absolutePath) => projectRootOfPath(args.workspaceRoot, absolutePath),
    notifyWrite: (projectRoot, filePath, hash) => syncService.notifyWrite(projectRoot, filePath, hash),
    onEditApplied: async (event) => {
      if (event.projectRoot === undefined) return "";
      let block = "";
      for (const edit of event.edits) {
        const part = await attachment.attachAfterEdit({
          projectRoot: event.projectRoot,
          sessionId,
          filePath: event.filePath,
          oldText: edit.oldText,
          newText: edit.newText,
          editLineStart: edit.editLineStart,
          editLineEnd: edit.editLineEnd,
          fileLines: event.fileLines,
        });
        if (part !== "") block += (block === "" ? "" : "\n\n") + part;
      }
      return block;
    },
  };
}

/** 启动触发 + fs-watch 兑底挂接产物（stop = daemon 退出/测试清理面）。 */
export interface KgSyncBackground {
  readonly stop: () => void;
}

/**
 * daemon 启动挂接（T2.2，装配序⑦后异步不阻塞）：
 * - 触发面一：workspace 一层扫描 → 每项目 onStartup fire-and-forget
 *   （失败吞——退避重试在 KgSyncService 内）；
 * - 触发面二：FsWatchAdapter 单流 watch workspace 根，事件一级目录即
 *   projectRoot（排除清单前置过滤）；顶层文件/逃出 root 的事件不属任何
 *   项目域——丢弃。
 */
export function startKgSyncBackground(stack: KnowledgeStack, workspaceRoot: string): KgSyncBackground {
  for (const projectRoot of scanWorkspaceProjects(workspaceRoot)) {
    stack.syncService.onStartup(projectRoot).catch(() => {
      // 启动触发失败不阻塞 daemon（退避重试在 service 内，AD-15）
    });
  }
  const adapter = new FsWatchAdapter({
    root: workspaceRoot,
    onEvent: (event) => {
      // 归属收口 projectRootOfPath（§3.5 同一过滤）：根外/排除段事件不属任何
      // 项目域——丢弃（与启动扫描口径一致，避免排除目录自行建 .kg）。
      const projectRoot = projectRootOfPath(workspaceRoot, event.absPath);
      if (projectRoot === undefined) return;
      stack.syncService.onFsEvent(projectRoot, event.absPath, event.kind);
    },
  });
  adapter.start();
  return {
    stop: () => {
      adapter.stop();
      stack.syncService.dispose();
    },
  };
}
