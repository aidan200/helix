/**
 * shared/api/commands/workspace —— workspace 域（门禁读面 + 显式绑定写面）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  WorkspaceGetCommand,
  WorkspaceOpenCommand,
} from "@helix/protocol";

// ── workspace 族命令（W3 门禁；契约 PROTOCOL.md §15.10）──────────────
// 两命令均为全局命令（信封 sessionId 省略）；回执 = §16.10 点对点结果帧
//（workspace.get.result / workspace.open.result，SessionContext 转发层
// → entities/workspace 状态机消费）；校验/持久化全在 daemon 单点，前端
// 零重复实现（W3 门禁读/写面）。

/** workspace.get：门禁读面（无参；current 非 null → 主壳 / null → 选择页）。 */
export function workspaceGetCommand(): WorkspaceGetCommand {
  return { v: PROTOCOL_VERSION, type: "workspace.get", payload: {} };
}

/** workspace.open：显式绑定写面（daemon realpath 规范化 + 危险根校验）。 */
export function workspaceOpenCommand(root: string): WorkspaceOpenCommand {
  return { v: PROTOCOL_VERSION, type: "workspace.open", payload: { root } };
}
