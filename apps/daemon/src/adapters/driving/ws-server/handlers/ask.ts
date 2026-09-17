import type { AskAnswerPayload } from "@helix/protocol";
import type { WsCommandContext } from "./context";

/**
 * ask.answer 命令处理：用户对越权执行申请（sandbox_request）的裁决。
 *
 * 裁决闭环 → AskService.answer（幂等容忍：无此挂起申请/已终态静默吞，
 * double-click 与超时竞态安全）。sessionId 取自信封（会话作用域命令）。
 * 未装配（askService 未注入）→ command.unimplemented（config 族先例）。
 */
export function handleAskAnswer(ctx: WsCommandContext): void {
  if (ctx.askService === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "ask 族命令未装配（askService）");
  }
  const p = ctx.payload as Partial<AskAnswerPayload>;
  const sessionId = ctx.envelope.sessionId;
  if (
    typeof sessionId !== "string" || sessionId.length === 0 ||
    typeof p.askId !== "string" || p.askId.length === 0 ||
    typeof p.approved !== "boolean"
  ) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "ask.answer 载荷非法（sessionId/askId/approved 必填）");
  }
  ctx.askService.answer(sessionId, p.askId, p.approved);
}
