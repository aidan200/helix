/**
 * TaskOrchestratorService 契约面（P2 体量门 ④ 轻拆批：自
 * TaskOrchestratorService.ts 机械迁出，零逻辑改动）。
 *
 * 归属理由：编排会话/实例/挂起恢复的**接缝类型**与组合根注入面
 * （TaskOrchestratorServiceDeps）是装配契约，变更节奏随接线层；编排循环
 * 力学（批次循环/机械收口/停摆）是另一面。公共 API 面不变：
 * TaskOrchestratorService.ts 原样 re-export 本文件导出类型，消费方零感知。
 */
import type { TaskStorePort, JobData } from "../../ports/outbound/TaskStorePort";
import type { TaskEnginePort } from "../../ports/inbound/TaskEnginePort";
import type { TaskSkillRegistryPort } from "../../ports/outbound/TaskSkillRegistryPort";
import type { AgentOrchestrationPort, SpawnOutcome } from "../../ports/inbound/AgentOrchestrationPort";
import type { ParkReason } from "../../../domain/events/DomainEvent";
import type { WorkLedgerService } from "./WorkLedgerService";

/** 编排会话驱动面（编排服务消费的最小接缝；生产实现 = pi 引擎装配，组合根注入）。 */
export interface OrchestratorSessionFace {
  /** 驱动一轮 run（含工具轮与注入 drain 轮；run 结束 resolve）。 */
  drive(prompt: string): Promise<void>;
  /** 运行中注入（turn 边界 drain；闲时注入由调用方改为 drive）。 */
  inject(text: string): void;
  /** 中断当前 run（stop 通路）。 */
  abort(): void;
}

/** 实例终态读面（closure 判据：state done=收口成功，failed/killed=收口失败）。 */
export type InstanceOutcomeFace = { readonly state: string; readonly summary?: string } | undefined;

/** 批次实例挂起请求结果（SchedulerService.park 结构面；拒绝附中文原因）。 */
export type BatchParkOutcome = { readonly parked: boolean; readonly error?: string };

/** 批次实例恢复结果（SchedulerService.resume 结构面；queued=true = 预算满排队恢复）。 */
export type BatchResumeOutcome = { readonly resumed: boolean; readonly queued?: boolean; readonly error?: string };

export interface TaskOrchestratorServiceDeps {
  readonly store: TaskStorePort;
  readonly taskEngine: TaskEnginePort;
  /** 台账读面窄结构（评审 low #54：只消费 isFullyResolved 硬判据 + getPlan
   *  前序摘要，不绑具体类——与 CoordinationService 的最小接缝风格一致）。 */
  readonly ledger: Pick<WorkLedgerService, "isFullyResolved" | "getPlan">;
  readonly skills: TaskSkillRegistryPort;
  /** 任务 skill 全文取数（kickoff 装配；组合根/测试注入）。 */
  readonly skillTextOf: (type: string) => Promise<string | undefined>;
  /**
   * 批次 SubAgent spawn 原面（调度器绑定：task:* 会话归属；占预算）。
   * 第三参 profileKind（D8 W-R6 分流产物：kg-bootstrap/kg-review →
   * subagent-kg-writer，其余 subagent-worker）透传 scheduler.spawn 登记。
   */
  readonly rawSpawn: (sessionId: string, task: string, profileKind?: string) => SpawnOutcome | Promise<SpawnOutcome>;
  /**
   * kg-bootstrap 硬闸（D2，批1）：默认 embedding 端点在场判据（全消费面
   *  resolveDefault 单点的窄投影；false = 向量面不可用）——kg-bootstrap
   *  任务开工前检查，缺席即任务失败并提示去配置（构建知识库必须有向量
   *  端点：节点向量化是基建单点依赖）。可选——测试/非 kg 场景不注入零影响。
   */
  readonly hasDefaultEmbeddingEndpoint?: () => boolean;
  /** 实例终态读面（调度器 status 映射）。 */
  readonly instanceOutcome: (agentId: string) => InstanceOutcomeFace;
  /** 在跑批次 SIGTERM（cancel 通路收口在调度器 kill）。 */
  readonly killInstance: (agentId: string) => void;
  /**
   * 批次实例挂起原语（⑤ 链 A：组合根接 scheduler.park——parkAll 消费，
   * reason=taskPause；协作式：指令经 steer 通道注入，PARK 确认上行后
   * 实例转 parked 释放预算）。
   */
  readonly parkInstance: (agentId: string, reason: ParkReason) => BatchParkOutcome;
  /**
   * parked 批次实例复活原语（⑤ 链 A：组合根接 scheduler.resume——resumeAll
   * 消费；同实例同会话续跑，预算满与重派同队排队恢复）。未挂起/终态实例
   * 拒绝（resumed=false）为良性——resumeAll 按批次行全量调用。
   */
  readonly resumeInstance: (agentId: string) => BatchResumeOutcome;
  /** 编排会话工厂（每任务一个；ports = 派批次 SubAgent 的任务绑定编排口）。 */
  readonly createSession: (jobId: string, orchestration: AgentOrchestrationPort) => OrchestratorSessionFace;
  /** plan 硬约束段全文（模板层硬约束——plan=enforced 任务派发面机械追加；段库 catalog 同源注入）。 */
  readonly planHardConstraint: string;
  /**
   * 任务报告目录解析（D6：kickoff 起跑信息携带——任务级汇总报告固定落点
   * <home>/reports/task:<jobId>，orchestrator 持 write 自己写不绕道汇总批次）；
   * 与 SubagentLauncher reportDirFor / ClosureRecorder reportsDirFor 同源同式
   * （paths.home/reports/<sessionId>，组合根注入）。
   */
  readonly reportsDirFor: (sessionId: string) => string;
  /**
   * job 终态提示面（W2-D R13：reap 终态任务时回调——组合根接 pending_sync
   * 扫描 + 用户提示广播；编排层挂点不进引擎，守 AD-10）。仅在循环被 reap
   * 时触发一次（cancel 走 stopOrchestrator 用户主动路径，不触发）；缺省不提示。
   * title = 任务标题机械字段（titleOf 同源；管家 notify title 用，非 UUID）。
   */
  readonly onJobTerminal?: (jobId: string, status: JobData["status"], title?: string) => void;
  /** 卡装配修复：info 面（驱动开始/完成可观测）+ warn 面（异常/重试链）。 */
  readonly logger?: { info(message: string): void; warn(message: string): void };
  /**
   * 推进检查延迟窗（毫秒，缺省 30s）：驱动收场后静置此刻仍无事件驱动才判
   * 死局（重驱/failJob）。测试注入短窗（50ms）确定性触发；生产缺省长窗——
   * 插行收场/装配轮间隙等合法短暂收场不被误杀。
   */
  readonly progressCheckDelayMs?: number;
}
