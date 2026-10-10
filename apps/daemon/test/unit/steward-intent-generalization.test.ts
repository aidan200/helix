/**
 * M3-a 批：管家意图判官泛化判定服务级单测（判官第五消费面——三级漏斗
 * 第二级：词表 0ms → 判官 ~百ms → LLM 秒级）。
 *
 * 断言面（brief 测试要求逐条）：
 * - 词表未命中 ∧ pending 卡在场 ∧ noul≥0.5 → 消费卡（确认）或作废（取消）
 *   ——零 LLM 新提案；
 * - noul<0.5（三问皆低）→ 原样走 LLM（无关新任务）；
 * - 无卡 → 判官零调用（不判闲聊——范围钳制）；
 * - 词表命中 → 判官零调用（第一级优先）；
 * - 判官抛错 → 回退词表后行为（原样走 LLM）+ WARN 不重试；
 * - 判官关闭（默认态）→ 零调用零日志；开但未配 → WARN 回退；
 * - 「修正」意图 → 撤旧卡（superseded 广播）+ 按修正后意图新开（一次 LLM
 *   带卡全文上下文）。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { AgentOrchestrationPort, AgentInstanceStatus } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardActionCompletedPayload, StewardNotifyPayload } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";
import type { IntentJudgeFace } from "../../src/application/steward/StewardIntentJudge";

// ── fakes（confirm-chain harness 同款最小面） ─────────────────

function fakeLlm(script: readonly StewardLlmResponse[]) {
  const requests: StewardLlmRequest[] = [];
  let round = 0;
  const port: StewardLlmPort = {
    modelId: "fake/flash",
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      requests.push(request);
      const next = script[round];
      round += 1;
      if (next === undefined) throw new Error(`fake LLM 剧本耗尽（round=${round}——判官路由应零 LLM 调用）`);
      return next;
    },
  };
  return { port, requests };
}

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

/** 意图判官 fake：三问固定分数 + addressee 分数 + 调用记录。 */
function fakeIntentJudge(scores: { revise: number; cancel: number; confirm: number; addressee?: number; stop?: number }, opts: { enabled?: boolean; ready?: boolean; throwErr?: Error } = {}): IntentJudgeFace & { noulCalls: { state: string; question: string }[] } {
  const noulCalls: { state: string; question: string }[] = [];
  const questionKey: Record<string, keyof typeof scores> = {};
  void questionKey;
  return {
    noulCalls,
    enabled: () => opts.enabled ?? true,
    ready: () => opts.ready ?? true,
    noul: async (state, question) => {
      noulCalls.push({ state, question });
      if (opts.throwErr !== undefined) throw opts.throwErr;
      // 按问句关键词分流固定分数（问句单源常量与实现同模块——关键词稳定）
      if (question.includes("跟管家")) return scores.addressee ?? 1;
      if (question.includes("停止说话")) return scores.stop ?? 0;
      if (question.includes("修正")) return scores.revise;
      if (question.includes("取消")) return scores.cancel;
      return scores.confirm;
    },
  };
}

function fakeSessions() {
  const deliveries: { sessionId: string; text: string }[] = [];
  return {
    deliveries,
    listSessionMetadata: async () => [],
    startDraftSession: async () => ({ sessionId: "s-new" }),
    createTitledSession: async (title: string) => ({ sessionId: `s-${title}` }),
    sessionExists: async (sessionId: string) => sessionId.startsWith("s-"),
    deliverToSession: async (sessionId: string, text: string) => {
      deliveries.push({ sessionId, text });
      return { delivered: true, detail: `已投递到 ${sessionId}（idle → 新轮次）` };
    },
    readSessionTail: async () => [],
  };
}

