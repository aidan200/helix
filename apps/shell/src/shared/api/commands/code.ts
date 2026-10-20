/**
 * shared/api/commands/code —— code 域（代码评审任务发起面，code-review）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  CodeReviewCreateCommand,
  CodeReviewCreatePayload,
} from "@helix/protocol";

/** code.review.create：发起代码评审任务（code-review v1.5；准入从简——无索引门槛，允许反复发起）。 */
export function codeReviewCreateCommand(payload: CodeReviewCreatePayload): CodeReviewCreateCommand {
  return { v: PROTOCOL_VERSION, type: "code.review.create", payload };
}
