/**
 * workspace 族命令处理（W1 绑定闭环；契约 = PROTOCOL.md §15.10/§16.10）。
 *
 * 先例 = handlers/kg.ts：sendNow 点对点结果帧（workspace.*.result，
 * TR-AD-21）+ commandError 错误回执（WORKSPACE_E_* 结构化错误码经
 * connection.error code 透传）。依赖面 = WorkspaceService（application
 * service，绑定状态机唯一事实源）：校验/持久化/幂等/活跃 agent 门禁全部
 * 归 service 单点，handler 只转发不决策。全局命令（信封 sessionId
 * 不消费）：结果帧 sessionId = SYSTEM_SESSION_ID、channel = "workspace"。
 */
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { WorkspaceGetResultEvent, WorkspaceOpenResultEvent } from "@helix/protocol";
import type { WorkspaceCommandContext } from "./context";
import { projectRowToDto } from "./kg";

/** workspace.get（门禁判定读面：current/recents/notice 快照）。 */
export function handleWorkspaceGet(ctx: WorkspaceCommandContext): void {
  const snap = ctx.workspace.get();
  const frame: WorkspaceGetResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "workspace",
    type: "workspace.get.result",
    payload: {
      current: snap.current === null ? null : { root: snap.current },
      recents: snap.recents.map((r) => ({
        root: r.root,
        name: r.name,
        lastUsedAt: r.lastUsedAt,
        valid: r.valid,
      })),
      ...(snap.notice !== undefined ? { notice: snap.notice } : {}),
    },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** workspace.open（显式绑定写面：校验→门禁→rebind→持久化→广播）。 */
export function handleWorkspaceOpen(ctx: WorkspaceCommandContext): void {
  if (typeof ctx.payload.root !== "string" || ctx.payload.root === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.root 应为非空 string");
  }
  void ctx.workspace
    .open(ctx.payload.root)
    .then((outcome) => {
      if (!outcome.ok) return ctx.commandError(ctx.type, outcome.error.code, outcome.error.message);
      const frame: WorkspaceOpenResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "workspace",
        type: "workspace.open.result",
        payload: { root: outcome.root, projects: outcome.projects.map(projectRowToDto) },
      };
      ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
    })
    .catch((err: unknown) => {
      // 意外异常兜底（service 契约面外）：不吞声不崩溃（trace.ts 同模式）
      ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
    });
}
