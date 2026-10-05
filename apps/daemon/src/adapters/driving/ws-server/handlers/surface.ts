/**
 * surface 族命令处理（M0 表面协议地基批；handlers/ 落位 = handlers/steward.ts
 * 先例——只转发不决策，决策收口 SurfaceRegistry application 层）。
 *
 * - surface.register → SurfaceRegistry.register（幂等覆盖 descriptor）→
 *   surface.registered 点对点回执（daemon 分配 connId 身份）；payload 校验：
 *   descriptor 经 isSurfaceDescriptor（kind ∈ 命名空间 + capabilities 非空
 *   动词清单）+ Registry 动词注册校验面（M2 D4——私造动词/命名空间越权
 *   抛错 → command.invalid_payload）；
 * - surface.unregister → Registry.unregister（对称语义；断连自动等效）；
 * - surface.event → Registry.observe 归一（surfaceId 盖章 + 词汇表校验 +
 *   投递观察者）；结构性非法回 command.invalid_payload；
 * - surface.action.result → Registry.receipt 销账（D7-1 seq 对账；未知 seq
 *   静默无害——迟到回执不报错）。
 */
import type { SurfaceRegisteredEvent } from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID, isSurfaceDescriptor, isSurfaceEventKind, isSurfaceEventOrigin } from "@helix/protocol";
import type { SurfaceCommandContext } from "./context";

/** surface.register：注册/自述 + 点对点回执 surface.registered。 */
export function handleSurfaceRegister(ctx: SurfaceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const descriptor = ctx.payload.descriptor;
  if (!isSurfaceDescriptor(descriptor)) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.descriptor 应为合法 SurfaceDescriptor（kind ∈ shell/browser/cli + capabilities 非空动词清单）",
    );
  }
  let reg;
  try {
    reg = ctx.surface.registry.register(sender, descriptor);
  } catch (err) {
    // 动词注册校验面（D4）：私造动词/命名空间越权——结构性非法回执
    return ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
  }
  const frame: SurfaceRegisteredEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "surface",
    type: "surface.registered",
    payload: { namespace: reg.namespace, connId: reg.connId },
  };
  ctx.sendNow(sender, frame);
}

/** surface.unregister：注销（幂等；断连自动等效）。 */
export function handleSurfaceUnregister(ctx: SurfaceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  ctx.surface.registry.unregister(sender);
}

/** surface.event：页面级事件上行归一（拒收面静默——遥测流量不回执对账）。 */
export function handleSurfaceEvent(ctx: SurfaceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const { kind, origin, page, detail } = ctx.payload;
  if (!isSurfaceEventKind(kind) || !isSurfaceEventOrigin(origin)) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.kind/origin 应在 surface 词汇表内（kind: activated/navigated/user_click/user_input/idle/error；origin: user/steward/system）",
    );
  }
  if (typeof page !== "string" || page === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.page 应为非空 string");
  }
  if (detail !== undefined && (typeof detail !== "object" || detail === null || Array.isArray(detail))) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.detail 应为 object");
  }
  ctx.surface.registry.observe(sender, {
    kind,
    origin,
    page,
    ...(detail !== undefined ? { detail: detail as Record<string, unknown> } : {}),
  });
}

/** surface.action.result：执行回执销账（D7-1；未知 seq 静默无害）。 */
export function handleSurfaceActionResult(ctx: SurfaceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const { seq, ok, detail } = ctx.payload;
  if (typeof seq !== "number" || !Number.isFinite(seq)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.seq 应为 number");
  }
  if (typeof ok !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.ok 应为 boolean");
  }
  ctx.surface.registry.receipt(sender, seq, ok, typeof detail === "string" ? detail : undefined);
}
