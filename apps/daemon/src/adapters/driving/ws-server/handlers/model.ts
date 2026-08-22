/**
 * model 族命令处理（AD-3：case 体自 WsServerAdapter.routeCommand 机械迁出）。
 *
 * 机械迁移纪律（语义逐字节等价，diff 审查可逐行对照）：
 * - case 体逐行搬移，仅做机械代换——`this.deps.X` → `ctx.X`、
 *   `this.helper(ws, …)` → `ctx.helper(…)`（ws 由上下文绑定）、
 *   `ws`/`payload`/`envelope`/`type` → `ctx.ws`/`ctx.payload`/`ctx.envelope`/`ctx.type`；
 *   case 尾 `return;` 落函数自然收尾；不改分支/字符串/回执时序。
 *
 * v0.2 model 族（AD-2，契约 C §1；真行为回口。微批：结果帧点对点回执）：
 * - model.set 的 ack 仍为 model.changed 广播（ModelService 内发，此处不经手）；
 * - 其余 5 命令结果经 *.result 结果帧 sendNow 直发（契约 C §2.2）。
 *
 * 仍在 driving adapter 内（TR-AD-1 分层不变，零新 port）：依赖面 = ModelPort
 * + system.getStatus() 缺省回退 + 4 个共享辅助（commandError / modelErrorCode
 * / rawSender / sendNow），经 WsCommandContext 由 WsServerAdapter 供出。
 * WsCommandContext 定义上收 handlers/context.ts（解环：纯 type
 * 搬移零运行时行为），本模块改向 import，不再构成回边环。
 */
import type {
  ModelCatalogRefreshResultEvent,
  ModelCatalogResultEvent,
  ModelGetDefaultResultEvent,
  ModelGetResultEvent,
  ModelSetDefaultResultEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { WsCommandContext } from "./context";

/** model.set（会话作用域换模）：ack = model.changed 广播（契约 C §1.1，微批不动）。 */
export function handleModelSet(ctx: WsCommandContext): void {
  // 会话作用域命令：信封 sessionId（per-session）；缺省回退当前会话（v0 兼容读）
  const sid = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  if (typeof ctx.payload.model !== "string" || ctx.payload.model.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.model 应为非空 string（\"provider/model-id\"）");
  }
  // ack = model.changed 广播（ModelService 内发；订阅该会话的连接即时收到
  // model/previous/effective——契约 C §1.1「即时 ack + 广播」，微批不动）
  void ctx.model
    .setModel(sid ?? ctx.system.getStatus().sessionId, ctx.payload.model)
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}

/** model.get（会话作用域读）：model.get.result 点对点回执。 */
export function handleModelGet(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const sid = typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== "" ? ctx.envelope.sessionId : undefined;
  const target = sid ?? ctx.system.getStatus().sessionId;
  void ctx.model
    .getModel(target)
    .then((info) => {
      const frame: ModelGetResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: target, // per-session 命令：目标会话归属（loadHistory.result 同构）
        channel: "model",
        type: "model.get.result",
        payload: { model: info.model, isDefault: info.isDefault, defaultModel: info.defaultModel },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}

/** model.catalog（全局目录快照）：model.catalog.result 点对点回执。 */
export function handleModelCatalog(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.model
    .catalog()
    .then((snapshot) => {
      const frame: ModelCatalogResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID, // 全局命令：会话无关（session.list.result 同构）
        channel: "model",
        type: "model.catalog.result",
        payload: {
          models: snapshot.models.map((m) => ({ ...m, cost: { ...m.cost } })),
          refreshedAt: snapshot.refreshedAt,
          source: snapshot.source,
        },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, "catalog_unreachable", (err as Error).message));
}

/** model.catalog_refresh（强制刷新目录）：model.catalog_refresh.result 点对点回执。 */
export function handleModelCatalogRefresh(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.model
    .catalogRefresh()
    .then((snapshot) => {
      const frame: ModelCatalogRefreshResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "model.catalog_refresh.result",
        payload: {
          models: snapshot.models.map((m) => ({ ...m, cost: { ...m.cost } })),
          refreshedAt: snapshot.refreshedAt,
          source: snapshot.source,
          degraded: [...snapshot.degraded], // 降级说明（单 provider 拉取失败明细）
        },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, "catalog_unreachable", (err as Error).message));
}

/** model.set_default（全局默认模型）：model.set_default.result 点对点回执。 */
export function handleModelSetDefault(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  if (typeof ctx.payload.model !== "string" || ctx.payload.model.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.model 应为非空 string（\"provider/model-id\"）");
  }
  void ctx.model
    .setDefault(ctx.payload.model)
    .then((r) => {
      const frame: ModelSetDefaultResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "model.set_default.result",
        payload: { previous: r.previous },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, ctx.modelErrorCode(err), (err as Error).message));
}

/** model.get_default（全局默认模型读）：model.get_default.result 点对点回执（同步直发）。 */
export function handleModelGetDefault(ctx: WsCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const r = ctx.model.getDefault();
  const frame: ModelGetDefaultResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "model.get_default.result",
    payload: { model: r.model },
  };
  ctx.sendNow(sender, frame);
}
