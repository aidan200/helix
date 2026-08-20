/**
 * chat 族命令处理（T3.2 AD-1：case 体自 WsServerAdapter.routeCommand 机械迁出）。
 *
 * 机械迁移纪律（语义逐字节等价，diff 审查可逐行对照）：同 handlers/model.ts ——
 * case 体逐行搬移，仅做 `this.deps.X` → `ctx.X` 等机械代换，不改分支/字符串/
 * 回执时序。
 *
 * chat.send 双路径（T2.2 AD-4 / T4）：①草稿建会话链——信封省略 sessionId +
 * payload.draft → daemon 建会话（零条目当前草稿直接转正复用同 id）+ 本连接
 * 订阅 + 快照回执（盖章链经上下文回调，快照盖新会话自身章 T5.1）；②既有
 * 会话发送——信封 sessionId 路由（缺省当前会话 v0 兼容）。
 * chat.steer：定向目标非运行中 → ChatService 抛 SteerTargetNotRunningError →
 * connection.error 点对点回执（T2.3/TR-AD-21）；chat.abort：只转发。
 *
 * 仍在 driving adapter 内（TR-AD-1 分层不变，零新 port）：依赖面 =
 * ChatPort + SessionDirectoryPort（草稿链）+ EventStream（建会话订阅）+
 * sessionStamp/snapshotFrame 回调 + 2 个共享辅助，经 ChatCommandContext 由
 * WsServerAdapter 供出（handlers/context.ts，F-8 解环后承载）。
 */
import type { ChatCommandContext } from "./context";

/** chat.send（发送消息；draft=true 且信封无 sessionId 时走草稿建会话链）。 */
export function handleChatSend(ctx: ChatCommandContext): void {
  if (typeof ctx.payload.text !== "string") return ctx.commandError(ctx.type, "command.invalid_payload", "payload.text 应为 string");
  // 草稿建会话链（契约 B §1.5 定稿 + T4 转正复用）：信封省略 sessionId
  // + payload.draft → daemon 建会话（零条目当前草稿直接转正复用同 id，
  // 否则新建；首条消息落库 + created 广播）+ 本连接订阅该会话 + 快照
  //（客户端据此切换）；draft 标记与显式 sessionId 同现时以 sessionId 为准。
  const hasSessionRoute =
    typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "";
  if (ctx.payload.draft === true && !hasSessionRoute) {
    const sender = ctx.ws.data.sender;
    // T4：payload.model 可选透传（建会话前用户选定模型；缺省 = 全局默认）
    const draftModel =
      typeof ctx.payload.model === "string" && ctx.payload.model !== "" ? ctx.payload.model : undefined;
    void ctx.directory
      .startDraftSession(ctx.payload.text, draftModel)
      .then(({ sessionId }) => {
        if (!sender) return;
        ctx.events.subscribeSession(sender, sessionId);
        return ctx.directory.getSessionView(sessionId).then((view) => {
          // T5.1：草稿快照盖新会话自身章（竞态窗口关闭：A 后台流式事件
          // 可在 register 后立即把 current 拉回 A，getStatus() 不可用作
          // per-session 帧盖章源）
          const stamp = ctx.sessionStamp(view);
          ctx.sendNow(sender, ctx.snapshotFrame(view, stamp.model, stamp.agentState));
        });
      })
      .catch((err) => {
        console.warn(`[ws] 草稿建会话失败：${(err as Error).message}`);
      });
    return;
  }
  // 既有会话发送：信封 sessionId 路由（缺省当前会话，v0 兼容）
  const sid = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  void ctx.chat.sendMessage(ctx.payload.text, sid).catch((err) => {
    console.warn(`[ws] chat.send 处理失败：${(err as Error).message}`);
  });
}

/** chat.steer（转向运行中实例；定向目标非运行中 → connection.error 点对点回执）。 */
export function handleChatSteer(ctx: ChatCommandContext): void {
  if (typeof ctx.payload.text !== "string") return ctx.commandError(ctx.type, "command.invalid_payload", "payload.text 应为 string");
  const sid = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  // T2.3（契约 v0.3 §3.2）：instanceId 只透传（路由判定归 ChatService，TR-AD-9）。
  // 回执裁决（T2.3，TR-AD-21）：定向目标非运行中 → ChatService 抛
  // SteerTargetNotRunningError → connection.error 点对点回执（同 agent.kill
  // 形态，复用 SendOutcome.detail 文案）；其余异常维持既有 console.warn。
  const instanceId =
    typeof ctx.payload.instanceId === "string" && ctx.payload.instanceId !== "" ? ctx.payload.instanceId : undefined;
  void ctx.chat.steer(ctx.payload.text, sid, instanceId).catch((err) => {
    if ((err as Error).name === "SteerTargetNotRunningError") {
      ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
      return;
    }
    console.warn(`[ws] chat.steer 处理失败：${(err as Error).message}`);
  });
}

/** chat.abort（中止当前轮/目标会话；只转发不决策）。 */
export function handleChatAbort(ctx: ChatCommandContext): void {
  const sid = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  ctx.chat.abort(sid);
}
