/**
 * diff 族命令处理（T3+T4 轮次 diff 协议与 UI 闭环；diff.get 单命令族，
 * PROTOCOL-CHANGELOG.md §26）。
 *
 * 先例 = handlers/task.ts：unimplemented 门控（查询面未装配 →
 * command.unimplemented 回执不崩溃）+ requireString/optionalString 形状校验
 * （形状收口本入口）+ sendNow 点对点结果帧（diff.get.result——types/diff.ts
 * 窄化接口，不入 EVENT_TYPES 目录，契约 §0 计数纪律）。
 *
 * 会话作用域命令（信封 sessionId 必填，AD-4 路由位）：结果帧信封 sessionId
 * = 目标会话、channel = "session"，仅发发起连接（点对点，不经广播）。
 * external 条目 note = 外部变更粗估说明（人读文案直渲——task.syncHint 同规）。
 */
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { DiffFileDto, DiffGetResultEvent, ErrorCode, EventEnvelope } from "@helix/protocol";
import type { FrozenDiffFile } from "../../../../application/services/TurnDiffService";
import type { FrameSender } from "../EventStream";
import type { DiffCommandContext } from "./context";

/** external 条目备注（±粗估行说明——外部进程变更无精确原文）。 */
const EXTERNAL_NOTE = "外部进程变更（无精确原文，±行为粗估）";

/** 冻结行 → DTO（patch → diff 可选；external → note；agents 数组化）。 */
function fileToDto(f: FrozenDiffFile): DiffFileDto {
  return {
    path: f.path,
    status: f.status,
    adds: f.added,
    dels: f.removed,
    ...(f.patch !== null ? { diff: f.patch } : {}),
    ...(f.status === "external" ? { note: EXTERNAL_NOTE } : {}),
    agents: [...f.agents],
  };
}

function reply(ctx: DiffCommandContext, frame: DiffGetResultEvent): void {
  // 点对点结果帧不入 EventEnvelope 联合（目录外窄化接口——task 族先例）：
  // double-cast 经 EventFrame<unknown> 兼容面。
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame as unknown as EventEnvelope);
}

function fail(ctx: DiffCommandContext, code: ErrorCode, message: string): void {
  ctx.commandError(ctx.type, code, message);
}

function unimplemented(ctx: DiffCommandContext): void {
  fail(ctx, "command.unimplemented", `命令未装配：${ctx.type}`);
}

/** 可选字符串载荷字段（类型不符 → null = 报错已回执）。 */
function optionalString(ctx: DiffCommandContext, key: string): string | undefined | null {
  const raw = ctx.payload[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    fail(ctx, "command.invalid_payload", `载荷字段 ${key} 应为字符串`);
    return null;
  }
  return raw;
}

/** 可选布尔载荷字段（类型不符 → null = 报错已回执）。 */
function optionalBoolean(ctx: DiffCommandContext, key: string): boolean | undefined | null {
  const raw = ctx.payload[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    fail(ctx, "command.invalid_payload", `载荷字段 ${key} 应为布尔`);
    return null;
  }
  return raw;
}

/**
 * diff.get：轮次 diff 详情查询（turnId 缺省 = 最近冻结轮；live = true →
 * 进行中轮实时视图）。查询面异步（live 即时终读），回执 fire-and-forget。
 */
export function handleDiffGet(ctx: DiffCommandContext): void {
  const diff = ctx.diff;
  if (diff === undefined) return unimplemented(ctx);
  // 信封 sessionId 必填（session 作用域路由位——AD-4）
  const sid = ctx.envelope.sessionId;
  if (typeof sid !== "string" || sid === "") {
    return fail(ctx, "command.invalid_payload", "diff.get 为会话作用域命令，信封 sessionId 必填");
  }
  const turnId = optionalString(ctx, "turnId");
  if (turnId === null) return;
  const live = optionalBoolean(ctx, "live");
  if (live === null) return;
  const state = diff.stateOf(sid);
  if (state === undefined) {
    return fail(ctx, "command.invalid_payload", `会话不存在或未加载：${sid}`);
  }
  void diff.service
    .getTurnView(state, { ...(turnId !== undefined ? { turnId } : {}), ...(live !== undefined ? { live } : {}) })
    .then((view) => {
      if (view === null) {
        return fail(ctx, "command.invalid_payload", "无轮次 diff 数据（冷会话或 turnId 未命中）");
      }
      const frame: DiffGetResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: sid,
        channel: "session",
        type: "diff.get.result",
        payload: {
          files: view.files.map(fileToDto),
          summary: { adds: view.stats.added, dels: view.stats.removed },
          // v0.3.1 §27：回执携带轮相位（rehydrate 面：shell chip 灰态判定）
          turnId: view.turnId,
          phase: view.phase,
        },
      };
      reply(ctx, frame);
    })
    .catch((err: unknown) => {
      fail(ctx, "command.invalid_payload", `diff 查询失败：${(err as Error).message}`);
    });
}
