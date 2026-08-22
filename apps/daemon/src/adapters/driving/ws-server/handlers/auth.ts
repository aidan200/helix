/**
 * auth 管理族命令处理（AD-3：case 体自 WsServerAdapter.routeCommand 机械迁出）。
 *
 * 机械迁移纪律（语义逐字节等价，diff 审查可逐行对照）：同 handlers/model.ts ——
 * case 体逐行搬移，仅做 `this.deps.X` → `ctx.X` 等机械代换，不改分支/字符串/回执时序。
 *
 * v0.2 auth 管理族（AD-2，契约 C §1.3；真行为回口 + 结果帧）：4 命令均经
 * ModelPort 回口（authList/authSetKey/authDeleteKey/authVerify），结果帧
 * channel=model、sessionId=SYSTEM_SESSION_ID（全局管理命令，会话无关）。
 *
 * 仍在 driving adapter 内（TR-AD-1 分层不变，零新 port）；上下文契约复用
 * handlers/context.ts 的 WsCommandContext（解环上收；auth 族同经
 * ModelPort，依赖面一致）。
 */
import type {
  AuthDeleteKeyResultEvent,
  AuthListResultEvent,
  AuthSetKeyResultEvent,
  AuthVerifyResultEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { WsCommandContext } from "./context";

/** auth.list（provider 凭据清单）：auth.list.result 点对点回执。 */
export function handleAuthList(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.model
    .authList()
    .then((providers) => {
      const frame: AuthListResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "auth.list.result",
        payload: { providers: providers.map((p) => ({ ...p })) },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}

/** auth.set_key（写入 provider API key，掩码回执）：auth.set_key.result 点对点回执。 */
export function handleAuthSetKey(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  if (typeof ctx.payload.providerId !== "string" || ctx.payload.providerId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.providerId 应为非空 string");
  }
  if (typeof ctx.payload.apiKey !== "string" || ctx.payload.apiKey.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.apiKey 应为非空 string（空值 = 协议层 error，契约 C §1.3）");
  }
  void ctx.model
    .authSetKey(ctx.payload.providerId, ctx.payload.apiKey)
    .then((r) => {
      const frame: AuthSetKeyResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "auth.set_key.result",
        payload: { keyMasked: r.keyMasked },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}

/** auth.delete_key（删除 provider API key）：auth.delete_key.result 点对点回执（payload `{}`）。 */
export function handleAuthDeleteKey(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  if (typeof ctx.payload.providerId !== "string" || ctx.payload.providerId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.providerId 应为非空 string");
  }
  void ctx.model
    .authDeleteKey(ctx.payload.providerId)
    .then(() => {
      const frame: AuthDeleteKeyResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "auth.delete_key.result",
        payload: {}, // 契约 C §1.3：响应 `{}`（成功回执即帧本身）
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}

/** auth.verify（连通性验证）：auth.verify.result 点对点回执（fail 是正常结果非 error）。 */
export function handleAuthVerify(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  if (typeof ctx.payload.providerId !== "string" || ctx.payload.providerId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.providerId 应为非空 string");
  }
  void ctx.model
    .authVerify(ctx.payload.providerId)
    .then((r) => {
      const frame: AuthVerifyResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "auth.verify.result",
        payload: r.status === "ok" ? { status: "ok", latencyMs: r.latencyMs } : { status: "fail", reason: r.reason }, // fail 是正常结果非 error
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}
