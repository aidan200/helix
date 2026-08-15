/**
 * 对话入口端口（inbound，architecture.md §3.4）。
 *
 * CLI 与 WS 两个 driving adapter 共用同一入口：收输入 → ChatService 编排
 * （判新轮次或 steer 注入 → 驱动 AgentEnginePort → 发领域事件）。
 * 本文件只有接口定义（port 铁律 AG-01：零实现）。
 */

/** sendMessage 的路由结果：开了新轮次，还是注入进了 steer 队列。 */
export type SendOutcome =
  | { readonly mode: "turn"; readonly turnId: string; readonly entryId: string }
  | { readonly mode: "steered"; readonly entryId: string };

export interface ChatPort {
  /**
   * 发送用户消息。空闲时开新轮次并驱动引擎（Promise 在本轮 run 结束时 resolve）；
   * 生成中自动转为 steer 注入（入队可观测，turn 边界 drain）。
   */
  sendMessage(text: string): Promise<SendOutcome>;
  /** 显式注入（要求正在运行中；空闲时是业务错误，走 sendMessage）。 */
  steer(text: string): Promise<{ entryId: string }>;
  /** 中断当前生成（abort 非销毁：会话仍可继续新消息）。空闲时幂等忽略。 */
  abort(): void;
}
