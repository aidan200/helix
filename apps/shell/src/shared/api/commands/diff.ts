/**
 * shared/api/commands/diff —— diff 域（轮次 diff 详情查询，session 作用域）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  DiffGetCommand,
  DiffGetPayload,
} from "@helix/protocol";

// ── diff 族命令（T3+T4 diff 批；契约 PROTOCOL.md §15 diff 域）────────────

/** diff.get：轮次 diff 详情查询（session 作用域——信封 sessionId 必填；
 *  turnId 缺省 = 最近冻结轮 / live:true = 进行中轮实时视图；点对点回执
 *  diff.get.result 经 subscribeDiffFrames 转发）。 */
export function diffGetCommand(payload: DiffGetPayload, sessionId: string): DiffGetCommand {
  return { v: PROTOCOL_VERSION, type: "diff.get", sessionId, payload };
}
