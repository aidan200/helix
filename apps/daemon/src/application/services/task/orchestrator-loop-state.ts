/**
 * 编排循环态与注入文案（P2 体量门 ④ 轻拆批：自 TaskOrchestratorService.ts
 * 机械迁出，零逻辑改动）。
 *
 * 归属理由：LoopState 是单任务循环的**内存态形状**（会话 + 派发 brief 登记
 * 簿 + 位标记），与编排器注入文案（恢复/推进检查）同属「循环运行期词汇」，
 * 与契约面（orchestrator-contract.ts）和编排力学分开维护。内部模块边界
 * 面：仅供编排服务与本目录内模块消费，不经 TaskOrchestratorService 对外
 * 暴露。
 */
import type { OrchestratorSessionFace } from "./orchestrator-contract";

/** 单任务编排循环态（会话 + 派发 brief 登记簿 + 驱动中标记）。 */
export interface LoopState {
  readonly jobId: string;
  readonly session: OrchestratorSessionFace;
  /** instanceId → 派发 brief（重派接力源；会话可丢弃，此簿随会话同寿）。 */
  readonly briefs: Map<string, string>;
  running: boolean;
  stopped: boolean;
  /**
   * 退避窗位（清单 #2.5：drive 异常 5s 重试等待期）：窗内会话实际空闲，
   * wake 走 inject 会注入非运行会话丢失（OrchestratorSessionFace 契约
   * ：81-83 声明闲时注入由调用方改为 drive）——置位期间 wake 暂存
   * stashedWakes，重试轮收口后回放（resume 回放同构）。
   */
  backingOff: boolean;
  /**
   * 链 A 挂起位（任务 pause 置位 / resume 清位）：置位期间 wake 只入
   * stashedWakes 暂存队列，不驱动编排器回合。编排器自身是 daemon 内会话
   * ——不需要子进程 PARK 协议（pause 时它通常在等批次 closure，无「回合中」
   * 挂起问题；恰逢回合中则当前 drive 自然收口后挂起生效）。
   */
  parked: boolean;
  /** 挂起期间暂存的唤醒（resume 时回放驱动编排器）。 */
  readonly stashedWakes: string[];
  /**
   * 失败停摆位（haltJob：failBatch 超限上浮 → job failed）：置位后不再
   * 驱动任何编排回合（wake 全丢）但保留收口落库（locate 放行）——在跑
   * 实例自然收口、排队实例已摘队，全部 in-flight 收口后循环自清
   * （reapDrained）。区别于 stopped 单用：stopped 循环收口被丢弃，drain
   * 循环收口照常落库（done 行保留，人工重试不重跑）。
   */
  drain: boolean;
  /**
   * 对账扫描防重入位（task-efd68911）：startOrchestrator/resume 与驱动回合
   * 结束点都触发 sweepBatches，异步并发双扫会双派——置位期间后续触发跳过
   * （failBatch running 断言兜底竞态，此处前置消解）。
   */
  sweeping: boolean;
  /**
   * 推进检查重驱位（task-efd68911 第二重事故）：编排会话收场且无在跑实例
   * 但任务存在未完批次/阶段 → 重驱一次提示推进；置位后再次检测仍此态 →
   * failJob 收口（有界：防网络持续断/LLM 持续不推进时永久 running）。界 =
   * 单次静置死局非全生命周期一次：批次收口（settleInstance 尾）复位——
   * 长任务每次实质推进后重获一次重驱机会。
   */
  progressRedriven: boolean;
  /** 推进检查定时器（收场后延迟窗；新收场重置，循环满退/停摆清理）。 */
  progressTimer?: ReturnType<typeof setTimeout>;
}

export const RESUME_NOTICE = "【恢复通知】任务已恢复（running）——按现场摘要与任务 skill SOP 续跑。";

/** 推进检查重驱文案（收场后无在跑实例 + 未完批次/阶段：提示 LLM 推进或收口——涵盖装配期零批次死局）。 */
export const PROGRESS_CHECK_NOTICE = [
  "【推进检查】驱动收场后系统检测：无在跑实例但任务存在未完批次/阶段。",
  "请按任务 skill SOP 与批次行现场继续推进：尚未划批的先划分批次并 task_insert_batch 落行；已划批的派发 pending 批次（agent_spawn 携带 batchId 即自动接线；仅补接线才单独 task_dispatch_batch）；聚合已收口阶段产物；或申报任务完成/失败。",
  "若无实质推进动作，系统将把任务失败收口（failJob）。",
].join("\n");

/** 推进检查延迟窗缺省（毫秒）：收场后静置此刻仍无事件驱动才判死局——插行收场/装配轮间隙等合法短暂收场不被误杀。 */
export const PROGRESS_CHECK_DELAY_MS = 30_000;
