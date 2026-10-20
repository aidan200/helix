/**
 * shared/api/commands/surface —— surface 域（表面自述注册/注销、页面级事件上行、动作执行回执）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  SurfaceActionResultCommand,
  SurfaceDescriptor,
  SurfaceEventCommand,
  SurfaceEventUplinkPayload,
  SurfaceRegisterCommand,
  SurfaceUnregisterCommand,
} from "@helix/protocol";

// ── surface 族命令（M0 表面协议地基批）：注册/事件上行/动作回执 ──
// 全局命令（信封省略 sessionId——表面是连接级概念，E-84）；上行 = 表面→
// daemon（SurfaceRegistry 归一/路由/销账）。

/** surface.register：表面自述注册（幂等；回执 surface.registered 点对点）。 */
export function surfaceRegisterCommand(descriptor: SurfaceDescriptor): SurfaceRegisterCommand {
  return { v: PROTOCOL_VERSION, type: "surface.register", payload: { descriptor } };
}

/** surface.unregister：注销（断连自动等效）。 */
export function surfaceUnregisterCommand(): SurfaceUnregisterCommand {
  return { v: PROTOCOL_VERSION, type: "surface.unregister", payload: {} };
}

/** surface.event：页面级事件上行（感知开关默认 off——off 时 adapter 不发）。 */
export function surfaceEventCommand(payload: SurfaceEventUplinkPayload): SurfaceEventCommand {
  return { v: PROTOCOL_VERSION, type: "surface.event", payload };
}

/** surface.action.result：动作执行回执（D7-1 seq 对账；呈现即回）。 */
export function surfaceActionResultCommand(seq: number, ok: boolean, detail?: string): SurfaceActionResultCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "surface.action.result",
    payload: { seq, ok, ...(detail !== undefined ? { detail } : {}) },
  };
}
