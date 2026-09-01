import type { Logger } from "../logging";
import type { HelixPaths } from "../paths";
import type { SessionRepositoryPort } from "../../application/ports/outbound/SessionRepositoryPort";
import type { TraceQueryPort } from "../../domain/trace/TraceQueryPort";
import { WriteQueue } from "../../adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../adapters/driven/sqlite-session/SqliteSessionRepository";
import { SqliteTraceQueryAdapter } from "../../adapters/driven/sqlite-session/SqliteTraceQueryAdapter";
import { DefaultModelStore } from "../../adapters/driven/sqlite-session/DefaultModelStore";
import { DefaultThinkingStore } from "../../adapters/driven/sqlite-session/DefaultThinkingStore";
import { CompactionConfigStore } from "../../adapters/driven/sqlite-session/CompactionConfigStore";
import { RuntimeConfigStore } from "../../adapters/driven/sqlite-session/RuntimeConfigStore";
import { ResourceStateStore } from "../../adapters/driven/sqlite-session/ResourceStateStore";
import { DEFAULT_MODEL_ID } from "../../adapters/driven/pi-engine/model-provider";
import { DEFAULT_COMPACTION } from "../../adapters/driven/pi-engine/runtime/AgentProfile";

/**
 * 装配函数 ① 持久化族（architecture §4.2.1）：组合根的一部分
 * （AG-02④ 豁免面 infrastructure/assembly/**——允许 import 全部层、
 * new 具体实现的装配点）。成员：SQLite 单写队列 + 会话仓库 + trace
 * 只读面 + 运行时配置 KV + 默认模型包装 + resource_state 差异行存储。
 */
export interface PersistenceStack {
  readonly writeQueue: WriteQueue;
  readonly repository: SessionRepositoryPort;
  readonly traceQuery: TraceQueryPort;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly defaultModel: DefaultModelStore;
  readonly defaultThinking: DefaultThinkingStore;
  readonly compactionConfig: CompactionConfigStore;
  readonly resourceState: ResourceStateStore;
}

export function buildPersistence(deps: { readonly paths: HelixPaths; readonly logger: Logger }): PersistenceStack {
  // ── 持久化：SQLite WAL + 单写队列（AG-06 唯一写通道； 分仓） ──
  const writeQueue = new WriteQueue(deps.paths.dbPath(), {
    onError: (error, job) => deps.logger.error(`落盘失败（${job.kind}）：${(error as Error).message}`),
  });
  const repository: SessionRepositoryPort = new SqliteSessionRepository(writeQueue);
  // trace 读面 port 手工装配（architecture.md §3.5b）
  // 仓内无 container.bind，同式命名常量）；同库同表只读面，不经单写队列。
  const traceQuery: TraceQueryPort = new SqliteTraceQueryAdapter(writeQueue);
  // 运行时配置 KV（P1 T1：通用键值底座）+ 默认模型语义包装（KV 上第一个键
  // + builtin 兑底——消费面 DefaultModelPort 签名不变，只换存储底座）
  const runtimeConfig = new RuntimeConfigStore(writeQueue);
  const defaultModel = new DefaultModelStore(runtimeConfig, DEFAULT_MODEL_ID);
  // R7 全局兜底批：全局默认推理强度（KV 第二键；无 builtin 兜底——null = 未配置）
  const defaultThinking = new DefaultThinkingStore(runtimeConfig);
  // 压缩参数配置（KV 第三键；JSON 序列化；缺省回落 DEFAULT_COMPACTION）
  const compactionConfig = new CompactionConfigStore(runtimeConfig, DEFAULT_COMPACTION);
  const resourceState = new ResourceStateStore(writeQueue);
  return { writeQueue, repository, traceQuery, runtimeConfig, defaultModel, defaultThinking, compactionConfig, resourceState };
}
