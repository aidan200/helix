/**
 * WriteJob 类型面（WriteQueue 拆分，体量治理）：单写队列的 job 判别联合
 * ——入队载荷的形状声明（全部写语义注释随类型走，WriteQueue.apply 分支
 * 一一对应）。AG-06 语义不变：job 只是数据声明，零 SQL。
 */
import type { DomainEvent, InstanceClosurePayload } from "../../../domain/events/DomainEvent";
import type { PersistedDomainState } from "../../../application/ports/outbound/SessionRepositoryPort";
import type {
  BatchData,
  JobData,
  StageArtifact,
  StageData,
} from "../../../application/ports/outbound/TaskStorePort";
import type { JobStatus, StageStatus } from "../../../domain/task/types";

/** agent 维度默认值：v0 单 main 会话 agent（四维查询的 agent 维预留，AD-7）。 */
export const MAIN_AGENT_KIND = "main";

export interface WriteQueueOptions {
  /** 落盘失败上报（组合根接 logger；不抛出——写失败不阻断会话）。 */
  readonly onError?: (error: unknown, job: WriteJob) => void;
}

export type WriteJob =
  | { readonly kind: "event"; readonly event: DomainEvent; readonly agentKind: string }
  | { readonly kind: "state"; readonly state: PersistedDomainState }
  | {
      readonly kind: "agentLifecycle";
      readonly sessionId: string;
      readonly instanceId: string;
      readonly state: string;
    }
  | {
      /** O-5：closure 记录行（任务报告本体，SQLite 追加行）。 */
      readonly kind: "closureRecord";
      readonly sessionId: string;
      readonly agentId: string;
      readonly result: "done" | "failed" | "killed";
      readonly closure: InstanceClosurePayload;
      /** findings 文件指针（canonical：daemon 机械探测注入；文件缺 = null）。 */
      readonly findingsFile: string | null;
      readonly occurredAt: string;
    }
  | {
      /** O-5：reportPath 文件产物（markdown；TR-AD-13 同队列原子写）。 */
      readonly kind: "reportFile";
      readonly reportPath: string;
      readonly content: string;
    }
  | {
      /** 会话删除——六表按 session_id 清行（删除收口链的删库步；AD-4）。 */
      readonly kind: "deleteSession";
      readonly sessionId: string;
    }
  | {
      /** 通用运行时配置 KV upsert（runtime_config 表，无会话维——全局链；P1 T1）。 */
      readonly kind: "runtimeConfig";
      readonly key: string;
      readonly value: string;
    }
  | {
      /** MCP server 声明面整段替换（mcp_server 表，无会话维——全局链；
       *  config 瘦身批：同 job 先清后插（对齐 modelSlot 先例，崩溃窗口
       *  回落空表幂等可重建）；行 = name PK + config JSON + position。 */
      readonly kind: "mcpServersReplace";
      readonly rows: readonly { name: string; config: string; position: number }[];
    }
  | {
      /** 资源启停差异行 upsert（resource_state 全局表，无会话维——全局链）。 */
      readonly kind: "resourceState";
      readonly profileKind: string;
      readonly resourceType: string;
      readonly name: string;
      readonly enabled: boolean;
    }
  | {
      /** 清空某 (profile_kind, resource_type) 全部差异行（model 槽位 clear）。 */
      readonly kind: "clearResourceState";
      readonly profileKind: string;
      readonly resourceType: string;
    }
  | {
      /** model 槽位原子替换（先清该 kind 全部 model 行再插入新行，
       *  enabled 恒 1——model 型行不承载启停语义，删除行 = 未设）。 */
      readonly kind: "modelSlot";
      readonly profileKind: string;
      readonly model: string;
    }
  | {
      /** 通用槽位原子替换（thinking 批扩值：同 modelSlot 单行不变式，
       *  resourceType 参数化——先清该 (kind, resourceType) 全部行再插入，
       *  enabled 恒 1）。 */
      readonly kind: "slotValue";
      readonly profileKind: string;
      readonly resourceType: string;
      readonly name: string;
    }
  // ── 任务表域写点链（O-1：job/stage/batch；无会话维 → 全局链） ──
  | {
      /** job 行插入（createTask）。 */
      readonly kind: "taskJob";
      readonly job: JobData;
    }
  | {
      /** stage 行插入（createTask 定格阶段计划，AD-9①；此后冻结）。 */
      readonly kind: "taskStage";
      readonly stage: StageData;
    }
  | {
      /** job 状态迁移（守卫在 TaskStore 入队前；error 覆盖语义——null 清空）。 */
      readonly kind: "taskJobStatus";
      readonly id: string;
      readonly status: JobStatus;
      readonly error: string | null;
    }
  | {
      /** stage 状态迁移 + 可选 artifact 聚合落库（undefined = 不动既有值）。 */
      readonly kind: "taskStageStatus";
      readonly jobId: string;
      readonly seq: number;
      readonly status: StageStatus;
      readonly artifact?: StageArtifact;
    }
  | {
      /** batch 行插入（编排 agent 阶段内展开；seq 落盘闭包内原子赋予）。 */
      readonly kind: "taskBatchInsert";
      readonly batch: Omit<BatchData, "seq">;
    }
  | {
      /** batch 行整行替换（重试/实例派发——无状态守卫，语义在引擎 T1.3）。 */
      readonly kind: "taskBatchUpdate";
      readonly batch: BatchData;
    }
  | {
      /** 任务删除级联：清 job/stage/batch 三表 + 任务会话六表（domain_events/
       *  agent_lifecycle/closure_records/steer_queue/tool_calls/pending_sync——
       *  trace 会话详情与批次收口档案随任务同灭，会话维表与 deleteSession 同构）。 */
      readonly kind: "taskJobCascade";
      readonly jobId: string;
      /** 任务批次归属会话 id（task:<jobId>——引擎侧 taskSessionIdOf 算好传入）。 */
      readonly sessionId: string;
    }
  | {
      /** pending_sync upsert（W2-D R13/R22：闭环记录点——新变更
       *  changed_at 刷新 + notified 复位 0；会话仓 FIFO）。 */
      readonly kind: "pendingSync";
      readonly sessionId: string;
      readonly jobId: string | null;
      readonly changedAt: string;
    }
  | {
      /** pending_sync 置已提示（job 终态提示发出后置位；幂等）。 */
      readonly kind: "pendingSyncNotified";
      readonly sessionIds: readonly string[];
    };
