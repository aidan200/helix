/**
 * web 族命令处理（v0.7；契约 = PROTOCOL.md §15.7/§16.8）：
 * handlers/ 落位（agent.config 族 handlers/resource.ts 先例）。
 *
 * - web.status → BrowserPort.getStatus() + listTabs() 组装 DTO 块 →
 *   web.status.result 点对点结果帧（sendNow 直发发起连接，TR-AD-21 模式：
 *   不经 EventStream 广播）；
 * - web.stop → await BrowserPort.stop()（幂等；未连接安全 no-op）→
 *   web.stop.result {status:"applied"} 点对点回执。停止后的状态回流
 *  （回 idle）经组合根 onStatusChange → broadcastWebStatusChanged 广播
 *   链路自动发出，handler 不重复广播（单一事件源纪律）。
 * - web.start（v0.9 显式启动通路）→ await BrowserPort.connect()
 *   （幂等；已连接 no-op）→ web.start.result 点对点回执两判别：成功回
 *   {status:"applied"}；connect 抛错（未发现可用浏览器）回
 *   {status:"skipped", reason}（reason 透传 browser-discovery 中文错误，
 *   内含引导用户开 remote debugging 的说明）。状态回流同走广播链。
 *
 * DTO 映射（BrowserStatus/TabInfo → WebStatusPayload）落本模块
 * （webStatusPayloadOf 导出——组合根 onStatusChange 广播接线复用同一组装，
 * 查询回执与广播帧同形状同源）；仍在 driving adapter 内（TR-AD-1 分层
 * 不变）：依赖面经 WebCommandContext 由 WsServerAdapter 供出。
 */
import type {
  WebStartResultEvent,
  WebStartResultPayload,
  WebStatusPayload,
  WebStatusResultEvent,
  WebStopResultEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { BrowserPort } from "../../../../application/ports/outbound/BrowserPort";
import type { WebCommandContext } from "./context";

/**
 * BrowserPort 读面 → WebStatusPayload（协议 DTO）：getStatus 状态块 +
 * listTabs 受管 tab 清单。查询回执与变更广播共用本组装（同形状同源）。
 */
export function webStatusPayloadOf(browser: BrowserPort): WebStatusPayload {
  const status = browser.getStatus();
  return {
    state: status.state,
    ...(status.browser !== undefined ? { browser: { ...status.browser } } : {}),
    tabCount: status.tabCount,
    ...(status.error !== undefined ? { error: status.error } : {}),
    tabs: browser.listTabs().map((t) => ({ ...t })),
  };
}

/** web.status（全局读面）：web.status.result 点对点回执。 */
export function handleWebStatus(ctx: WebCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: WebStatusResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID, // 全局命令：会话无关（model.catalog.result 同构）
    channel: "web",
    type: "web.status.result",
    payload: webStatusPayloadOf(ctx.browser),
  };
  ctx.sendNow(sender, frame);
}

/** web.stop（全局写面）：stop() 执行 + applied 回执（状态回流经广播链）。 */
export function handleWebStop(ctx: WebCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const run = async (): Promise<void> => {
    await ctx.browser.stop(); // 幂等：关全部受管 tab → 断 CDP → 回 idle
    const frame: WebStopResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "web",
      type: "web.stop.result",
      payload: { status: "applied" },
    };
    ctx.sendNow(sender, frame);
  };
  void run().catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `web.stop 执行失败：${(err as Error).message}`));
}

/**
 * web.start（v0.9 全局写面，显式启动通路）：connect() 执行 + 两判别回执。
 * connect 抛错 = 未发现可用浏览器（非系统故障）——回 skipped + reason（透传
 * browser-discovery 中文错误，内含 remote debugging 引导），不走
 * commandError（后者语义 = 协议面 payload/命令错误，此处是业务结果）。
 * 状态回流（idle → connecting → connected/error）经广播链，handler 不重复发。
 */
export function handleWebStart(ctx: WebCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const run = async (): Promise<WebStartResultPayload> => {
    try {
      await ctx.browser.connect(); // 幂等：已连接 no-op
      return { status: "applied" };
    } catch (err) {
      return { status: "skipped", reason: (err as Error).message };
    }
  };
  void run().then((payload) => {
    const frame: WebStartResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "web",
      type: "web.start.result",
      payload,
    };
    ctx.sendNow(sender, frame);
  }).catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `web.start 执行失败：${(err as Error).message}`));
}
