/**
 * thinking 族命令处理（thinking 批①，契约 v0.11 §17.11；handlers/model.ts
 * 同构先例——case 体一行转发、依赖面经 WsCommandContext 供出，零新 port）。
 *
 * thinking.set 的 ack = thinking.changed 广播（ModelService 内发，此处不经手），
 * 与 model.set 的 model.changed ack 形态逐字节同构。
 */
import type { WsCommandContext } from "./context";

/** thinking.set（会话作用域推理强度覆盖）：ack = thinking.changed 广播（契约 ①「即时 ack + 广播」）。 */
export function handleThinkingSet(ctx: WsCommandContext): void {
  // 会话作用域命令：信封 sessionId（per-session）；缺省回退当前会话（model.set 同构）
  const sid = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  if (typeof ctx.payload.level !== "string" || ctx.payload.level.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.level 应为非空 string（pi-ai ThinkingLevel 字符串透传）");
  }
  // ack = thinking.changed 广播（ModelService 内发；订阅该会话的连接即时收到
  // override/effective——契约 ①，model.set 先例不动）
  void ctx.model
    .setThinking(sid ?? ctx.system.getStatus().sessionId, ctx.payload.level)
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}
