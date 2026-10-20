import type {
  ConfigGetCompactionResultEvent,
  ConfigSetCompactionResultEvent,
  ConfigGetSchedulingResultEvent,
  ConfigSetSchedulingResultEvent,
  ConfigGetPortResultEvent,
  ConfigSetPortResultEvent,
  ConfigGetSandboxResultEvent,
  ConfigSetSandboxResultEvent,
  ConfigGetKgResultEvent,
  ConfigSetKgResultEvent,
  ConfigGetSummaryResultEvent,
  ConfigSetSummaryResultEvent,
  ConfigGetVoiceModelsResultEvent,
  ConfigSetVoiceModelsResultEvent,
  ConfigSetVoiceModelsPayload,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID, VOICE_MODEL_FIELDS } from "@helix/protocol";
import type { WsCommandContext } from "./context";
import { reportInternalFailure } from "./payload-guards";

/**
 * config 族命令处理（压缩参数/调度预算/WS 端口配置；全局命令，无会话
 * 归属）。依赖面 = WsCommandContext.compactionConfig/schedulingConfig/
 * portConfig（读/写面）+ 共享辅助。结果经 *.result 结果帧点对点回执
 * （model 族同构）。
 */

/** config.get_compaction：压缩参数读面（点对点回执）。 */
export function handleConfigGetCompaction(ctx: WsCommandContext): void {
  if (ctx.compactionConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（compactionConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const c = ctx.compactionConfig.current();
  const frame: ConfigGetCompactionResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_compaction.result",
    payload: { reserveTokens: c.reserveTokens, keepRecentTokens: c.keepRecentTokens },
  };
  ctx.sendNow(sender, frame);
}

/** config.set_compaction：压缩参数写面（点对点回执；非负整数校验）。 */
export function handleConfigSetCompaction(ctx: WsCommandContext): void {
  if (ctx.compactionConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（compactionConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const reserveTokens = ctx.payload.reserveTokens;
  const keepRecentTokens = ctx.payload.keepRecentTokens;
  if (
    typeof reserveTokens !== "number" ||
    typeof keepRecentTokens !== "number" ||
    !Number.isInteger(reserveTokens) ||
    !Number.isInteger(keepRecentTokens) ||
    reserveTokens < 0 ||
    keepRecentTokens < 0
  ) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.reserveTokens/keepRecentTokens 应为非负整数",
    );
  }
  void ctx.compactionConfig
    .set({ reserveTokens, keepRecentTokens })
    .then(() => {
      const frame: ConfigSetCompactionResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_compaction.result",
        payload: { reserveTokens, keepRecentTokens },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => reportInternalFailure(ctx, err));
}

/** config.get_scheduling：SubAgent 调度预算读面（点对点回执）。 */
export function handleConfigGetScheduling(ctx: WsCommandContext): void {
  if (ctx.schedulingConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（schedulingConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const b = ctx.schedulingConfig.current();
  const frame: ConfigGetSchedulingResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_scheduling.result",
    payload: { maxConcurrent: b.maxConcurrent, maxQueued: b.maxQueued },
  };
  ctx.sendNow(sender, frame);
}

/** config.set_scheduling：调度预算写面（点对点回执；校验与 domain 同口径）。 */
export function handleConfigSetScheduling(ctx: WsCommandContext): void {
  if (ctx.schedulingConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（schedulingConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const maxConcurrent = ctx.payload.maxConcurrent;
  const maxQueued = ctx.payload.maxQueued;
  if (
    typeof maxConcurrent !== "number" ||
    typeof maxQueued !== "number" ||
    !Number.isInteger(maxConcurrent) ||
    !Number.isInteger(maxQueued) ||
    maxConcurrent < 1 ||
    maxQueued < 0
  ) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.maxConcurrent 应为 ≥1 整数、maxQueued 应为 ≥0 整数",
    );
  }
  void ctx.schedulingConfig
    .set({ maxConcurrent, maxQueued })
    .then(() => {
      const frame: ConfigSetSchedulingResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_scheduling.result",
        payload: { maxConcurrent, maxQueued },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => reportInternalFailure(ctx, err));
}

/** config.get_port：WS 端口读面（点对点回执；含 argv 覆盖信息）。 */
export function handleConfigGetPort(ctx: WsCommandContext): void {
  if (ctx.portConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（portConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: ConfigGetPortResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_port.result",
    payload: {
      effectivePort: ctx.portConfig.effectivePort(),
      storedPort: ctx.portConfig.storedPort(),
      overriddenByArgv: ctx.portConfig.overriddenByArgv(),
    },
  };
  ctx.sendNow(sender, frame);
}

/** config.set_port：WS 端口写面（点对点回执；下次启动生效）。 */
export function handleConfigSetPort(ctx: WsCommandContext): void {
  if (ctx.portConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（portConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const port = ctx.payload.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.port 应为 0-65535 整数（0 = 随机端口；默认 7333）",
    );
  }
  void ctx.portConfig
    .setPort(port)
    .then(() => {
      const frame: ConfigSetPortResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_port.result",
        payload: { port },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => reportInternalFailure(ctx, err));
}

