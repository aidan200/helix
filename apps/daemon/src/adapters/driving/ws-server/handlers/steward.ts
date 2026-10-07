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
  AgentStewardProfileGetResultEvent,
  StewardAskDeltaEvent,
  StewardAskResultEvent,
  StewardConfigResultEvent,
  StewardConfirmResultEvent,
  StewardHistoryResultEvent,
  StewardThinkingEvent,
  StewardToolEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { StewardCommandContext } from "./context";
import type { StewardAskEvents } from "../../../../application/steward/StewardService";

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
  // 过程帧（A1 工作记忆批）：单 ask 内 seq 单调 1 起——ask.delta 与
  // tool/thinking 共用同一计数器（帧序即到达序，WS 有序传输下前端直接拼接）
  let deltaSeq = 0;
  const nextSeq = (): number => {
    deltaSeq += 1;
    return deltaSeq;
  };
  const onDelta = (chunk: string): void => {
    if (chunk === "") return;
    const frame: StewardAskDeltaEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "steward",
      type: "steward.ask.delta",
      payload: { delta: chunk, seq: nextSeq() },
    };
    ctx.sendNow(sender, frame);
  };
  // thinking 段级（一个完成态块一帧——屏幕折叠显示用；TTS 零接入）
  const onThinking = (block: string): void => {
    if (block === "") return;
    const frame: StewardThinkingEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "steward",
      type: "steward.thinking",
      payload: { text: block, seq: nextSeq() },
    };
    ctx.sendNow(sender, frame);
  };
  const onToolStart = (name: string, argsSummary: string): void => {
    const frame: StewardToolEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "steward",
      type: "steward.tool",
      payload: { phase: "start", name, argsSummary, seq: nextSeq() },
    };
    ctx.sendNow(sender, frame);
  };
  const onToolEnd = (name: string, resultSummary: string): void => {
    const frame: StewardToolEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "steward",
      type: "steward.tool",
      payload: { phase: "end", name, resultSummary, seq: nextSeq() },
    };
    ctx.sendNow(sender, frame);
  };
  const events: StewardAskEvents = { onDelta, onThinking, onToolStart, onToolEnd };
  // L1 件二：排队路径的结果帧回执面（queued 确认帧由 ask promise 即发；
  // 轮次完成帧经此闭包直达原发起连接——与 promise 路径双轨不重复）。
  const deliverResult = (payload: import("@helix/protocol").StewardAskResultPayload): void => {
    const frame: StewardAskResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "steward",
      type: "steward.ask.result",
      payload,
    };
    ctx.sendNow(sender, frame);
  };
  void ctx.steward.service
    .ask(text, events, deliverResult)
    .then((payload) => {
      // 直接路径：promise 即结果（一帧）；排队路径：queued 确认帧（结果帧
      // 由 service 在轮次完成时经 deliverResult 另发——双帧双轨不重复）。
      deliverResult(payload);
    })
    .catch((err) => {
      // 服务层已收口业务失败为 error 判别；此处防御未知异常（不静默）
      deliverResult({ status: "error", reason: `管家执行异常：${(err as Error).message}` });
    });
}

/** steward.confirm（全局命令）：确认闸放行 + 点对点回执——**B1 两段式**：
 *  ①受理即回 confirm.result {status:"accepted", actionId}（handler 拿到
 *  promise 即发，不等执行体）；②执行完成帧 steward.action.completed
 *  {actionId, ok, detail} 经 onCompleted 闭包点对点发回本连接（成败两路
 *  均发）。旧 ok 判别（执行结果承载在 confirm.result）不再产出。 */
export function handleStewardConfirm(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const actionId = ctx.payload.actionId;
  if (typeof actionId !== "string" || actionId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.actionId 应为非空 string");
  }
  // ②段发送闭包（点对点——发回发起 confirm 的连接；设计稿 §3.4）
  const sendCompleted = (payload: import("@helix/protocol").StewardActionCompletedPayload): void => {
    const frame: import("@helix/protocol").StewardActionCompletedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "steward",
      type: "steward.action.completed",
      payload,
    };
    ctx.sendNow(sender, frame);
  };
  void ctx.steward.service
    .confirm(actionId, sendCompleted)
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
        payload: { status: "error", reason: `确认闸受理异常：${(err as Error).message}` },
      };
      ctx.sendNow(sender, frame);
    });
}

