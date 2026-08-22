/**
 * session 族命令处理（T3.2 AD-1：case 体自 WsServerAdapter.routeCommand 机械迁出）。
 *
 * 机械迁移纪律（语义逐字节等价，diff 审查可逐行对照）：同 handlers/model.ts ——
 * case 体逐行搬移，仅做 `this.deps.X` → `ctx.X`、`this.resolveTargetSession(
 * ws, envelope, type)` → `resolveTargetSession(ctx)`（随族迁入的模块内辅助）
 * 等机械代换，不改分支/字符串/回执时序。
 *
 * v0.2/v0.3 session 族（T2.1/T2.2，契约 B §1）：list/loadHistory/delete 全局
 * 命令 result 点对点回执；subscribe/unsubscribe per-session 订阅（信封
 * sessionId 路由，缺省当前会话 v0 兼容；重新订阅 = 重推该会话全量快照
 * AD-16）；快照盖章链留 WsServerAdapter，经上下文回调机械引用零行为差。
 *
 * 仍在 driving adapter 内（TR-AD-1 分层不变，零新 port）：依赖面 =
 * SessionDirectoryPort + EventStream 订阅面 + sessionStamp/snapshotFrame
 * 回调 + 3 个共享辅助，经 SessionCommandContext 由 WsServerAdapter 供出
 * （handlers/context.ts，F-8 解环后承载）。
 */
import type { SessionListResultEvent, SessionLoadHistoryResultEvent, ErrorCode } from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import { historyPage, HISTORY_PAGE_DEFAULT, HISTORY_PAGE_MAX } from "../DtoMapper";
import type { SessionCommandContext } from "./context";

/**
 * 会话作用域命令的目标会话解析（session.subscribe/unsubscribe 共用；自
 * WsServerAdapter 同名私有方法随族迁入）：信封 sessionId（v0.2 路由位）→
 * 缺省当前会话（v0/v0.1 兼容）；不存在（热/冷均无）→ connection.error
 * （session.not_found）。T2.2：冷会话经注册表懒加载后即为合法目标。
 */
async function resolveTargetSession(ctx: SessionCommandContext): Promise<string | undefined> {
  const sid =
    typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  try {
    return await ctx.directory.resolveTarget(sid);
  } catch (err) {
    ctx.commandError(ctx.type, "session.not_found", (err as Error).message);
    return undefined;
  }
}

/** session.subscribe（per-session 订阅 + 重推全量快照，快照恢复公式 AD-16）。 */
export function handleSessionSubscribe(ctx: SessionCommandContext): void {
  const sender = ctx.ws.data.sender;
  if (!sender) return;
  // v0.3（T2.2，契约 §2.1）：payload.tier 可选档位——缺省 full（既有语义
  // 不变，TR-AD-23① 可选参数带缺省语义）；目录外值回 invalid_payload
  const tierRaw = ctx.payload.tier;
  if (tierRaw !== undefined && tierRaw !== "full" && tierRaw !== "monitor") {
    return ctx.commandError(ctx.type, "command.invalid_payload", 'payload.tier 应为 "full" | "monitor"');
  }
  const tier: "full" | "monitor" = tierRaw === "monitor" ? "monitor" : "full";
  // v0.2（T2.1/T2.2）：per-session 订阅——信封 sessionId 指定目标会话；
  // v0 兼容：不带信封位 = 当前会话（缺省订阅语义不变）
  void resolveTargetSession(ctx).then((target) => {
    if (target === undefined) return; // 不存在会话：已回 connection.error
    ctx.events.subscribeSession(sender, target, tier);
    // 重新订阅 = 重推该会话全量快照（快照恢复公式，AD-16）
    // T5.1 热修：agentState/model 取目标会话 runtime（随视图同源组装），
    // 不经 system.getStatus()（全局最近活跃投影——多会话下 current 恒被
    // 后台流式会话锚定，盖目标会话快照即串台）
    void ctx.directory
      .getSessionView(target)
      .then((view) => {
        const stamp = ctx.sessionStamp(view);
        ctx.sendNow(sender, ctx.snapshotFrame(view, stamp.model, stamp.agentState));
      })
      .catch((err) => console.warn(`[ws] 订阅快照组装失败：${(err as Error).message}`));
  });
}

