/**
 * steward 族命令处理（V2.5 文本管家批；handlers/ 落位 = handlers/voice.ts
 * 点对点结果帧先例——只转发不决策，决策收口 StewardService application 层）。
 *
 * - steward.ask → StewardService.ask（LLM 循环）→ 流式 steward.ask.delta
 *   增量帧（文本生成段逐 chunk，V2.5 体验批）+ steward.ask.result 点对点
 *   回执（answer / confirm_required / error 三判别——业务失败不回
 *   connection.error，结果帧 error 判别含引导，voice.synthesize 先例同构）；
 *   payload 校验：text 非空 string（≤2000 字符防御上限）；
 * - steward.confirm → StewardService.confirm（确认闸单次消费）→
 *   steward.confirm.result 点对点回执（ok/error）；
 * - steward.subscribe / steward.unsubscribe → EventStream 连接级 steward
 *   订阅位登记（feed 文本行闸门——零订阅连接 = 零推送）；
 * - steward.get_config / steward.set_config → 设置读写面 →
 *   steward.config.result 点对点回执。
 */
import type {
  StewardAskDeltaEvent,
  StewardAskResultEvent,
  StewardConfigResultEvent,
  StewardConfirmResultEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { StewardCommandContext } from "./context";

/** ask 文本防御上限（管家对话单轮；超长引导拆分）。 */
const ASK_TEXT_MAX = 2000;

/** steward.ask（全局命令）：对话一轮 + 流式增量帧 + 点对点回执（三判别）。 */
export function handleStewardAsk(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const text = ctx.payload.text;
  if (typeof text !== "string" || text.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.text 应为非空 string");
  }
  if (text.length > ASK_TEXT_MAX) {
    return ctx.commandError(ctx.type, "command.invalid_payload", `payload.text 超长（≤${ASK_TEXT_MAX} 字符）`);
  }
  // 流式增量帧（V2.5 体验批）：文本生成段逐 chunk 点对点下发（seq 单 ask 内
  // 1 起单调）；终态 result 权威覆盖——前端以 result 文本替换聚合缓冲。
  let deltaSeq = 0;
  const onDelta = (chunk: string): void => {
    if (chunk === "") return;
    deltaSeq += 1;
    const frame: StewardAskDeltaEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "steward",
      type: "steward.ask.delta",
      payload: { delta: chunk, seq: deltaSeq },
    };
    ctx.sendNow(sender, frame);
  };
  void ctx.steward.service
    .ask(text, onDelta)
    .then((payload) => {
      const frame: StewardAskResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "steward",
        type: "steward.ask.result",
        payload,
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => {
      // 服务层已收口业务失败为 error 判别；此处防御未知异常（不静默）
      const frame: StewardAskResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "steward",
        type: "steward.ask.result",
        payload: { status: "error", reason: `管家执行异常：${(err as Error).message}` },
      };
      ctx.sendNow(sender, frame);
    });
}

/** steward.confirm（全局命令）：确认闸放行 + 点对点回执（ok/error）。 */
export function handleStewardConfirm(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const actionId = ctx.payload.actionId;
  if (typeof actionId !== "string" || actionId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.actionId 应为非空 string");
  }
  void ctx.steward.service
    .confirm(actionId)
    .then((payload) => {
      const frame: StewardConfirmResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "steward",
        type: "steward.confirm.result",
        payload,
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => {
      const frame: StewardConfirmResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "steward",
        type: "steward.confirm.result",
        payload: { status: "error", reason: `确认闸执行异常：${(err as Error).message}` },
      };
      ctx.sendNow(sender, frame);
    });
}

/** steward.subscribe（全局命令）：事件 feed 连接级订阅登记。 */
export function handleStewardSubscribe(ctx: StewardCommandContext): void {
  ctx.steward.stream.subscribeSteward(ctx.ws.data.sender);
}

/** steward.unsubscribe（全局命令）：feed 退订（断连自动等效）。 */
export function handleStewardUnsubscribe(ctx: StewardCommandContext): void {
  ctx.steward.stream.unsubscribeSteward(ctx.ws.data.sender);
}

/** steward.get_config（全局命令）：设置读面 + steward.config.result 回执。 */
export function handleStewardGetConfig(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: StewardConfigResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "steward",
    type: "steward.config.result",
    payload: ctx.steward.service.getConfig(),
  };
  ctx.sendNow(sender, frame);
}

/** steward.set_config（全局命令）：设置写面 + 新态回执；格式非法 → invalid_payload。 */
export function handleStewardSetConfig(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const { enabled, model } = ctx.payload;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled 应为 boolean");
  }
  if (model !== undefined && typeof model !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.model 应为 string");
  }
  void ctx.steward.service
    .setConfig({ ...(enabled !== undefined ? { enabled } : {}), ...(model !== undefined ? { model } : {}) })
    .then((outcome) => {
      if (!outcome.ok) {
        return ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
      }
      const frame: StewardConfigResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "steward",
        type: "steward.config.result",
        payload: ctx.steward.service.getConfig(),
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) =>
      ctx.commandError(ctx.type, "command.invalid_payload", `steward.set_config 执行失败：${(err as Error).message}`),
    );
}
