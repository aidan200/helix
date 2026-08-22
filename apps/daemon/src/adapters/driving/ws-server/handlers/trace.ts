/**
 * trace 族命令处理（AD-1：case 体自 WsServerAdapter.routeCommand 机械迁出）。
 *
 * 机械迁移纪律（语义逐字节等价，diff 审查可逐行对照）：同 handlers/model.ts ——
 * case 体逐行搬移，仅做 `this.deps.X` → `ctx.X` 等机械代换，不改分支/字符串/
 * 回执时序；模块级函数 traceInstanceRecordToDto（domain 实例面板记录 → 协议
 * DTO）随 case 迁出（MainAgent 裁决），filterEcho 组帧随 case 体同迁。
 *
 * v0.4 trace 族（契约 v0.4 §1）：trace.query 直查
 * domain_events（连接私有读面）；目标会话在 payload.sessionId（信封位不消费
 * ——冷会话可查）；normalize 校验收口在本入口（§3.5b「调仓储前」，AG-12：
 * 本层对 domain 仅 type-only）；结果帧点对点回执（TR-AD-21，不经广播）。
 *
 * 仍在 driving adapter 内（TR-AD-1 分层不变，零新 port）：依赖面 =
 * TraceQueryPort（未装配 → command.unimplemented）+ 3 个共享辅助
 * （commandError / rawSender / sendNow），经 TraceCommandContext 由
 * WsServerAdapter 供出（handlers/context.ts 承载）。
 */
import type { TraceInstanceRecord, TraceQueryResultEvent } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";
// AG-12：ws-server 对 domain 仅 type-only——normalize 校验收口在 driven
// adapter 入口（architecture.md §3.5b「调仓储前」）
import type { TraceInstanceRecord as DomainInstanceRecord } from "../../../../domain/trace/TraceQuery";
import type { TraceCommandContext } from "./context";

/** trace.query（只读 domain_events）：trace.query.result 点对点回执（含 filterEcho 回显）。 */
export function handleTraceQuery(ctx: TraceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  if (ctx.traceQuery === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "trace 读面未装配");
  }
  // normalize 校验收口在 adapter 入口（§3.5b「调仓储前」；本层对 domain
  // 仅 type-only，AG-12）；校验失败 DomainError → 既有错误回帧模式。
  // 目标会话在 payload.sessionId（信封位不消费——直查 domain_events，冷会话可查）
  try {
    const result = ctx.traceQuery.queryTrace(ctx.payload);
    const filter = result.filter;
    const frame: TraceQueryResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: filter.sessionId, // 目标会话归属
      channel: "trace",
      type: "trace.query.result",
      payload: {
        // filterEcho：实际生效过滤条件回显（readonly → 帧侧可变拷贝）
        filterEcho: {
          sessionId: filter.sessionId,
          instanceIds: filter.instanceIds === null ? null : [...filter.instanceIds],
          agentKind: filter.agentKind,
          types: filter.types === null ? null : [...filter.types],
          timeRange: filter.timeRange === null ? null : { ...filter.timeRange },
          page: { ...filter.page },
        },
        instances: result.instances.map(traceInstanceRecordToDto),
        events: result.rows.map((row) => ({ ...row })),
        page: { loaded: result.rows.length, total: result.total, hasMore: result.hasMore },
      },
    };
    ctx.sendNow(sender, frame); // 点对点（TR-AD-21，不经广播）
  } catch (err) {
    ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
  }
}

/** domain 实例面板记录 → 协议 DTO（readonly 数组/对象转可变帧形态；逐字段直拷）。 */
function traceInstanceRecordToDto(record: DomainInstanceRecord): TraceInstanceRecord {
  return {
    instanceId: record.instanceId,
    agentKind: record.agentKind,
    profileKind: record.profileKind,
    ...(record.model !== undefined ? { model: record.model } : {}),
    status: record.status,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.task !== undefined ? { task: record.task } : {}),
    eventCount: record.eventCount,
    ...(record.snapshot !== undefined
      ? {
          snapshot: {
            systemPrompt: record.snapshot.systemPrompt,
            tools: [...record.snapshot.tools],
            model: record.snapshot.model,
            ...(record.snapshot.compaction !== undefined
              ? { compaction: { ...record.snapshot.compaction } }
              : {}),
            ...(record.snapshot.hooks !== undefined ? { hooks: [...record.snapshot.hooks] } : {}),
          },
        }
      : {}),
    snapshotMissing: record.snapshotMissing,
    ...(record.modelTimeline !== undefined
      ? { modelTimeline: record.modelTimeline.map((c) => ({ ...c })) }
      : {}),
    ...(record.currentModel !== undefined ? { currentModel: record.currentModel } : {}),
  };
}
