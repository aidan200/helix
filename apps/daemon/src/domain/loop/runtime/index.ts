/**
 * runtime —— loop 域 L3 运行时层（helix-loop Phase 0a 四层拆分：本层
 * 预留占位，无实现）。
 *
 * Phase 2 落位内容（设计 §2.4）：LoopAgent（会话作用域运行时：跨 run
 * transcript 单写者 + steer/followUp 双队列 + 运行期配置面）、
 * InjectionQueue、AgentConfig。依赖单向：runtime → policy → kernel →
 * contracts。
 */
export {};
