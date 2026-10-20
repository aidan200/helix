/**
 * shared/api/commands/web —— web 域（CDP 浏览器连接状态读面 + 启停写面，全局命令）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  WebStartCommand,
  WebStatusCommand,
  WebStopCommand,
} from "@helix/protocol";

/** web.status：CDP 连接状态读面（全局命令；回执 = web.status.result 点对点）。 */
export function webStatusCommand(): WebStatusCommand {
  return { v: PROTOCOL_VERSION, type: "web.status", payload: {} };
}

/** web.stop：手动停止写面（全局命令；回执 = web.stop.result 点对点 +
 *  状态回 idle 经 web.status.changed 全局广播）。 */
export function webStopCommand(): WebStopCommand {
  return { v: PROTOCOL_VERSION, type: "web.stop", payload: {} };
}

/** web.start：显式启动写面（v0.9，T7；全局命令；回执 = web.start.result
 *  点对点 applied/skipped + 状态回流经 web.status.changed 全局广播）。 */
export function webStartCommand(): WebStartCommand {
  return { v: PROTOCOL_VERSION, type: "web.start", payload: {} };
}