function makeService(opts: { llm: StewardLlmPort; intentJudge?: IntentJudgeFace }) {
  const notifies: StewardNotifyPayload[] = [];
  const actionCompleted: StewardActionCompletedPayload[] = [];
  const logger = { infos: [] as string[], warns: [] as string[], info: (m: string) => logger.infos.push(m), warn: (m: string) => logger.warns.push(m) };
  const sends: { agentId: string; message: string }[] = [];
  const orchestration = {
    sends,
    status: (): AgentInstanceStatus[] => [
      { agentId: "agent-1", state: "running", displayState: "active", profileKind: "subagent-worker", task: "部署服务" },
    ],
    send: (agentId: string, message: string) => {
      sends.push({ agentId, message });
      return { delivered: true, detail: "已投递（turn 边界注入生效）" };
    },
  } as unknown as Pick<AgentOrchestrationPort, "status" | "send"> & { sends: { agentId: string; message: string }[] };
  const sessions = fakeSessions();
  const innerCreate = createEngineFromPort(opts.llm);
  const svc = new StewardService({
    llm: opts.llm,
    orchestration,
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    dialog: new StewardDialogMemory(fakeDialogStore()),
    clock: () => 0,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => undefined,
    emitNotify: (payload) => notifies.push(payload),
    emitActionCompleted: (payload) => actionCompleted.push(payload),
    logger,
    sessions,
    onDelivered: () => undefined,
    createEngine: (engineOpts) => innerCreate(engineOpts),
    ...(opts.intentJudge !== undefined ? { intentJudge: opts.intentJudge } : {}),
  });
  return { svc, sessions, notifies, actionCompleted, logger };
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

const toolCall = (name: string, args: Record<string, unknown>): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "toolCall", id: `call-${name}-${Math.random().toString(36).slice(2, 7)}`, name, args }],
  stopReason: "toolUse",
});
const answer = (text: string): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "text", text }],
  stopReason: "stop",
});

/** 挂闸弹卡快捷面（deliver_to_session 提案 → confirm_required）。 */
async function askForCard(svc: StewardService, text: string): Promise<{ actionId: string; message: string }> {
  const outcome = await svc.ask(text);
  if (outcome.status !== "confirm_required") throw new Error(`预期 confirm_required，实际 ${outcome.status}`);
  return { actionId: outcome.actionId, message: outcome.message };
}

/** 弹一张 deliver 卡的剧本（会话 s-1）。 */
const CARD_SCRIPT: readonly StewardLlmResponse[] = [
  toolCall("deliver_to_session", { sessionId: "s-1", text: "继续执行部署计划" }),
];

// ── 确认意图：词表未命中 + 卡在场 + noul≥0.5 → 消费卡零 LLM ─────────

describe("M3-a 确认意图泛化（noul≥0.5 → 消费在途卡）", () => {
  test("长句确认表述（非词表全等）→ 判官确认 → 卡被消费真执行，零 LLM 新提案", async () => {
    const llm = fakeLlm([...CARD_SCRIPT]); // 剧本只有弹卡轮——第二轮 LLM 调用即剧本耗尽红
    const judge = fakeIntentJudge({ revise: 0.1, cancel: 0.1, confirm: 0.92 });
    const { svc, sessions } = makeService({ llm: llm.port, intentJudge: judge });
    const card = await askForCard(svc, "把部署计划发给会话 s-1");

    const outcome = await svc.ask("嗯就这样可以了，弄吧");
    expect(outcome.status).toBe("answer");
    if (outcome.status !== "answer") throw new Error("unreachable");
    expect(outcome.text).toContain("已确认"); // 与词表路由同款回执（TR-243 纯语音短句形态）
    await settle();
    expect(sessions.deliveries.length).toBe(1); // 卡真执行
    expect(svc.pendingSnapshot().length).toBe(0); // 卡已消费
    expect(judge.noulCalls.length).toBe(3); // 三问并发各一次
    expect(llm.requests.length).toBe(1); // 零 LLM 新提案（只有弹卡轮）
  });

  test("取消意图（noul≥0.5）→ 卡作废零执行 + superseded 广播", async () => {
    const llm = fakeLlm([...CARD_SCRIPT]);
    const judge = fakeIntentJudge({ revise: 0.05, cancel: 0.88, confirm: 0.2 });
    const { svc, sessions, actionCompleted } = makeService({ llm: llm.port, intentJudge: judge });
    const card = await askForCard(svc, "把部署计划发给会话 s-1");

    const outcome = await svc.ask("这个先算了别弄了");
    expect(outcome.status).toBe("answer");
    if (outcome.status !== "answer") throw new Error("unreachable");
    expect(outcome.text).toContain("已放弃");
    await settle();
    expect(sessions.deliveries.length).toBe(0); // 零执行
    expect(svc.pendingSnapshot().length).toBe(0);
    const superseded = actionCompleted.find((p) => p.actionId === card.actionId && (p as { outcome?: string }).outcome === "superseded");
    expect(superseded).toBeDefined(); // 多窗卡栈同步撤卡
    expect(llm.requests.length).toBe(1); // 零 LLM
  });
});