/** steward.cancel（全局命令；B1 两段式确认批）：确认卡作废——pending 删除
 *  即作废（幂等），零执行零回执（放弃是本地即时收场，作废是 daemon 侧
 *  簿记同步，steward.interrupt 同构先例）。 */
export function handleStewardCancel(ctx: StewardCommandContext): void {
  const actionId = ctx.payload.actionId;
  if (typeof actionId !== "string" || actionId === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.actionId 应为非空 string");
  }
  ctx.steward.service.cancel(actionId);
}

/** steward.subscribe（全局命令）：事件 feed 连接级订阅登记。
 *  确认链路修复批：受理即点对点回发在途确认卡快照（steward.pending.snapshot
 *  ——订阅对账：非空集 = 增量对账，空集 = daemon 重启后清场指令，shell 撤
 *  旧卡；E-206 跨重启残项收编的主路径）。 */
export function handleStewardSubscribe(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  ctx.steward.stream.subscribeSteward(sender);
  ctx.steward.stream.sendStewardPendingSnapshot(sender, { actionIds: ctx.steward.service.pendingSnapshot() });
}

/** steward.unsubscribe（全局命令）：feed 退订（断连自动等效）。 */
export function handleStewardUnsubscribe(ctx: StewardCommandContext): void {
  ctx.steward.stream.unsubscribeSteward(ctx.ws.data.sender);
}

/** steward.history（全局命令；A1 工作记忆批）：工作记忆读/清 + 点对点
 *  回执 steward.history.result——回放链路（面板打开 → 读 KV → UI 渲染与
 *  LLM 窗口同源重建）；clear=true 新对话三处同步清（daemon KV + LLM 窗口
 *  由服务层收口，前端显示由回执空数组同步）。 */
export function handleStewardHistory(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const clear = ctx.payload.clear;
  if (clear !== undefined && typeof clear !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.clear 应为 boolean");
  }
  const respond = (records: readonly import("@helix/protocol").StewardHistoryRecord[]): void => {
    const frame: StewardHistoryResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "steward",
      type: "steward.history.result",
      payload: { records },
    };
    ctx.sendNow(sender, frame);
  };
  const job = clear === true ? ctx.steward.service.clearHistory() : ctx.steward.service.getHistory();
  void job
    .then((outcome) => {
      respond(outcome instanceof Array ? outcome : []);
    })
    .catch((err) =>
      ctx.commandError(ctx.type, "command.invalid_payload", `steward.history 执行失败：${(err as Error).message}`),
    );
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

/** steward.set_config（全局命令）：设置写面 + 新态回执；格式非法 → invalid_payload。
 *  **总结配置组摘除**（会话总结器独立化批①）：携带 summary/sessionMemory 组
 *  的载荷拒答 invalid_payload（协议契约变更——总结配置收编 summary.* 通用域，
 *  写面迁 config.set_summary；协议版本严格握手下无版本偏斜窗口，拒答即明示）。 */
