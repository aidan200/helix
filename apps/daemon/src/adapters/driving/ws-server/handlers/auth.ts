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
  AuthLoginPayload,
  AuthLoginResultEvent,
  AuthLogoutResultEvent,
  AuthNotifyEvent,
  AuthPromptEvent,
  AuthRespondPayload,
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

// ── §17.39 订阅登录族（pi-ai 订阅登录批：登录流编排回口 authLogin） ──

/**
 * auth.login（发起登录流程）：交互推送 auth.prompt/auth.notify（点对点
 * 发起连接），成功回 auth.login.result；流程失败/中止回 commandError
 *（modelErrorCode 映射；中止 = 用户 auth.cancel 发起，终态同此回执）。
 */
export function handleAuthLogin(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  if (ctx.authLogin === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "登录流程未装配（authLogin）");
  }
  const p = ctx.payload as Partial<AuthLoginPayload>;
  if (typeof p.providerId !== "string" || p.providerId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.providerId 应为非空 string");
  }
  const providerId = p.providerId;
  const type = p.type ?? "oauth";
  if (type !== "api_key" && type !== "oauth") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.type 应为 \"api_key\" | \"oauth\"");
  }
  void ctx.authLogin
    .login(providerId, type, {
      prompt: (input) => {
        const frame: AuthPromptEvent = {
          v: PROTOCOL_VERSION,
          sessionId: SYSTEM_SESSION_ID,
          channel: "model",
          type: "auth.prompt",
          payload: { providerId, requestId: input.requestId, prompt: input.prompt },
        };
        ctx.sendNow(sender, frame);
      },
      notify: (event) => {
        const frame: AuthNotifyEvent = {
          v: PROTOCOL_VERSION,
          sessionId: SYSTEM_SESSION_ID,
          channel: "model",
          type: "auth.notify",
          payload: { providerId, event },
        };
        ctx.sendNow(sender, frame);
      },
    })
    .then((r) => {
      const frame: AuthLoginResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "auth.login.result",
        payload: { providerId, credentialType: r.credentialType },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}

/**
 * auth.respond（登录交互 prompt 回填）：requestId 取自 auth.prompt 帧
 *（select 型回填 option id）。零回执（steward.interrupt 先例——登录继续
 * 由后续 auth.prompt/auth.login.result 承载）；未知 requestId 回
 * invalid_payload（竞态容忍：前端忽略即可）。
 */
export function handleAuthRespond(ctx: WsCommandContext): void {
  if (ctx.authLogin === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "登录流程未装配（authLogin）");
  }
  const p = ctx.payload as Partial<AuthRespondPayload>;
  if (typeof p.requestId !== "string" || p.requestId === "" || typeof p.value !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.requestId 应为非空 string、value 应为 string");
  }
  if (!ctx.authLogin.respond(p.requestId, p.value)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "requestId 不存在或已收口（竞态容忍：忽略即可）");
  }
}

/**
 * auth.cancel（中止进行中登录）：幂等（无流程静默收口）；零回执——
 * 终态经 auth.login 命令的 commandError 回执（「登录已取消」）。
 */
export function handleAuthCancel(ctx: WsCommandContext): void {
  if (ctx.authLogin === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "登录流程未装配（authLogin）");
  }
  const p = ctx.payload as { providerId?: unknown };
  if (typeof p.providerId !== "string" || p.providerId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.providerId 应为非空 string");
  }
  ctx.authLogin.cancel(p.providerId);
}

/**
 * auth.logout（登出清凭据）：auth.logout.result 回执 + auth.changed 广播
 *（服务层 onAuthChanged 出海）。幂等（无凭据也成功收口）。
 */
export function handleAuthLogout(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  if (ctx.authLogin === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "登录流程未装配（authLogin）");
  }
  const p = ctx.payload as { providerId?: unknown };
  if (typeof p.providerId !== "string" || p.providerId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.providerId 应为非空 string");
  }
  const providerId = p.providerId;
  void ctx.authLogin
    .logout(providerId)
    .then(() => {
      const frame: AuthLogoutResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "auth.logout.result",
        payload: {},
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}
