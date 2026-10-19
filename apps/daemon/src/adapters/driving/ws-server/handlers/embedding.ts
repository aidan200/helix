/**
 * embedding 配置域命令处理（管家记忆 B2 批；handlers/ 落位 = handlers/
 * auth.ts 点对点结果帧先例——只转发不决策，决策收口 EmbeddingConfigService
 * application 层）。
 *
 * 四命令（全局命令，channel = "embedding"、sessionId = SYSTEM_SESSION_ID）：
 * - embedding.list → 端点清单回执 embedding.list.result（凭据卫生视图）；
 * - embedding.set → 新增/更新 → 回执 embedding.list.result 新清单
 *   （invalid_payload：字段形态/空值/更新目标不存在）；
 * - embedding.delete → 删除 → 回执 embedding.list.result 新清单；
 * - embedding.verify → 连通测试 → 回执 embedding.verify.result 两判别
 *   （fail 是正常结果非 error——auth.verify 同构口径）。
 */
import type {
  EmbeddingListResultEvent,
  EmbeddingVerifyResultEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { EmbeddingCommandContext } from "./context";

/** 清单回执（list/set/delete/set_default 共用形态）。 */
function respondList(ctx: EmbeddingCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: EmbeddingListResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "embedding",
    type: "embedding.list.result",
    payload: {
      endpoints: ctx.embedding.service.listView().map((e) => ({ ...e })),
      // 批1：全局默认端点引用态透出（悬空/null = 向量面不可用）；
      // D1：默认分类端点同构透出（null = 判官缺席，消费面维持现状降级）
      defaultEndpointId: ctx.embedding.service.resolveDefaultRecord()?.id ?? null,
      defaultClassifierEndpointId: ctx.embedding.service.resolveDefaultRecord("classifier")?.id ?? null,
    },
  };
  ctx.sendNow(sender, frame);
}

/** embedding.list（全局命令）：端点清单读面。 */
export function handleEmbeddingList(ctx: EmbeddingCommandContext): void {
  respondList(ctx);
}

/** embedding.set（全局命令）：新增/更新端点 → 回执清单；invalid_payload 防御。 */
export function handleEmbeddingSet(ctx: EmbeddingCommandContext): void {
  const { id, name, baseUrl, apiKey, model, kind, variant } = ctx.payload;
  if (id !== undefined && (typeof id !== "string" || id === "")) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为非空 string（缺省 = 新增）");
  }
  // baseUrl 按 variant 条件必填：目录型（pi-ai）免填，直连型（jev 存量
  // 形态）仍必填——与 EmbeddingConfigService.set 同口径
  const requiredKeys: readonly string[] =
    variant === "pi-ai" ? ["name", "model"] : ["name", "baseUrl", "model"];
  for (const key of requiredKeys) {
    const v = ctx.payload[key];
    if (typeof v !== "string" || v.trim() === "") {
      return ctx.commandError(ctx.type, "command.invalid_payload", `payload.${key} 应为非空 string`);
    }
  }
  if (apiKey !== undefined && typeof apiKey !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.apiKey 应为 string（空串 = 清除）");
  }
  if (kind !== undefined && kind !== "embedding" && kind !== "classifier") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.kind 应为 \"embedding\" | \"classifier\"（缺省 = embedding）");
  }
  if (variant !== undefined && (typeof variant !== "string" || variant.trim() === "")) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.variant 应为非空 string（缺省 = jev 直连）");
  }
  void ctx.embedding.service
    .set({
      ...(id !== undefined ? { id } : {}),
      name: name as string,
      ...(baseUrl === undefined ? {} : { baseUrl: baseUrl as string }),
      model: model as string,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(variant !== undefined && variant !== "" ? { variant } : {}),
    })
    .then((outcome) => {
      if (!outcome.ok) {
        return ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
      }
      respondList(ctx);
    })
    .catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `embedding.set 执行失败：${(err as Error).message}`));
}

/** embedding.delete（全局命令）：删除端点 → 回执清单。 */
export function handleEmbeddingDelete(ctx: EmbeddingCommandContext): void {
  const { id } = ctx.payload;
  if (typeof id !== "string" || id === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为非空 string");
  }
  void ctx.embedding.service
    .delete(id)
    .then((outcome) => {
      if (!outcome.ok) {
        return ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
      }
      respondList(ctx);
    })
    .catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `embedding.delete 执行失败：${(err as Error).message}`));
}

/**
 * embedding.set_default（全局命令，批1；D1 泛化 kind 维度）：设置全局默认
 * 端点（kind 缺省 = embedding）→ 回执清单（defaultEndpointId /
 * defaultClassifierEndpointId 即时更新）。校验三拒（不存在 / kind 不吻合 /
 * 未 verify）→ invalid_payload（错误文本含定位）。
 */
export function handleEmbeddingSetDefault(ctx: EmbeddingCommandContext): void {
  const { id, kind } = ctx.payload;
  if (typeof id !== "string" || id === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为非空 string");
  }
  if (kind !== undefined && kind !== "embedding" && kind !== "classifier") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.kind 应为 \"embedding\" | \"classifier\"（缺省 = embedding）");
  }
  void ctx.embedding.service
    .setDefault(id, kind ?? "embedding")
    .then((outcome) => {
      if (!outcome.ok) {
        return ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
      }
      respondList(ctx);
    })
    .catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `embedding.set_default 执行失败：${(err as Error).message}`));
}

/** embedding.verify（全局命令）：连通测试 → 两判别回执（fail 是正常结果非 error）。 */
export function handleEmbeddingVerify(ctx: EmbeddingCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const { id } = ctx.payload;
  if (typeof id !== "string" || id === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为非空 string");
  }
  void ctx.embedding.service
    .verify(id)
    .then((result) => {
      // ok 分叉（TR-159 帧级纪律）：embedding → {kind,dim}；classifier →
      // {kind,prob}（判别联合，kind 判别位由服务层按端点用途给出——shell 侧
      // 按 kind 窄化取值，不再猜「字段存在性」）
      const payload: EmbeddingVerifyResultEvent["payload"] =
        result.state === "fail"
          ? { id, state: "fail", error: result.error }
          : result.kind === "classifier"
            ? { id, state: "ok", kind: "classifier", prob: result.prob }
            : { id, state: "ok", kind: "embedding", dim: result.dim };
      const frame: EmbeddingVerifyResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "embedding",
        type: "embedding.verify.result",
        payload,
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => {
      const frame: EmbeddingVerifyResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "embedding",
        type: "embedding.verify.result",
        payload: { id, state: "fail", error: (err as Error).message },
      };
      ctx.sendNow(sender, frame);
    });
}