export function handleStewardSetConfig(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const { enabled, model, summary, memory, sessionMemory, triage } = ctx.payload;
  if (summary !== undefined) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.summary 组已摘除（总结配置迁 summary.* 通用域）——请改用 config.set_summary",
    );
  }
  if (sessionMemory !== undefined) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.sessionMemory 组已摘除（总结配置迁 summary.* 通用域）——请改用 config.set_summary",
    );
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled 应为 boolean");
  }
  if (model !== undefined && typeof model !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.model 应为 string");
  }
  // 管家记忆 B2：memory 组瘦身校验（{enabled?,endpointId?}——透传前最后一道
  // TR-159 逐字段透传纪律）；批B +召回量 {recallTopK?,recallPool?} + B4a
  // judgeEndpointId（类型闸在此、值语义由 daemon 读面 resolver 静默回退
  // 缺省——非法值不拒写不抛错）
  if (memory !== undefined) {
    if (typeof memory !== "object" || memory === null) {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.memory 应为 object");
    }
    const mem = memory as {
      enabled?: unknown;
      endpointId?: unknown;
      judgeEndpointId?: unknown;
      recallTopK?: unknown;
      recallPool?: unknown;
    };
    if (mem.enabled !== undefined && typeof mem.enabled !== "boolean") {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.memory.enabled 应为 boolean");
    }
    if (mem.endpointId !== undefined && typeof mem.endpointId !== "string") {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.memory.endpointId 应为 string（空串 = 清除引用）");
    }
    if (mem.judgeEndpointId !== undefined && typeof mem.judgeEndpointId !== "string") {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.memory.judgeEndpointId 应为 string（空串 = 清除引用）");
    }
    if (mem.recallTopK !== undefined && typeof mem.recallTopK !== "number") {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.memory.recallTopK 应为 number");
    }
    if (mem.recallPool !== undefined && typeof mem.recallPool !== "number") {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.memory.recallPool 应为 number");
    }
  }
  // 分诊判官接入批：triage 组校验（{judgeEnabled?,judgeEndpointId?}——类型
  // 闸在此；空串 judgeEndpointId = 清除引用，悬空引用由读面自然视为未配）
  if (triage !== undefined) {
    if (typeof triage !== "object" || triage === null) {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.triage 应为 object");
    }
    const tri = triage as { judgeEnabled?: unknown; judgeEndpointId?: unknown };
    if (tri.judgeEnabled !== undefined && typeof tri.judgeEnabled !== "boolean") {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.triage.judgeEnabled 应为 boolean");
    }
    if (tri.judgeEndpointId !== undefined && typeof tri.judgeEndpointId !== "string") {
      return ctx.commandError(ctx.type, "command.invalid_payload", "payload.triage.judgeEndpointId 应为 string（空串 = 清除引用）");
    }
  }
  void ctx.steward.service
    .setConfig({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(memory !== undefined
        ? {
            memory: memory as {
              enabled?: boolean;
              endpointId?: string;
              judgeEndpointId?: string;
              recallTopK?: number;
              recallPool?: number;
            },
          }
        : {}),
      ...(triage !== undefined
        ? { triage: triage as { judgeEnabled?: boolean; judgeEndpointId?: string } }
        : {}),
    })
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

/**
 * agent.steward_profile.get（全局命令；管家公民权批）：管家只读档案读面
 * 点对点回执 agent.steward_profile.get.result。挂在 steward handler 族但
 * 回执帧挂 agent 通道（agent 页档案卡消费面同族）——服务层纯导出面
 * （StewardService.getProfile：prompt 常量/注册面工具表/模型槽位三现有源，
 * 零新状态；不含凭据类字段）。只转发不决策（本文件先例纪律）。
 */
export function handleAgentStewardProfileGet(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const frame: AgentStewardProfileGetResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "agent",
    type: "agent.steward_profile.get.result",
    payload: ctx.steward.service.getProfile(),
  };
  ctx.sendNow(sender, frame);
}

/** 记忆条目清单回执（管家记忆 B2：memory_list/append/update/delete +
 *  遗忘机制批 pin/restore 六命令共用——写后即回新清单；条目 → 协议视图
 *  （sourceTurn = 存储 source；生命周期字段逐字段显式透传——TR-159 纪律，
 *  帧级断言钉死在 steward-memory-frame 测试）；排序 updatedAt 降序——
 *  覆盖更新/复活/置顶浮顶可见）。 */
function respondMemoryList(ctx: StewardCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const service = ctx.steward.service;
  const entries = [...service.listMemoryEntries()].sort((a, b) => b.updatedAt - a.updatedAt);
  const frame: import("@helix/protocol").StewardMemoryListResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "steward",
    type: "steward.memory_list.result",
    payload: {
      entries: entries.map((e) => ({
        id: e.id,
        text: e.text,
        kind: e.kind,
        createdAt: e.createdAt,
        sourceTurn: e.source,
        updatedAt: e.updatedAt,
        lastRecalledAt: e.lastRecalledAt,
        recallCount: e.recallCount,
        faded: e.fadedAt !== 0,
        pinned: e.pinned,
        // progress 批：会话锚透传（additive——记忆页筛选/详情可用；旧 shell
        //  忽略无损）
        ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
        // 项目隔离批：作用域透传（additive——旧 shell 忽略无损；旧 daemon
        //  不携带）
        ...(e.projectScope !== undefined ? { projectScope: e.projectScope } : {}),
      })),
    },
  };
  ctx.sendNow(sender, frame);
}

/** 记忆面缺席回执已删（B1 卫生项：respondMemoryUnavailable 无调用点——
 *  记忆面缺席时 service.listMemoryEntries 空清单等价，死代码移除）。 */

/** steward.memory_list（全局命令；管家记忆 B2）：条目读面 + 点对点回执。 */
export function handleStewardMemoryList(ctx: StewardCommandContext): void {
  respondMemoryList(ctx);
}