// ── 无关新任务：noul<0.5 → 原样走 LLM ─────────────────────────

describe("M3-a 无关新任务（三问皆 <0.5 → 原样走 LLM）", () => {
  test("判官判无关 → 不消费卡，新指令走 LLM（卡保留）", async () => {
    const llm = fakeLlm([
      ...CARD_SCRIPT,
      answer("好的——已另开新话题处理（旧卡保留待确认）。"),
    ]);
    const judge = fakeIntentJudge({ revise: 0.1, cancel: 0.1, confirm: 0.2 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    await askForCard(svc, "把部署计划发给会话 s-1");

    const outcome = await svc.ask("顺便帮我查一下今天有哪些任务在跑");
    expect(outcome.status).toBe("answer");
    expect(svc.pendingSnapshot().length).toBe(1); // 卡保留（未误消费）
    expect(judge.noulCalls.length).toBe(3);
    expect(llm.requests.length).toBe(2); // 第二轮 LLM 原样收到用户话
  });
});

// ── 无卡零判官（不判闲聊——范围钳制） ─────────────────────────

describe("M3-a 无卡 → 判官零调用", () => {
  test("无 pending 卡时任意输入 → 零 noul 调用，原样走 LLM", async () => {
    const llm = fakeLlm([answer("目前没有待确认的操作。")]);
    const judge = fakeIntentJudge({ revise: 0.9, cancel: 0.9, confirm: 0.9 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    const outcome = await svc.ask("今天天气怎么样");
    expect(outcome.status).toBe("answer");
    expect(judge.noulCalls.length).toBe(0); // 无卡零判官调用
  });

  test("词表命中（「确认执行」）→ 判官零调用（第一级漏斗优先）", async () => {
    const llm = fakeLlm([...CARD_SCRIPT]);
    const judge = fakeIntentJudge({ revise: 0.9, cancel: 0.9, confirm: 0.9 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    await askForCard(svc, "把部署计划发给会话 s-1");
    const outcome = await svc.ask("确认执行");
    expect(outcome.status).toBe("answer");
    expect(judge.noulCalls.length).toBe(0); // 词表命中不经判官
    expect(llm.requests.length).toBe(1); // 零 LLM
  });
});

// ── 降级链：关/未配/抛错 → 回退词表后行为（零劣化） ───────────────

describe("M3-a 判官降级链（关/未配/抛错 → 回退原样走 LLM）", () => {
  test("判官关闭（默认态）→ 零调用零日志，原样走 LLM", async () => {
    const llm = fakeLlm([...CARD_SCRIPT, answer("走 LLM 的回答。")]);
    const judge = fakeIntentJudge({ revise: 0.9, cancel: 0.9, confirm: 0.9 }, { enabled: false });
    const { svc, logger } = makeService({ llm: llm.port, intentJudge: judge });
    await askForCard(svc, "把部署计划发给会话 s-1");
    const outcome = await svc.ask("就按刚才说的弄");
    expect(outcome.status).toBe("answer");
    expect(judge.noulCalls.length).toBe(0);
    expect(logger.warns.filter((w) => w.includes("判官"))).toHaveLength(0); // 关闭 = 默认态判官零日志（abort-再驱动路径的收口日志与本面无关）
    expect(llm.requests.length).toBe(2);
  });

  test("判官开但端点未配 → WARN 提醒 + 回退 LLM", async () => {
    const llm = fakeLlm([...CARD_SCRIPT, answer("走 LLM 的回答。")]);
    const judge = fakeIntentJudge({ revise: 0.9, cancel: 0.9, confirm: 0.9 }, { enabled: true, ready: false });
    const { svc, logger } = makeService({ llm: llm.port, intentJudge: judge });
    await askForCard(svc, "把部署计划发给会话 s-1");
    const outcome = await svc.ask("就按刚才说的弄");
    expect(outcome.status).toBe("answer");
    expect(judge.noulCalls.length).toBe(0);
    expect(logger.warns.some((w) => w.includes("端点未配"))).toBe(true);
    expect(llm.requests.length).toBe(2);
  });

  test("判官抛错 → WARN 不重试 + 回退 LLM（零劣化）", async () => {
    const llm = fakeLlm([...CARD_SCRIPT, answer("回退路径的回答。")]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0 }, { throwErr: new Error("分类端点 503") });
    const { svc, logger } = makeService({ llm: llm.port, intentJudge: judge });
    await askForCard(svc, "把部署计划发给会话 s-1");
    const outcome = await svc.ask("嗯行就这么办");
    expect(outcome.status).toBe("answer");
    expect(judge.noulCalls.length).toBeGreaterThanOrEqual(1); // 试过
    expect(logger.warns.some((w) => w.includes("意图判官"))).toBe(true);
    expect(llm.requests.length).toBe(2); // 回退词表后行为（原样 LLM）
  });
});

// ── 修正意图：撤旧卡 + 按修正后意图新开（一次 LLM 带卡全文上下文） ────

describe("M3-a 修正意图（noul≥0.5 → 撤旧卡 + 带卡上下文新开）", () => {
  test("「不对，发给 s-2」→ 旧卡 superseded 撤除 + 新提案给 s-2 + LLM 输入含原卡全文", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "s-1", text: "继续执行部署计划" }), // 弹卡轮（s-1）
      toolCall("deliver_to_session", { sessionId: "s-2", text: "继续执行部署计划" }), // 修正轮（s-2）
      answer("已按修正后的目标重新提案。"),
    ]);
    const judge = fakeIntentJudge({ revise: 0.9, cancel: 0.1, confirm: 0.3 });
    const { svc, sessions, actionCompleted } = makeService({ llm: llm.port, intentJudge: judge });
    const oldCard = await askForCard(svc, "把部署计划发给会话 s-1");

    const outcome = await svc.ask("不对，发给 s-2");
    expect(outcome.status).toBe("confirm_required"); // 修正后新提案弹新卡
    if (outcome.status !== "confirm_required") throw new Error("unreachable");
    expect(outcome.actionId).not.toBe(oldCard.actionId);
    expect(svc.pendingSnapshot()).toEqual([outcome.actionId]); // 旧卡已撤只剩新卡
    const superseded = actionCompleted.find((p) => p.actionId === oldCard.actionId && (p as { outcome?: string }).outcome === "superseded");
    expect(superseded).toBeDefined(); // 撤旧卡广播（多窗同步）
    // 修正轮 LLM 输入带原卡全文上下文 + 用户原话（一次 LLM——不先撤卡再裸问）
    expect(llm.requests.length).toBe(2);
    const revisedInput = JSON.stringify(llm.requests[1]!);
    expect(revisedInput).toContain("待确认提案");
    expect(revisedInput).toContain("继续执行部署计划");
    expect(revisedInput).toContain("不对，发给 s-2");
    await settle();
    expect(sessions.deliveries.length).toBe(0); // 未确认零执行

    // 新卡确认后按修正目标执行
    const confirmed = await svc.confirm(outcome.actionId);
    expect(confirmed.status).toBe("accepted");
    await settle();
    expect(sessions.deliveries.length).toBe(1);
    expect(sessions.deliveries[0]!.sessionId).toBe("s-2");
  });
});

