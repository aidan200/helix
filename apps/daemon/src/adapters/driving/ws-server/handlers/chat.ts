/**
 * chat 族命令处理（AD-1：case 体自 WsServerAdapter.routeCommand 机械迁出）。
 *
 * 机械迁移纪律（语义逐字节等价，diff 审查可逐行对照）：同 handlers/model.ts ——
 * case 体逐行搬移，仅做 `this.deps.X` → `ctx.X` 等机械代换，不改分支/字符串/
 * 回执时序。
 *
 * chat.send 双路径（AD-4）：①草稿建会话链——信封省略 sessionId +
 * payload.draft → daemon 建会话（零条目当前草稿直接转正复用同 id）+ 本连接
 * 订阅 + 快照回执（盖章链经上下文回调，快照盖新会话自身章）；②既有
 * 会话发送——信封 sessionId 路由（缺省当前会话 v0 兼容）。
 * chat.steer：定向目标非运行中 → ChatService 抛 SteerTargetNotRunningError →
 * connection.error 点对点回执（TR-AD-21）；chat.abort：只转发。
 *
 * 仍在 driving adapter 内（TR-AD-1 分层不变，零新 port）：依赖面 =
 * ChatPort + SessionDirectoryPort（草稿链）+ EventStream（建会话订阅）+
 * sessionStamp/snapshotFrame 回调 + 2 个共享辅助，经 ChatCommandContext 由
 * WsServerAdapter 供出（handlers/context.ts， 解环后承载）。
 */
import type { ErrorCode } from "@helix/protocol";
import type { ChatCommandContext } from "./context";

/** chat.send（发送消息；draft=true 且信封无 sessionId 时走草稿建会话链）。 */
export function handleChatSend(ctx: ChatCommandContext): void {
  if (typeof ctx.payload.text !== "string") return ctx.commandError(ctx.type, "command.invalid_payload", "payload.text 应为 string");
  // 图片上行：payload.images 可选（string[] 形状防御；数量/格式/尺寸校验归
  // ChatService.sendMessage 入口统一校验，超限中文报错经 catch 通道可观测）
  const images = normalizeImages(ctx.payload.images);
  // 草稿建会话链（契约 B §1.5 定稿 + 转正复用）：信封省略 sessionId
  // + payload.draft → daemon 建会话（零条目当前草稿直接转正复用同 id，
  // 否则新建；首条消息落库 + created 广播）+ 本连接订阅该会话 + 快照
  //（客户端据此切换）；draft 标记与显式 sessionId 同现时以 sessionId 为准。
  const hasSessionRoute =
    typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "";
  if (ctx.payload.draft === true && !hasSessionRoute) {
    // W1 绑定闭环：会话创建依赖 workspace 绑定（toolCwd 基准 = 绑定 root）——
    // 未绑定拒绝并指引（门禁前端本不发，此为防御；stub 测试形态未装配
    // workspace 面时缺省视为已绑定，保持既有行为）。
    if (ctx.workspaceBound !== undefined && !ctx.workspaceBound()) {
      return ctx.commandError(ctx.type, "workspace.unbound", "请先选择工作空间（workspace.open）后再开始会话");
    }
    const sender = ctx.ws.data.sender;
    // payload.model 可选透传（建会话前用户选定模型；缺省 = 全局默认）
    const draftModel =
      typeof ctx.payload.model === "string" && ctx.payload.model !== "" ? ctx.payload.model : undefined;
    // payload.mode 可选透传（P1 T3：草稿态选定的会话模式——唯一设置入口；
    // string 非空透传，缺省/未知归 daemon 注册表消费单点 fallback default）
    const draftMode =
      typeof ctx.payload.mode === "string" && ctx.payload.mode !== "" ? ctx.payload.mode : undefined;
    void ctx.directory
      .startDraftSession(ctx.payload.text, draftModel, images, draftMode)
      .then(({ sessionId }) => {
        if (!sender) return;
        ctx.events.subscribeSession(sender, sessionId);
        return ctx.directory.getSessionView(sessionId).then((view) => {
          // 草稿快照盖新会话自身章（竞态窗口关闭：A 后台流式事件
          // 可在 register 后立即把 current 拉回 A，getStatus() 不可用作
          // per-session 帧盖章源）
          const stamp = ctx.sessionStamp(view);
          ctx.sendNow(sender, ctx.snapshotFrame(view, stamp.model, stamp.agentState));
        });
      })
        // ImageValidationError（数量/格式/尺寸/生成中带图）→ 点对点回执
        //（中文文案直达用户，不静默 console.warn 丢消息；判别改 err.code
        // 码匹配——additive，无 code 旧对象走既有 console.warn 兑底）
        .catch((err) => {
          if ((err as { code?: ErrorCode }).code === "command.invalid_payload") {
            ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
            return;
          }
          console.warn(`[ws] 草稿建会话失败：${(err as Error).message}`);
        });
      return;
  }
  // 既有会话发送：信封 sessionId 路由（缺省当前会话，v0 兼容）。非草稿链
  // 不消费 payload.mode（协议注释声明——建会话后锁定，无第二条写路径）。
  const sid = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  void ctx.chat.sendMessage(ctx.payload.text, sid, images).catch((err) => {
    // 图片校验错误 → connection.error 点对点回执（同 steer 目标非运行中先例；
    // 判别改 err.code 码匹配）
    if ((err as { code?: ErrorCode }).code === "command.invalid_payload") {
      ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
      return;
    }
    console.warn(`[ws] chat.send 处理失败：${(err as Error).message}`);
  });
}

/** 图片上行：payload.images 形状防御（非 string[] → undefined；逐项非 string 剔除）。 */
function normalizeImages(images: unknown): readonly string[] | undefined {
  if (!Array.isArray(images)) return undefined;
  const list = images.filter((i): i is string => typeof i === "string");
  return list.length > 0 ? list : undefined;
}

/** chat.steer（转向运行中实例；定向目标非运行中 → connection.error 点对点回执）。 */
export function handleChatSteer(ctx: ChatCommandContext): void {
  if (typeof ctx.payload.text !== "string") return ctx.commandError(ctx.type, "command.invalid_payload", "payload.text 应为 string");
  const sid = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  // instanceId 只透传（路由判定归 ChatService，TR-AD-9；契约 v0.3 §3.2）。
  // 回执裁决（TR-AD-21）：定向目标非运行中 → ChatService 抛
  // SteerTargetNotRunningError → connection.error 点对点回执（同 agent.kill
  // 形态，复用 SendOutcome.detail 文案）；其余异常维持既有 console.warn。
  const instanceId =
    typeof ctx.payload.instanceId === "string" && ctx.payload.instanceId !== "" ? ctx.payload.instanceId : undefined;
  void ctx.chat.steer(ctx.payload.text, sid, instanceId).catch((err) => {
    if ((err as { code?: ErrorCode }).code === "command.invalid_payload") {
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
