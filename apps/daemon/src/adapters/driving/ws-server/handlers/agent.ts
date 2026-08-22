/**
 * agent 族命令处理（AD-1：case 体自 WsServerAdapter.routeCommand 机械迁出）。
 *
 * 机械迁移纪律（语义逐字节等价，diff 审查可逐行对照）：同 handlers/model.ts ——
 * case 体逐行搬移，仅做 `this.deps.X` → `ctx.X` 等机械代换，不改分支/字符串/
 * 回执时序。
 *
 * v0.1 编排命令（契约 §4；只转发不决策）：kill 终止链回
 * SchedulerService（错误模型：目标不存在/已终态 → connection.error 中文
 * 回执；正常路径回执 agent.killed 事件经事件流广播）；subscribe/unsubscribe
 * 实例订阅通路语义（§8-1，不过滤）。
 *
 * 仍在 driving adapter 内（TR-AD-1 分层不变，零新 port）：依赖面 =
 * AgentOrchestrationPort + EventStream + commandError 共享辅助，经
 * AgentCommandContext 由 WsServerAdapter 供出（handlers/context.ts，
 * 解环后承载）。
 */
import type { AgentCommandContext } from "./context";

/** agent.kill（终止 agent 实例）：失败 → connection.error；成功 ack = agent.killed 广播。 */
export function handleAgentKill(ctx: AgentCommandContext): void {
  if (typeof ctx.payload.agentId !== "string" || ctx.payload.agentId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.agentId 应为非空 string");
  }
  // 错误模型（契约 §4）：目标不存在/已终态 → connection.error 回执（中文说明）；
  // 正常路径回执 agent.killed 事件（经事件流广播，单一终态语义）
  const outcome = ctx.orchestration.kill(ctx.payload.agentId);
  if (!outcome.killed) {
    ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
  }
}

/** agent.subscribe（实例事件订阅；通路语义 §8-1 不过滤）。 */
export function handleAgentSubscribe(ctx: AgentCommandContext): void {
  const sender = ctx.ws.data.sender;
  if (typeof ctx.payload.agentId !== "string" || ctx.payload.agentId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.agentId 应为非空 string");
  }
  if (sender) ctx.events.subscribeInstance(sender, ctx.payload.agentId); // 通路语义（§8-1，不过滤）
}

/** agent.unsubscribe（实例事件退订；与 subscribe 对称）。 */
export function handleAgentUnsubscribe(ctx: AgentCommandContext): void {
  const sender = ctx.ws.data.sender;
  if (typeof ctx.payload.agentId !== "string" || ctx.payload.agentId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.agentId 应为非空 string");
  }
  if (sender) ctx.events.unsubscribeInstance(sender, ctx.payload.agentId);
}