// ── addressee 判定（声纹→Jev 链路批：双工收音段「对谁说」判定）────────

describe("addressee 判定（voice-duplex 才触发；旁人高置信 → dropped 静默丢弃）", () => {
  test("双工语音 + 判官判旁人（< 0.3）→ dropped 零 LLM", async () => {
    const llm = fakeLlm([]); // 剧本空——走到 LLM 即抛错（防误路由）
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.1 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    const outcome = await svc.ask("小明你把那个文件发我一下", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("dropped");
    expect((outcome as { reason?: string }).reason).toBe("ambient");
    expect(llm.requests.length).toBe(0);
  });

  test("双工语音 + 判官判管家（≥ 0.5）→ 原样走 LLM", async () => {
    const llm = fakeLlm([answer("好")]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.9 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    const outcome = await svc.ask("帮我查一下今天的日程", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("answer");
    expect(llm.requests.length).toBe(1);
  });

  test("双工语音 + 灰区（[0.3, 0.5)）→ 置信偏置偏 chat，继续走 LLM", async () => {
    const llm = fakeLlm([answer("好")]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.4 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    const outcome = await svc.ask("明天记得买菜", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("answer"); // 宁多应答不漏应答（用户裁决）
    expect(llm.requests.length).toBe(1);
  });

  test("text / voice-manual 来源 → addressee 零调用（显式面向会话）", async () => {
    const llm = fakeLlm([answer("好"), answer("好")]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.05 }); // 即使判官会判旁人也不触发
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    const a = await svc.ask("帮我查一下日程");
    expect(a.status).toBe("answer");
    const b = await svc.ask("再查一下天气", undefined, undefined, "voice-manual");
    expect(b.status).toBe("answer");
    expect(judge.noulCalls.length).toBe(0);
  });

  test("词表全等命中（双工语音）→ 机械权威，addressee 零调用直接路由", async () => {
    const llm = fakeLlm([toolCall("deliver_to_session", { sessionId: "s-1", text: "干活" })]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.05 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    const card = await askForCard(svc, "发到会话 s-1"); // 弹卡（走 LLM 剧本）
    void card;
    // 词表命中「不要了」→ cancel 路由（不判 addressee/不判 intent）
    const outcome = await svc.ask("不要了", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("answer");
    expect(String((outcome as { text?: string }).text)).toContain("放弃");
    expect(judge.noulCalls.length).toBe(0);
  });

  test("判官抛错 → 偏 chat 回退（WARN 不重试），原样走 LLM", async () => {
    const llm = fakeLlm([answer("好")]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.1 }, { throwErr: new Error("judge boom") });
    const { svc, logger } = makeService({ llm: llm.port, intentJudge: judge });
    const outcome = await svc.ask("今天天气怎么样", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("answer"); // 偏 chat（零误丢）
    expect(logger.warns.some((w) => w.includes("addressee"))).toBe(true);
  });

  test("判官关闭（默认态）→ 零调用零日志偏 chat", async () => {
    const llm = fakeLlm([answer("好")]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.05 }, { enabled: false });
    const { svc, logger } = makeService({ llm: llm.port, intentJudge: judge });
    const outcome = await svc.ask("今天天气怎么样", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("answer");
    expect(judge.noulCalls.length).toBe(0);
    expect(logger.warns.length).toBe(0);
  });

  test("卡在场：主人确认回应优先消费卡（addressee 不拦——用户实锤修复）", async () => {
    const llm = fakeLlm([toolCall("deliver_to_session", { sessionId: "s-1", text: "继续执行部署计划" })]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0.9, addressee: 0.05 });
    const { svc, sessions } = makeService({ llm: llm.port, intentJudge: judge });
    await askForCard(svc, "把部署计划发给会话 s-1");
    // 主人自然确认回应（词表未命中短句——addressee 判官无卡上下文恒判低
    // 分）：卡在场是最强「对谁说」证据，泛化层先判 → confirm 路由执行卡。
    const outcome = await svc.ask("对对对就这个赶紧弄吧", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("answer"); // 确认路由回执（非 dropped）
    await settle();
    expect(sessions.deliveries.length).toBe(1); // 卡真执行
    expect(svc.pendingSnapshot().length).toBe(0); // 卡被消费
    expect(llm.requests.length).toBe(1); // 零 LLM 新提案
  });

  test("卡在场 + 三问皆低 + addressee 低分 → 照旧 dropped（主人对旁人说话照丢）", async () => {
    const llm = fakeLlm([toolCall("deliver_to_session", { sessionId: "s-1", text: "继续执行部署计划" })]);
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0.1, addressee: 0.05 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    await askForCard(svc, "把部署计划发给会话 s-1");
    const outcome = await svc.ask("明天记得帮我带杯咖啡", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("dropped");
    expect((outcome as { reason?: string }).reason).toBe("ambient");
    expect(svc.pendingSnapshot().length).toBe(1); // 卡保留
  });

  test("卡在场 + revise 高分 + addressee 低分 → 修正轮输入替换（不过 addressee）", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "s-2", text: "继续执行部署计划" }),
      toolCall("deliver_to_session", { sessionId: "s-1", text: "继续执行部署计划" }),
    ]);
    const judge = fakeIntentJudge({ revise: 0.9, cancel: 0, confirm: 0, addressee: 0.05 });
    const { svc } = makeService({ llm: llm.port, intentJudge: judge });
    await askForCard(svc, "把部署计划发给会话 s-2");
    const outcome = await svc.ask("不对，改发 s-1", undefined, undefined, "voice-duplex");
    expect(outcome.status).toBe("confirm_required"); // 修正轮新开：旧卡撤 + 新提案再弹卡
    expect(llm.requests.length).toBe(2); // 弹卡一次 + 修正轮一次
    const revisedInput = JSON.stringify(llm.requests[1]!);
    expect(revisedInput).toContain("待确认提案"); // 修正轮带卡全文上下文
    expect(svc.pendingSnapshot().length).toBe(1); // 新卡在栈（旧卡已撤）
  });
});

// ── isAmbientSpeech 纯函数（置信偏置阈值）────────────────

import { isAmbientSpeech, STEWARD_ADDRESSEE_DROP_THRESHOLD } from "../../src/application/steward/StewardIntentJudge";

describe("isAmbientSpeech（置信偏置：显著低分才丢，灰区/坏值偏 chat）", () => {
  test("显著低分（< 0.3）→ 旁人判定", () => {
    expect(isAmbientSpeech(0)).toBe(true);
    expect(isAmbientSpeech(0.29)).toBe(true);
  });
  test("灰区及以上（≥ 0.3）→ 偏 chat", () => {
    expect(isAmbientSpeech(STEWARD_ADDRESSEE_DROP_THRESHOLD)).toBe(false);
    expect(isAmbientSpeech(0.4)).toBe(false);
    expect(isAmbientSpeech(1)).toBe(false);
  });
  test("坏值（NaN/越界）→ 偏 chat（保守回退零误丢）", () => {
    expect(isAmbientSpeech(Number.NaN)).toBe(false);
    expect(isAmbientSpeech(99)).toBe(false);
    expect(isAmbientSpeech(-1)).toBe(true); // 负值钳制 0 → 显著低（判旁人）
  });
});

// ── stop-intent 判定面（barge-in 意图窗慢通道：非词表停止表达 → 判官 noul）──

describe("stop-intent 判定（judgeStopIntent：shell 意图窗排队前调用）", () => {
  test("判官判停止（≥0.5）→ {stop:true}（词表未命中的「先别说了/等一下」类）", async () => {
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.9, stop: 0.8 });
    const { svc } = makeService({ llm: fakeLlm([]).port, intentJudge: judge });
    const res = await svc.judgeStopIntent("先别说了，等一下");
    expect(res.stop).toBe(true);
    expect(res.score).toBe(0.8);
    expect(judge.noulCalls.length).toBe(1);
    expect(judge.noulCalls[0]!.state).toContain("先别说了");
  });

  test("判官判非停止（<0.5）→ {stop:false}（纠正/补充内容照排队）", async () => {
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, addressee: 0.9, stop: 0.2 });
    const { svc } = makeService({ llm: fakeLlm([]).port, intentJudge: judge });
    const res = await svc.judgeStopIntent("我想补充一点，那个参数改成 5");
    expect(res.stop).toBe(false);
    expect(res.score).toBe(0.2);
  });

  test("开关关（默认态）→ {stop:false, degraded:'off'} 零调用零日志", async () => {
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, stop: 0.9 }, { enabled: false });
    const { svc, logger } = makeService({ llm: fakeLlm([]).port, intentJudge: judge });
    const res = await svc.judgeStopIntent("先别说了");
    expect(res.stop).toBe(false);
    expect(res.degraded).toBe("off");
    expect(judge.noulCalls.length).toBe(0);
    expect(logger.warns.length).toBe(0);
  });

  test("端点未配 → {stop:false, degraded:'unready'} + WARN（用户预期判官生效）", async () => {
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, stop: 0.9 }, { ready: false });
    const { svc, logger } = makeService({ llm: fakeLlm([]).port, intentJudge: judge });
    const res = await svc.judgeStopIntent("先别说了");
    expect(res.stop).toBe(false);
    expect(res.degraded).toBe("unready");
    expect(logger.warns.some((w) => w.includes("stop-intent"))).toBe(true);
  });

  test("判官抛错 → {stop:false, degraded:'error'} + WARN 不重试（保守回退照排队）", async () => {
    const judge = fakeIntentJudge({ revise: 0, cancel: 0, confirm: 0, stop: 0.9 }, { throwErr: new Error("judge boom") });
    const { svc, logger } = makeService({ llm: fakeLlm([]).port, intentJudge: judge });
    const res = await svc.judgeStopIntent("先别说了");
    expect(res.stop).toBe(false);
    expect(res.degraded).toBe("error");
    expect(logger.warns.some((w) => w.includes("stop-intent"))).toBe(true);
  });

  test("判官缺席（未注入）→ {stop:false, degraded:'off'}（零配置面行为）", async () => {
    const { svc } = makeService({ llm: fakeLlm([]).port });
    const res = await svc.judgeStopIntent("先别说了");
    expect(res.stop).toBe(false);
    expect(res.degraded).toBe("off");
  });
});
