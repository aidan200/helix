import type { KgProjectRow } from "@helix/protocol";
import type { KgProjectRowView } from "../../../application/services/kg/KgProjectService";

/**
 * 项目行 DTO 映射（kg.projects / workspace.open.result 两处共用同一口径）。
 *
 * 落位（低危批）：属共享 DTO 映射族，收在 DtoMapper 侧（经 ./DtoMapper
 * barrel 消费）；此前定义在 handlers/kg.ts 而被 handlers/workspace.ts 反向
 * import——族间横向依赖，且与 session.ts 从 DtoMapper 取 historyPage 的
 * 既有口径不一致。纯函数、零 IO、只 import type（AG-12）。
 */
export function projectRowToDto(row: KgProjectRowView): KgProjectRow {
  return {
    name: row.name,
    path: row.path,
    status: row.status,
    ...(row.symbolCount !== undefined ? { symbolCount: row.symbolCount } : {}),
    ...(row.nodeCount !== undefined ? { nodeCount: row.nodeCount } : {}),
    ...(row.syncedAt !== undefined ? { syncedAt: row.syncedAt } : {}),
    ...(row.degradedNote !== undefined ? { degradedNote: row.degradedNote } : {}),
    // P0① 运行中标志：true 才携带（false/缺省省略——旧 shell 兼容零感知）
    ...(row.bootstrapRunning ? { bootstrapRunning: true } : {}),
    // 体检入口运行态同规：非终态 kg-review job 覆盖项目时携带
    ...(row.reviewRunning ? { reviewRunning: true } : {}),
    // code-review v1.5 体检区代码评审入口运行态同规
    ...(row.codeReviewRunning ? { codeReviewRunning: true } : {}),
    // P2 kg-triage 待办面裁决入口运行态同规
    ...(row.triageRunning ? { triageRunning: true } : {}),
  };
}
