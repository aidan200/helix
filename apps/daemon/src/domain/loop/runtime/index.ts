/**
 * runtime —— loop 域 L3 运行时层（helix-loop Phase 2 落位；设计 §2.4/§6）。
 *
 * 会话作用域运行时：LoopAgent（跨 run transcript 单写者 + steer/followUp 双
 * 队列 + run 编排——followUp 接管/continueRun 断点续跑）+ InjectionQueue
 * （注入队列执行真相）。依赖单向：runtime → policy → kernel → contracts。
 */
export { InjectionQueue, injectionToMessage, DEFAULT_FOLLOW_UP_LIMIT } from "./InjectionQueue";
export type { LoopInjection, LoopInjectionPush } from "./InjectionQueue";
export { LoopAgent } from "./LoopAgent";
export type { LoopAgentDeps, LoopRunOptions, LoopRunPhase, LoopRunPrepContext, LoopRunSettledContext } from "./LoopAgent";