/** config.get_sandbox：沙箱开关读面（点对点回执）。 */
export function handleConfigGetSandbox(ctx: WsCommandContext): void {
  if (ctx.sandboxConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（sandboxConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  // 单次取值（低危批）：读面按调用时刻现拍，分三次 current() 在非原子读面下
  // 三字段可能来自不同快照（回执自相矛盾）。
  const current = ctx.sandboxConfig.current();
  const frame: ConfigGetSandboxResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_sandbox.result",
    payload: { enabled: current.enabled, extraRoots: current.extraRoots, autoApprove: current.autoApprove },
  };
  ctx.sendNow(sender, frame);
}

/** config.set_sandbox：沙箱配置写面（点对点回执；enabled/extraRoots 新会话/新任务生效，
 * autoApprove 运行期即热）。
 * 部分更新语义：enabled/extraRoots/autoApprove 任选至少一项，未携带项保留现值合并写。 */
export function handleConfigSetSandbox(ctx: WsCommandContext): void {
  if (ctx.sandboxConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（sandboxConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const enabled = ctx.payload.enabled;
  const extraRoots = ctx.payload.extraRoots;
  const autoApprove = ctx.payload.autoApprove;
  if (enabled === undefined && extraRoots === undefined && autoApprove === undefined) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled / payload.extraRoots / payload.autoApprove 至少携带一项");
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled 应为 boolean");
  }
  if (extraRoots !== undefined && (!Array.isArray(extraRoots) || !extraRoots.every((r) => typeof r === "string"))) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.extraRoots 应为 string[]");
  }
  if (autoApprove !== undefined && typeof autoApprove !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.autoApprove 应为 boolean");
  }
  const cur = ctx.sandboxConfig.current();
  const next = {
    enabled: enabled ?? cur.enabled,
    extraRoots: extraRoots ?? cur.extraRoots,
    autoApprove: autoApprove ?? cur.autoApprove,
  };
  void ctx.sandboxConfig
    .set(next)
    .then(() => {
      const frame: ConfigSetSandboxResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_sandbox.result",
        payload: next,
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => reportInternalFailure(ctx, err));
}

// ── config.kg 族（批2 WP-C「知识库」配置组：查重阈值——部分更新语义；
//    值域 [0,1] 写面类型闸，值语义读面单点裁决（非法/颠倒回退缺省对），
//    回执恒回生效值所见即所得；检索语义化批 additive 扩语义召回对
//    semanticTopK/semanticMinScore——同款类型闸 + 读面裁决）──

/** config.get_kg：知识库配置读面（点对点回执——查重阈值对 + 语义召回对）。 */
export function handleConfigGetKg(ctx: WsCommandContext): void {
  if (ctx.kgConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（kgConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const t = ctx.kgConfig.current();
  const frame: ConfigGetKgResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_kg.result",
    payload: { similarityWarn: t.warn, similarityDup: t.dup, semanticTopK: t.semanticTopK, semanticMinScore: t.semanticMinScore },
  };
  ctx.sendNow(sender, frame);
}

/** config.set_kg：查重阈值/语义召回写面（点对点回执；类型闸——有限数，值语义读面兑底）。 */
export function handleConfigSetKg(ctx: WsCommandContext): void {
  if (ctx.kgConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（kgConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const { similarityWarn, similarityDup, semanticTopK, semanticMinScore } = ctx.payload as {
    similarityWarn?: unknown;
    similarityDup?: unknown;
    semanticTopK?: unknown;
    semanticMinScore?: unknown;
  };
  if (
    similarityWarn === undefined &&
    similarityDup === undefined &&
    semanticTopK === undefined &&
    semanticMinScore === undefined
  ) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload 至少携带一项（similarityWarn/similarityDup/semanticTopK/semanticMinScore）",
    );
  }
  for (const [key, value] of [
    ["similarityWarn", similarityWarn],
    ["similarityDup", similarityDup],
    ["semanticTopK", semanticTopK],
    ["semanticMinScore", semanticMinScore],
  ] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      return ctx.commandError(ctx.type, "command.invalid_payload", `payload.${key} 应为有限数`);
    }
  }
  void ctx.kgConfig
    .set({
      ...(similarityWarn !== undefined ? { similarityWarn: similarityWarn as number } : {}),
      ...(similarityDup !== undefined ? { similarityDup: similarityDup as number } : {}),
      ...(semanticTopK !== undefined ? { semanticTopK: semanticTopK as number } : {}),
      ...(semanticMinScore !== undefined ? { semanticMinScore: semanticMinScore as number } : {}),
    })
    .then((t) => {
      const frame: ConfigSetKgResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_kg.result",
        payload: { similarityWarn: t.warn, similarityDup: t.dup, semanticTopK: t.semanticTopK, semanticMinScore: t.semanticMinScore },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => reportInternalFailure(ctx, err));
}

