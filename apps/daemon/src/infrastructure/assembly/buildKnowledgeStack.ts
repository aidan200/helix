import type { CodegraphEnginePort } from "../../application/ports/outbound/CodegraphEnginePort";
import type { KnowledgeGraphPort } from "../../application/ports/outbound/KnowledgeGraphPort";
import type { KnowledgeStorePort } from "../../application/ports/outbound/KnowledgeStorePort";
import { KgWriteService } from "../../application/services/kg/KgWriteService";
import { CodegraphEngineAdapter } from "../../adapters/driven/codegraph-engine/CodegraphEngineAdapter";
import type { CodegraphResolution } from "../../adapters/driven/codegraph-engine/resolve-codegraph";
import { KgDatabase } from "../../adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../adapters/driven/sqlite-kg/SqliteKnowledgeStore";

/**
 * kg 子系统组合根装配（与 buildPersistence / buildSessionStack 同列）。
 *
 * T1.1 骨架：接线 port↔adapter（.kg per-project 连接由 KgDatabase 懒开，
 * projectRoot 在每次调用时传入——无需 daemon 启动期枚举项目）。
 * T2.1（AF-2）：CodegraphEnginePort 适配挂入（三级解析定格产物由组合根
 * 注入——HELIX_CODEGRAPH_PATH/PATH 的 env 读取收束于 container.ts，
 * AG-08 唯一例外面；resolve-codegraph 本体零 env 依赖）。
 * T2.2 到位后补全：KgSyncService（汇队列/去抖/单飞/fs-watch 接线）挂入
 * daemon 生命周期、container.ts 正式接线。
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
  return {
    writeService,
    store,
    graph,
    codegraphEngine,
    dispose: () => database.closeAll(),
  };
}
