/**
 * 三方平台命令处理（三方平台批；handlers/ 落位 = handlers/embedding.ts
 * 点对点结果帧先例——只转发不决策，决策收口 CustomProviderService
 * application 层）。
 *
 * 三命令（全局命令，channel = "provider"、sessionId = SYSTEM_SESSION_ID）：
 * - provider.list → 平台清单回执 provider.list.result（key 状态投影视图）；
 * - provider.set → 新增/更新（按 id upsert）→ 回执 provider.list.result
 *   新清单（invalid_payload：字段形态/空值/id 冲突/超限）；
 * - provider.delete → 删除 → 回执 provider.list.result 新清单（默认模型
 *   防线拒绝 → invalid_payload 带引导）。
 *
 * key/verify 刻意不在本族：key 录入走 auth.set_key（自定义 provider 进
 * 合并目录后 assertProvider 自动放行），连通验证走 auth.verify。
 */
import type { ProviderListResultEvent } from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { ProviderCommandContext } from "./context";
import type { CustomProviderSetInput } from "../../../../application/services/CustomProviderService";

/** 清单回执（list/set/delete 共用形态）。 */
function respondList(ctx: ProviderCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: ProviderListResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "provider",
    type: "provider.list.result",
    payload: { providers: ctx.provider.service.listView().map((p) => ({ ...p })) },
  };
  ctx.sendNow(sender, frame);
}

/** provider.list（全局命令）：三方平台清单读面。 */
export function handleProviderList(ctx: ProviderCommandContext): void {
  respondList(ctx);
}

/** provider.set（全局命令）：新增/更新平台 → 回执清单；invalid_payload 防御。 */
export function handleProviderSet(ctx: ProviderCommandContext): void {
  const { id, name, api, thinkingFormat, baseUrl, models } = ctx.payload;
  if (typeof id !== "string" || id.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为非空 string（平台 id = 模型字符串前缀，如 volcengine-plan）");
  }
  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.name 应为非空 string（缺省 = id）");
  }
  if (api !== undefined && api !== "openai-completions" && api !== "anthropic-messages") {
    return ctx.commandError(ctx.type, "command.invalid_payload", 'payload.api 应为 "openai-completions" 或 "anthropic-messages"（缺省 openai-completions）');
  }
  if (thinkingFormat !== undefined && typeof thinkingFormat !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.thinkingFormat 应为字符串枚举（缺省 auto）");
  }
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.baseUrl 应为非空 string（兼容服务根）");
  }
  if (!Array.isArray(models) || models.length === 0) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.models 应为非空数组（模型清单行 {id,name?,contextWindow,maxTokens?,reasoning?,inputPrice?,outputPrice?}）");
  }
  void ctx.provider.service
    .set({
      id,
      ...(name !== undefined ? { name } : {}),
      ...(api !== undefined ? { api } : {}),
      ...(thinkingFormat !== undefined ? { thinkingFormat: thinkingFormat as CustomProviderSetInput["thinkingFormat"] } : {}),
      baseUrl,
      models,
    })
    .then((outcome) => {
      if (!outcome.ok) {
        return ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
      }
      respondList(ctx);
    })
    .catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `provider.set 执行失败：${(err as Error).message}`));
}

/** provider.delete（全局命令）：删除平台 → 回执清单；invalid_payload 防御。 */
export function handleProviderDelete(ctx: ProviderCommandContext): void {
  const { id } = ctx.payload;
  if (typeof id !== "string" || id === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为非空 string");
  }
  void ctx.provider.service
    .delete(id)
    .then((outcome) => {
      if (!outcome.ok) {
        return ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
      }
      respondList(ctx);
    })
    .catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `provider.delete 执行失败：${(err as Error).message}`));
}