// ── config.summary 族（会话总结器独立化批①；部分更新语义：携带项写入，
//    未携带项保留现值）────────────────────────────────────────

/** 槽位校验（model/task.model：null/空串 = 清空回未配置态；非空须
 *  "provider/model-id" 形态——与管家对话模型槽位同口径）。 */
function validSlot(model: unknown): model is string | null {
  if (model === null) return true;
  if (typeof model !== "string") return false;
  const trimmed = model.trim();
  return trimmed === "" || /^[^/\s]+\/[^/\s]+$/.test(trimmed);
}

/** config.get_summary：总结配置读面（点对点回执——总结配置组现态）。 */
export function handleConfigGetSummary(ctx: WsCommandContext): void {
  if (ctx.summaryConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（summaryConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: ConfigGetSummaryResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_summary.result",
    payload: ctx.summaryConfig.current(),
  };
  ctx.sendNow(sender, frame);
}

/** config.set_summary：总结配置写面（点对点回执；部分更新合并写 + 类型闸。
 *  everyTurns 范围闸在写面前置（1-20 整数；值语义读面另有兜底）。 */
export function handleConfigSetSummary(ctx: WsCommandContext): void {
  if (ctx.summaryConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（summaryConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const { enabled, everyTurns, model, task } = ctx.payload as {
    enabled?: unknown;
    everyTurns?: unknown;
    model?: unknown;
    task?: unknown;
  };
  if (enabled === undefined && everyTurns === undefined && model === undefined && task === undefined) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload 至少携带一项（enabled/everyTurns/model/task）");
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled 应为 boolean");
  }
  if (everyTurns !== undefined && (!Number.isInteger(everyTurns) || (everyTurns as number) < 1 || (everyTurns as number) > 20)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.everyTurns 应为 1-20 的整数");
  }
  if (model !== undefined && !validSlot(model)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", 'payload.model 应为 "provider/model-id" 字符串或 null（空串 = 清空槽位）');
  }
  let taskPatch: { enabled?: boolean; model?: string | null } | undefined;
  if (task !== undefined) {
    if (typeof task !== "object" || task === null) {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.task 应为 object");
    }
    const t = task as { enabled?: unknown; model?: unknown };
    if (t.enabled !== undefined && typeof t.enabled !== "boolean") {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.task.enabled 应为 boolean");
    }
    if (t.model !== undefined && !validSlot(t.model)) {
      return ctx.commandError(ctx.type, "command.invalid_payload", 'payload.task.model 应为 "provider/model-id" 字符串或 null（空串 = 清空槽位）');
    }
    taskPatch = {
      ...(t.enabled !== undefined ? { enabled: t.enabled as boolean } : {}),
      ...(t.model !== undefined ? { model: t.model as string | null } : {}),
    };
    if (Object.keys(taskPatch).length === 0) taskPatch = undefined;
  }
  void ctx.summaryConfig
    .set({
      ...(enabled !== undefined ? { enabled: enabled as boolean } : {}),
      ...(everyTurns !== undefined ? { everyTurns: everyTurns as number } : {}),
      ...(model !== undefined ? { model: model as string | null } : {}),
      ...(taskPatch !== undefined ? { task: taskPatch } : {}),
    })
    .then((state) => {
      const frame: ConfigSetSummaryResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_summary.result",
        payload: { state },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => reportInternalFailure(ctx, err));
}

// ── config.voice_models 族（ASR/TTS 模型配置接入 P0；部分更新语义：携带项
//    写入，未携带项保留现值；字段空串 = 回落默认值）────────────────

/** config.get_voice_models：语音模型配置读面（点对点回执——全量生效态，含默认值填充）。 */
export function handleConfigGetVoiceModels(ctx: WsCommandContext): void {
  if (ctx.voiceModelConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（voiceModelConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: ConfigGetVoiceModelsResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_voice_models.result",
    payload: ctx.voiceModelConfig.current(),
  };
  ctx.sendNow(sender, frame);
}

/** config.set_voice_models：语音模型配置写面（点对点回执；部分更新合并写 +
 *  类型闸：携带字段须 string（空串 = 回落默认值）；至少携带一项）。 */
export function handleConfigSetVoiceModels(ctx: WsCommandContext): void {
  if (ctx.voiceModelConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（voiceModelConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const patch: ConfigSetVoiceModelsPayload = {};
  let seen = false;
  for (const field of VOICE_MODEL_FIELDS) {
    const value = ctx.payload[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return ctx.commandError(ctx.type, "command.invalid_payload", `payload.${field} 应为 string（空串 = 回落默认值）`);
    }
    patch[field] = value;
    seen = true;
  }
  if (!seen) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      `payload 至少携带一项（${VOICE_MODEL_FIELDS.join("/")}）`,
    );
  }
  void ctx.voiceModelConfig
    .set(patch)
    .then((state) => {
      const frame: ConfigSetVoiceModelsResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_voice_models.result",
        payload: { state },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => reportInternalFailure(ctx, err));
}
