import { readdirSync } from "node:fs";
import path from "node:path";
import type { CodegraphEnginePort } from "../../application/ports/outbound/CodegraphEnginePort";
import type { KnowledgeGraphPort } from "../../application/ports/outbound/KnowledgeGraphPort";
import type { KnowledgeStorePort } from "../../application/ports/outbound/KnowledgeStorePort";
import { KgWriteService } from "../../application/services/kg/KgWriteService";
import { CodegraphEngineAdapter } from "../../adapters/driven/codegraph-engine/CodegraphEngineAdapter";
import type { CodegraphResolution } from "../../adapters/driven/codegraph-engine/resolve-codegraph";
import { KgDatabase } from "../../adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { FsWatchAdapter } from "../../adapters/driven/fs-watch/FsWatchAdapter";
import { KgSyncService } from "../../application/services/kg/KgSyncService";

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
 *
 * AG-06 计数口径：本函数是 .kg 库第二个写队列实例（独立于 helix.db
 * WriteQueue，AD-15 按表分域两写点）的唯一构造点；codegraph-engine 只读
 * 读点（codegraph.db mode=ro 投影，非写点）。
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
  /** 关闭全部 per-project 连接（daemon 退出/测试清理；库文件保留）。 */
  readonly dispose: () => void;
}

export function buildKnowledgeStack(deps: { codegraphResolution: CodegraphResolution }): KnowledgeStack {
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
  return {
    writeService,
    store,
    graph,
    codegraphEngine,
    syncService,
    dispose: () => {
      syncService.dispose();
      database.closeAll();
    },
  };
}

/**
 * workspace 一层扫描（§3.5 宽松口径 V-3：一级目录全部入列，排除清单为
 * 唯一过滤——目录项、非隐藏、非排除段）。§3.5 收口（domain/kg/
 * project-discovery.ts + KgProjectService，T5.x）到位后本私有 helper 由
 * 单点替换——组合根临时内联，handlers/service 层不自带解析纪律不变。
 */
export function scanWorkspaceProjects(workspaceRoot: string): string[] {
  const excluded = new Set(["docs", ".helix", ".worktrees", "node_modules"]);
  let entries;
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return []; // workspace 根不可读——无项目可触发
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || excluded.has(entry.name)) continue;
    out.push(path.join(workspaceRoot, entry.name));
  }
  return out.sort();
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
      const rel = path.relative(workspaceRoot, event.absPath);
      const first = rel.split(path.sep)[0] ?? "";
      if (first === "" || first === ".." || path.isAbsolute(rel)) return;
      stack.syncService.onFsEvent(path.join(workspaceRoot, first), event.absPath, event.kind);
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
