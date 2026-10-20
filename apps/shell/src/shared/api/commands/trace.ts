/**
 * shared/api/commands/trace —— trace 域（会话历史事件查询，连接私有读面）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  TraceQueryCommand,
  TraceQueryPayload,
} from "@helix/protocol";

// ── trace 命令族（契约 v0.4 §1；T2.2 P-1 TracePage）────────

/** trace.query：会话历史事件查询（连接私有读面；信封 sessionId 位不消费，
 *  目标会话在 payload.sessionId；结果 = trace.query.result 点对点回执）。 */
export function traceQueryCommand(payload: TraceQueryPayload): TraceQueryCommand {
  return { v: PROTOCOL_VERSION, type: "trace.query", payload };
}