/** session.unsubscribe（对称 per-session 退订——与 subscribe 同一目标会话解析规则）。 */
export function handleSessionUnsubscribe(ctx: SessionCommandContext): void {
  const sender = ctx.ws.data.sender;
  // T2.1 定稿：对称 per-session 退订——与 subscribe 同一目标会话解析规则
  void resolveTargetSession(ctx).then((target) => {
    if (sender && target !== undefined) ctx.events.unsubscribeSession(sender, target);
  });
}

/** session.list（全局会话清单）：session.list.result 点对点回执。 */
export function handleSessionList(ctx: SessionCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.directory
    .listSessions()
    .then((sessions) => {
      const frame: SessionListResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID, // 全局命令结果：会话无关
        channel: "session",
        type: "session.list.result",
        payload: { sessions: sessions.map((s) => ({ ...s })) },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => console.warn(`[ws] session.list 处理失败：${(err as Error).message}`));
}

/** session.loadHistory（游标分页读历史）：session.loadHistory.result 点对点回执。 */
export function handleSessionLoadHistory(ctx: SessionCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  if (typeof ctx.payload.beforeEntryId !== "string" || ctx.payload.beforeEntryId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.beforeEntryId 应为非空 string");
  }
  const rawLimit = ctx.payload.limit;
  if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.limit 应为正整数");
  }
  const beforeEntryId = ctx.payload.beforeEntryId;
  const limit = rawLimit === undefined ? HISTORY_PAGE_DEFAULT : Math.min(rawLimit, HISTORY_PAGE_MAX);
  const target = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  void (async () => {
    try {
      const sessionId = await ctx.directory.resolveTarget(target);
      const view = await ctx.directory.getSessionView(sessionId);
      const page = historyPage(view, beforeEntryId, limit);
      const frame: SessionLoadHistoryResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId, // 目标会话归属
        channel: "session",
        type: "session.loadHistory.result",
        payload: { entries: page.entries, hasMore: page.hasMore, nextCursor: page.nextCursor },
      };
      ctx.sendNow(sender, frame);
    } catch (err) {
      // T1.5：判别改 err.code 码匹配（原 err.name 字符串比对；无 code 旧
      // 对象 → 兑底 session.invalid_cursor，与原非 NotFound 兑底等价）
      const code =
        (err as { code?: ErrorCode }).code === "session.not_found" ? "session.not_found" : "session.invalid_cursor";
      ctx.commandError(ctx.type, code, (err as Error).message);
    }
  })();
}

/** session.delete（删除会话）：回执 = list_changed{deleted} 广播（契约 B §1.4 ack 形态）。 */
export function handleSessionDelete(ctx: SessionCommandContext): void {
  const target = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  if (target === undefined) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "session.delete 信封 sessionId 必填");
  }
  void ctx.directory
    .deleteSession(target)
    .then(() => {
      // 删除回执 = list_changed{deleted} 广播（契约 B §1.4 ack 形态；
      // 取消/删库失败经 catch 回 error）
    })
    .catch((err) => {
      // 契约 B §1.4：取消失败或删库失败时 error（含 reason）；已知错误
      // 精确回码，其余（库删除失败等）以通用命令错误回执携带原因。
      // T1.5：判别改 err.code 码匹配（原 err.name 三元链；无 code 旧对象
      // → 兑底 command.invalid_payload，与原兑底等价）
      const errCode = (err as { code?: ErrorCode }).code;
      const code =
        errCode === "session.delete_in_progress"
          ? "session.delete_in_progress"
          : errCode === "session.not_found"
            ? "session.not_found"
            : "command.invalid_payload";
      ctx.commandError(ctx.type, code, (err as Error).message);
    });
}
