import type { Logger } from "../logging";
import type { HelixPaths } from "../paths";
import type { SessionRepositoryPort } from "../../application/ports/outbound/SessionRepositoryPort";
import type { TraceQueryPort } from "../../domain/trace/TraceQueryPort";
import { WriteQueue } from "../../adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../adapters/driven/sqlite-session/SqliteSessionRepository";
import { SqliteTraceQueryAdapter } from "../../adapters/driven/sqlite-session/SqliteTraceQueryAdapter";
import { DefaultModelStore } from "../../adapters/driven/sqlite-session/DefaultModelStore";
import { ResourceStateStore } from "../../adapters/driven/sqlite-session/ResourceStateStore";
import { DEFAULT_MODEL_ID } from "../../adapters/driven/pi-engine/model-provider";

/**
 * 装配函数 ① 持久化族（T2.2，architecture §4.2.1）：组合根的一部分
 * （AG-02④ 豁免面 infrastructure/assembly/**——允许 import 全部层、
 * new 具体实现的装配点）。成员：SQLite 单写队列 + 会话仓库 + trace
 * 只读面 + 默认模型表 + resource_state 差异行存储。
 */
export interface PersistenceStack {
  readonly writeQueue: WriteQueue;
  readonly repository: SessionRepositoryPort;
  readonly traceQuery: TraceQueryPort;
  readonly defaultModel: DefaultModelStore;
  readonly resourceState: ResourceStateStore;
}

export function buildPersistence(deps: { readonly paths: HelixPaths; readonly logger: Logger }): PersistenceStack {
  // ── 持久化（T1.8）：SQLite WAL + 单写队列（AG-06 唯一写通道；T2.2 分仓） ──
  const writeQueue = new WriteQueue(deps.paths.dbPath(), {
    onError: (error, job) => deps.logger.error(`落盘失败（${job.kind}）：${(error as Error).message}`),
  });
  const repository: SessionRepositoryPort = new SqliteSessionRepository(writeQueue);
  // T2.1（CL-5/F5.6，architecture.md §3.5b）：trace 读面 port 手工装配（AF-3：
  // 仓内无 container.bind，同式命名常量）；同库同表只读面，不经单写队列。
  const traceQuery: TraceQueryPort = new SqliteTraceQueryAdapter(writeQueue);
  const defaultModel = new DefaultModelStore(writeQueue, DEFAULT_MODEL_ID);
  const resourceState = new ResourceStateStore(writeQueue);
  return { writeQueue, repository, traceQuery, defaultModel, resourceState };
}
