/**
 * 文本管家批（V2.5）additive 断言：
 * - steward.ask / steward.confirm / steward.subscribe / steward.unsubscribe /
 *   steward.get_config / steward.set_config 六命令（对话 + 确认闸 + feed
 *   订阅 + 设置面）；
 * - steward.ask.result 三判别（answer 直答 / confirm_required 确认闸请求——
 *   携 actionId + agentId + message 全文 / error 业务失败）；
 * - steward.ask.delta 流式增量帧（V2.5 体验批：delta 增量 + seq 单调——
 *   前端聚合，终态 ask.result 权威覆盖；工具段静默）；
 * - steward.confirm.result 两判别（ok 含注入通道回执 detail / error）；
 * - steward.feed 文本行广播帧（kind/agentId/text/seq）；
 * - steward.config.result 设置回执（enabled + model）；
 * - CHANNEL 目录扩 "steward"（新增族 = additive，不动分发器）。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES, PROTOCOL_VERSION } from "../../src/index";
import type {
  StewardAskCommand,
  StewardAskDeltaEvent,
  StewardAskDeltaPayload,
  StewardAskResultEvent,
  StewardAskResultPayload,
  StewardConfirmCommand,
  StewardConfirmResultEvent,
  StewardConfigResultEvent,
  StewardFeedEvent,
  StewardFeedPayload,
  StewardGetConfigCommand,
  StewardSetConfigCommand,
  StewardSubscribeCommand,
  StewardUnsubscribeCommand,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand, familyOf, summarizeEvent } from "./samples/helpers";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败）──

// ask/confirm 载荷必填字段（additive 纪律）
type _AskText = Expect<Equal<StewardAskCommand["payload"]["text"], string>>;
type _ConfirmActionId = Expect<Equal<StewardConfirmCommand["payload"]["actionId"], string>>;

// set_config 两槽位可选
type _SetEnabled = Expect<Equal<StewardSetConfigCommand["payload"]["enabled"], boolean | undefined>>;
type _SetModel = Expect<Equal<StewardSetConfigCommand["payload"]["model"], string | undefined>>;

// ask.result 三判别
type _AnswerBranch = Expect<Equal<Extract<StewardAskResultPayload, { status: "answer" }>["text"], string>>;
type _ConfirmBranch = Expect<
  Equal<Extract<StewardAskResultPayload, { status: "confirm_required" }>["actionId"], string>
>;
type _ConfirmBranchAgent = Expect<
  Equal<Extract<StewardAskResultPayload, { status: "confirm_required" }>["agentId"], string>
>;
type _ConfirmBranchMessage = Expect<
  Equal<Extract<StewardAskResultPayload, { status: "confirm_required" }>["message"], string>
>;
type _AskErrorBranch = Expect<Equal<Extract<StewardAskResultPayload, { status: "error" }>["reason"], string>>;

// ask.delta 流式增量帧（V2.5 体验批 additive：delta 增量 + seq 单调）
type _DeltaText = Expect<Equal<StewardAskDeltaPayload["delta"], string>>;
type _DeltaSeq = Expect<Equal<StewardAskDeltaPayload["seq"], number>>;

// feed payload 必填字段
type _FeedKind = Expect<
  Equal<
    StewardFeedPayload["kind"],
    "agent.spawned" | "agent.completed" | "agent.failed" | "agent.killed" | "agent.parked" | "agent.resumed"
  >
>;
type _FeedSeq = Expect<Equal<StewardFeedPayload["seq"], number>>;

// channel = "steward" 新族窄化（familyOf case 存在 + TypeOfChannel 收窄）
type _StewardFamily = Expect<
  Equal<
    TypeOfChannel<"steward">,
    "steward.ask.result" | "steward.ask.delta" | "steward.confirm.result" | "steward.feed" | "steward.config.result"
  >
>;

const askCommand: StewardAskCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.ask",
  payload: { text: "现在有哪些 agent 在跑？" },
};

const confirmCommand: StewardConfirmCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.confirm",
  payload: { actionId: "steward-action-1" },
};

const subscribeCommand: StewardSubscribeCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.subscribe",
  payload: {},
};

const unsubscribeCommand: StewardUnsubscribeCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.unsubscribe",
  payload: {},
};

const getConfigCommand: StewardGetConfigCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.get_config",
  payload: {},
};

const setConfigCommand: StewardSetConfigCommand = {
  v: PROTOCOL_VERSION,
  type: "steward.set_config",
  payload: { enabled: true, model: "deepseek/deepseek-v4-flash" },
};

const askAnswer: StewardAskResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.ask.result",
  payload: { status: "answer", text: "当前有 2 个实例运行中：agent-1、agent-2。" },
};

const askConfirm: StewardAskResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.ask.result",
  payload: {
    status: "confirm_required",
    actionId: "steward-action-1",
    agentId: "agent-2",
    message: "顺带跑一下 lint",
  },
};

const askError: StewardAskResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.ask.result",
  payload: { status: "error", reason: "管家未开启（设置页 → 文本管家 → 开启开关）" },
};

const askDelta: StewardAskDeltaEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.ask.delta",
  payload: { delta: "当前有 ", seq: 1 },
};

const confirmOk: StewardConfirmResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.confirm.result",
  payload: { status: "ok", agentId: "agent-2", detail: "已投递（turn 边界注入生效）" },
};

const feedFrame: StewardFeedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.feed",
  payload: { kind: "agent.completed", agentId: "agent-2", text: "agent-2 已完成：修复登录超时", seq: 1 },
};

const configResult: StewardConfigResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "steward",
  type: "steward.config.result",
  payload: { enabled: false, model: "deepseek/deepseek-v4-flash" },
};

describe("文本管家批（V2.5）：steward 族 additive", () => {
  test("命令/事件/通道目录登记（COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS）", () => {
    for (const t of [
      "steward.ask",
      "steward.confirm",
      "steward.subscribe",
      "steward.unsubscribe",
      "steward.get_config",
      "steward.set_config",
    ] as const) {
      expect(COMMAND_TYPES).toContain(t);
    }
    for (const t of [
      "steward.ask.result",
      "steward.ask.delta",
      "steward.confirm.result",
      "steward.feed",
      "steward.config.result",
    ] as const) {
      expect(EVENT_TYPES).toContain(t);
      expect(EVENT_CHANNELS[t as "steward.feed"]).toBe("steward");
    }
  });

  test("ask/confirm 命令可构造且 dispatch 窄化消费独有字段", () => {
    expect(dispatchCommand(askCommand)).toContain("steward-ask:现在有哪些 agent 在跑？");
    expect(dispatchCommand(confirmCommand)).toBe("steward-confirm:steward-action-1");
  });

  test("订阅/退订/设置命令最小载荷构造", () => {
    expect(dispatchCommand(subscribeCommand)).toBe("steward-subscribe");
    expect(dispatchCommand(unsubscribeCommand)).toBe("steward-unsubscribe");
    expect(dispatchCommand(getConfigCommand)).toBe("steward-get_config");
    expect(dispatchCommand(setConfigCommand)).toBe("steward-set_config:true:deepseek/deepseek-v4-flash");
  });

  test("ask.result 三判别窄化：answer/confirm_required/error 独有字段可达", () => {
    expect(summarizeEvent(askAnswer)).toContain("steward-answer:");
    expect(summarizeEvent(askConfirm)).toBe("steward-confirm-required:steward-action-1:agent-2:顺带跑一下 lint");
    expect(summarizeEvent(askError)).toContain("steward-error:");
  });

  test("confirm.result / feed / config.result 全字段窄化可达", () => {
    expect(summarizeEvent(confirmOk)).toBe("steward-confirm-result:ok:agent-2:已投递（turn 边界注入生效）");
    expect(feedFrame.payload.seq).toBe(1);
    expect(feedFrame.payload.kind).toBe("agent.completed");
    expect(configResult.payload.enabled).toBe(false);
  });

  test("ask.delta 流式增量帧窄化：delta/seq 字段可达 + 目录登记（V2.5 体验批）", () => {
    expect(summarizeEvent(askDelta)).toBe("steward-ask-delta:当前有 :1");
    expect(askDelta.payload.seq).toBe(1);
    expect(askDelta.payload.delta).toBe("当前有 ");
  });

  test("familyOf 分族窄化：channel=steward → 'steward/<type>'", () => {
    expect(familyOf(askAnswer)).toBe("steward/steward.ask.result");
    expect(familyOf(feedFrame)).toBe("steward/steward.feed");
    expect(familyOf(askDelta)).toBe("steward/steward.ask.delta");
  });
});
