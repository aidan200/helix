/**
 * shared/api/commands/chat —— 会话内对话面（chat.send 既有/草稿首条、chat.steer、chat.abort、ask.answer 裁决回填）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { DEFAULT_MODE_ID, PROTOCOL_VERSION } from "@helix/protocol";
import type {
  ChatAbortCommand,
  ChatSendCommand,
  ChatSteerCommand,
  ChatSteerPayload,
  AskAnswerCommand,
} from "@helix/protocol";

/** chat.send：既有会话发送（信封 sessionId = 活跃会话）。
 *  T9（v0.10）：images 可选——未传时省略（传空数组 [] 仍按携带出帧，
 *  additive 纪律：只判 undefined 不加空数组特判）。 */
export function chatSendCommand(text: string, sessionId: string, images?: readonly string[]): ChatSendCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "chat.send",
    sessionId,
    payload: images === undefined ? { text } : { text, images },
  };
}

/** chat.send 草稿首条消息：无信封 sessionId + draft:true（契约 B §1.5）。
 *  T3（bug4）：model 可选——**仅非空时携带**（ChatSendPayload.model?，仅
 *  draft:true 建会话链消费；缺省 = 全局默认不换模。空串与缺省同义：不发空
 *  model 键——daemon 侧不再需要空防御兜底）。
 *  T9（v0.10）：images 可选——三可选共存（draft + model + images）。
 *  P1 T4：mode 可选——仅非 default 携带（DEFAULT_MODE_ID 走协议缺省，
 *  减少帧噪音；建会话定格链消费，此后无写路径）。 */
export function chatSendDraftCommand(
  text: string,
  model?: string,
  images?: readonly string[],
  mode?: string,
): ChatSendCommand {
  const payload: ChatSendCommand["payload"] = { text, draft: true };
  if (model !== undefined && model !== "") payload.model = model; // 空串 = 未选模型（不携带，帧噪音最小）
  if (images !== undefined) payload.images = images;
  if (mode !== undefined && mode !== DEFAULT_MODE_ID) payload.mode = mode;
  return { v: PROTOCOL_VERSION, type: "chat.send", payload };
}

/** chat.steer：生成中注入（信封 sessionId = 活跃会话）。v0.3（契约 §3.1，
 *  CL-3）：instanceId 可选——携带 = 定向寻址目标 SubAgent 实例（抽屉 steer
 *  输入栏）；缺省 = 主实例（主 Composer 既有语义零变更，payload 不携带 key）。
 *  sessionId 可选（M9 收编草稿防御分支）：省略 = 信封不携带 sessionId
 * （daemon 解析当前会话——理论上生成中必有活跃会话，此为防御形态）。 */
export function chatSteerCommand(text: string, sessionId?: string, instanceId?: string): ChatSteerCommand {
  const payload: ChatSteerPayload = instanceId === undefined ? { text } : { text, instanceId };
  return sessionId === undefined
    ? { v: PROTOCOL_VERSION, type: "chat.steer", payload }
    : { v: PROTOCOL_VERSION, type: "chat.steer", sessionId, payload };
}

/** ask.answer：提权申请裁决（permission_request 批；信封 sessionId = 申请归属会话——
 *  会话作用域命令，daemon 按信封路由 AskService 单 pending 槽）。 */
export function askAnswerCommand(askId: string, approved: boolean, sessionId: string): AskAnswerCommand {
  return { v: PROTOCOL_VERSION, type: "ask.answer", sessionId, payload: { askId, approved } };
}

/** chat.abort：中断当前生成（信封 sessionId = 活跃会话）。 */
export function chatAbortCommand(sessionId: string): ChatAbortCommand {
  return { v: PROTOCOL_VERSION, type: "chat.abort", sessionId, payload: {} };
}
