/**
 * 编排主 agent 运行时启停出口端口（outbound，T1.3 新增）：
 * 任务引擎与编排运行时（T2.2 TaskOrchestratorService）的解耦面——引擎只
 * 持本 port，不感知编排会话装配/批次循环驱动的任何实现细节。
 *
 * 消费场景（engine 侧）：
 * - createTask 成功落行后 startOrchestrator（architecture §5.2：E→O 装配编排会话）；
 * - resume 与断点恢复同路径（paused→running + 重开编排）；
 * - recoverOnStartup 逐 running/pending job 调 start（§4.4）；
 * - cancel 调 stopOrchestrator（停 loop + 在跑批次 SIGTERM——kill 通路收口
 *   在实现侧，SubagentLauncher 先例；引擎只表达「停」语义）。
 *
 * 实现契约（T2.2 承诺）：
 * - startOrchestrator resolve 时机 = 编排会话装配完成、批次循环已启动
 *   （不等任务完成）；重复 start 同一 jobId 幂等（恢复与 resume 同路径）。
 * - **编排 agent 不占 SubAgent 预算**：编排 loop 是轻量循环，不经
 *   SchedulerService spawn（预算 maxConcurrent=3 只被批次 SubAgent 占用）。
 *
 * 本文件只有接口定义（AG-01）；T1.3 单测用内存 fake，T2.2 提供真实现。
 */

export interface TaskOrchestratorStarterPort {
  /** 装配编排会话并启动批次循环（skill + params + 冻结 stage 行 + 恢复现场）。 */
  startOrchestrator(jobId: string): Promise<void>;
  /** 停编排 loop + SIGTERM 在跑批次实例（cancel 通路）。 */
  stopOrchestrator(jobId: string): Promise<void>;
}