/** steward.memory_append（全局命令；管家记忆 B2）：人工新增（embed 入库）
 *  → 回执新清单；失败经 invalid_payload 交代（命令回执 error 判别面）。
 *  projectScope（项目隔离批 additive 入参）：非空 string（"global" 或项目
 *  目录名）；缺省按 kind 规则。 */
export function handleStewardMemoryAppend(ctx: StewardCommandContext): void {
  const text = ctx.payload.text;
  if (typeof text !== "string" || text.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.text 应为非空 string");
  }
  const kind = ctx.payload.kind;
  if (kind !== undefined && kind !== "fact" && kind !== "preference") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.kind 应为 \"fact\" | \"preference\"");
  }
  const projectScope = ctx.payload.projectScope;
  if (projectScope !== undefined && (typeof projectScope !== "string" || projectScope.trim() === "")) {
    return ctx.commandError(ctx.type, "command.invalid_payload", 'payload.projectScope 应为非空 string（"global" 或项目目录名）');
  }
  const job = ctx.steward.service.appendMemoryEntry(text, kind, projectScope);
  void job
    .then((outcome) => {
      if (!outcome.ok) {
        return ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
      }
      respondMemoryList(ctx);
    })
    .catch((err) =>
      ctx.commandError(ctx.type, "command.invalid_payload", `steward.memory_append 执行失败：${(err as Error).message}`),
    );
}

/** steward.memory_update（全局命令；管家记忆 B2）：重嵌更新 → 回执新清单。 */
export function handleStewardMemoryUpdate(ctx: StewardCommandContext): void {
  const id = ctx.payload.id;
  const text = ctx.payload.text;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为 integer");
  }
  if (typeof text !== "string" || text.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.text 应为非空 string");
  }
  void ctx.steward.service
    .updateMemoryEntry(id, text)
    .then((outcome) => {
      if (!outcome.ok) {
        return ctx.commandError(ctx.type, "command.invalid_payload", outcome.error);
      }
      respondMemoryList(ctx);
    })
    .catch((err) =>
      ctx.commandError(ctx.type, "command.invalid_payload", `steward.memory_update 执行失败：${(err as Error).message}`),
    );
}

/** steward.memory_delete（全局命令；管家记忆 B2）：行级删除 → 回执新清单
 *  （id 不存在也回清单——删除幂等，UI 以清单为权威）。 */
export function handleStewardMemoryDelete(ctx: StewardCommandContext): void {
  const id = ctx.payload.id;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为 integer");
  }
  ctx.steward.service.forgetMemoryEntry(id);
  respondMemoryList(ctx);
}

/** steward.memory_pin（全局命令；遗忘机制批）：置顶切换（置顶永不淡忘
 *  永不 GC；置顶隐含解除淡忘 + 刷 updatedAt 浮顶）→ 回执新清单（幂等——
 *  id 不存在/取消未置顶条目也回清单）。 */
export function handleStewardMemoryPin(ctx: StewardCommandContext): void {
  const id = ctx.payload.id;
  const pinned = ctx.payload.pinned;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为 integer");
  }
  if (typeof pinned !== "boolean") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.pinned 应为 boolean");
  }
  ctx.steward.service.pinMemoryEntry(id, pinned);
  respondMemoryList(ctx);
}

/** steward.memory_restore（全局命令；遗忘机制批）：淡忘条目恢复
 *  （faded_at 归零 + 刷 updatedAt 满血复活；active 条目幂等 no-op）→
 *  回执新清单。 */
export function handleStewardMemoryRestore(ctx: StewardCommandContext): void {
  const id = ctx.payload.id;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.id 应为 integer");
  }
  ctx.steward.service.restoreMemoryEntry(id);
  respondMemoryList(ctx);
}

/** steward.interrupt（全局命令；B2 barge-in 批）：在途轮打断 →
 *  StewardService.abortInFlight(reason ?? "barge-in")（现成方法，幂等 +
 *  drain 序 + settleAbortedTurn 截断记账——E-198 语义零改动）。
 *  回执帧省（设计 §3.2：loop.run.interrupted + ask 终态事件面已够）；
 *  无在途时 abortInFlight 返回 false 照常静默（重复触发幂等）。 */
export function handleStewardInterrupt(ctx: StewardCommandContext): void {
  const reason = ctx.payload.reason;
  if (reason !== undefined && typeof reason !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.reason 应为 string");
  }
  ctx.steward.service.abortInFlight(reason ?? "barge-in");
}
