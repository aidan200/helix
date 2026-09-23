import type {
  ConfigGetCompactionResultEvent,
  ConfigSetCompactionResultEvent,
  ConfigGetSchedulingResultEvent,
  ConfigSetSchedulingResultEvent,
  ConfigGetPortResultEvent,
  ConfigSetPortResultEvent,
  ConfigGetSandboxResultEvent,
  ConfigSetSandboxResultEvent,
  ConfigGetTopicResultEvent,
  ConfigSetTopicResultEvent,
  ConfigTopicStatePayload,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { WsCommandContext } from "./context";

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
    .catch((err: Error) => ctx.commandError(ctx.type, "command.invalid_payload", err.message));
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
    .catch((err: Error) => ctx.commandError(ctx.type, "command.invalid_payload", err.message));
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
    .catch((err: Error) => ctx.commandError(ctx.type, "command.invalid_payload", err.message));
}

/** config.get_sandbox：沙箱开关读面（点对点回执）。 */
export function handleConfigGetSandbox(ctx: WsCommandContext): void {
  if (ctx.sandboxConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（sandboxConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: ConfigGetSandboxResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_sandbox.result",
    payload: { enabled: ctx.sandboxConfig.current().enabled, extraRoots: ctx.sandboxConfig.current().extraRoots },
  };
  ctx.sendNow(sender, frame);
}

/** config.set_sandbox：沙箱配置写面（点对点回执；新会话/新任务生效）。
 * 部分更新语义：enabled/extraRoots 任选至少一项，未携带项保留现值合并写。 */
export function handleConfigSetSandbox(ctx: WsCommandContext): void {
  if (ctx.sandboxConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（sandboxConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const enabled = ctx.payload.enabled;
  const extraRoots = ctx.payload.extraRoots;
  if (enabled === undefined && extraRoots === undefined) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled / payload.extraRoots 至少携带一项");
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled 应为 boolean");
  }
  if (extraRoots !== undefined && (!Array.isArray(extraRoots) || !extraRoots.every((r) => typeof r === "string"))) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.extraRoots 应为 string[]");
  }
  const cur = ctx.sandboxConfig.current();
  const next = {
    enabled: enabled ?? cur.enabled,
    extraRoots: extraRoots ?? cur.extraRoots,
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
    .catch((err: Error) => ctx.commandError(ctx.type, "command.invalid_payload", err.message));
}

// ── config.topic 族（动态主题批；部分更新语义：携带项写入，未携带项保留现值）──

/** judge 端点清单组装（get/set 回执共用：id + 显示名）。 */
function topicJudgeEndpoints(ctx: WsCommandContext): readonly ConfigTopicStatePayload["judgeEndpoints"][number][] {
  if (ctx.topicJudgeEndpoints === undefined) return [];
  return ctx.topicJudgeEndpoints();
}

/** config.get_topic：动态主题配置读面（点对点回执；恒带分类端点清单）。 */
export function handleConfigGetTopic(ctx: WsCommandContext): void {
  if (ctx.topicConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（topicConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const c = ctx.topicConfig.current();
  const frame: ConfigGetTopicResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_topic.result",
    payload: {
      enabled: c.enabled,
      model: c.model,
      classifyEndpointId: c.classifyEndpointId,
      judgeEndpoints: topicJudgeEndpoints(ctx),
    },
  };
  ctx.sendNow(sender, frame);
}

/** config.set_topic：动态主题配置写面（点对点回执；部分更新合并写）。
 * 校验单点：classifyEndpointId 非空时必须指向清单内 classifier 端点
 *（分类判断恒开：null = 生成模型兼任判断，无端点也可用）。 */
export function handleConfigSetTopic(ctx: WsCommandContext): void {
  if (ctx.topicConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（topicConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const { enabled, model, classifyEndpointId } = ctx.payload;
  if (enabled === undefined && model === undefined && classifyEndpointId === undefined) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload 至少携带一项（enabled/model/classifyEndpointId）");
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled 应为 boolean");
  }
  if (model !== undefined && model !== null && typeof model !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.model 应为 string 或 null");
  }
  if (classifyEndpointId !== undefined && classifyEndpointId !== null && typeof classifyEndpointId !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.classifyEndpointId 应为 string 或 null");
  }
  const cur = ctx.topicConfig.current();
  const next = {
    enabled: enabled ?? cur.enabled,
    model: model === undefined ? cur.model : model === null || model === "" ? null : model,
    classifyEndpointId:
      classifyEndpointId === undefined ? cur.classifyEndpointId : classifyEndpointId === null || classifyEndpointId === "" ? null : classifyEndpointId,
  };
  const endpoints = topicJudgeEndpoints(ctx);
  if (next.classifyEndpointId !== null && !endpoints.some((e) => e.id === next.classifyEndpointId)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "classifyEndpointId 必须指向清单内分类端点（kind=classifier）");
  }
  void ctx.topicConfig
    .set(next)
    .then(() => {
      const frame: ConfigSetTopicResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_topic.result",
        payload: {
          state: {
            enabled: next.enabled,
            model: next.model,
            classifyEndpointId: next.classifyEndpointId,
            judgeEndpoints: endpoints,
          },
        },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err: Error) => ctx.commandError(ctx.type, "command.invalid_payload", err.message));
}
