/**
 * 管家驾驶舱批单测（session 级投递 + steward.navigate 页面切换 + 意图路由）。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. deliver_to_session：提案过确认闸（未确认零执行）/ session 存在性引导式
 *    校验（toolResult 回灌循环继续）/ confirm 后投递到达 sessions 源（steer
 *    通道）+ steward.navigate 广播（投递成功才发）；
 * 2. create_session：建完即切——confirm 成功即发 steward.navigate{created}；
 * 3. 意图路由：system prompt 三分类段 + 工具目录含 deliver_to_session；
 * 4. EventStream.broadcastStewardNavigate：仅已订阅 steward 的连接收帧
 *    （feed 闸门同构）。
 */
import { describe, expect, test } from "bun:test";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { AgentOrchestrationPort } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { StewardNavigatePayload, StewardFeedPayload } from "@helix/protocol";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import {
  StewardService,
  STEWARD_SYSTEM_PROMPT,
  type StewardSessionMetaRow,
} from "../../src/application/steward/StewardService";

// ── fakes（a2 测试同构） ───────────────────────────────────

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort & {
  calls: { request: StewardLlmRequest; round: number }[];
} {
  const calls: { request: StewardLlmRequest; round: number }[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      const round = calls.length;
      calls.push({ request, round });
      const next = script[round];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
    },
  };
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

function fakeOrchestration(): Pick<AgentOrchestrationPort, "status" | "send"> {
  return {
    status: () => [],
    send: (_agentId: string, _message: string) => ({ delivered: true, detail: "已投递" }),
  };
}

/** 驾驶舱会话源 fake：存在性 + 投递执行记录（投递 = steer/sendMessage 通道替身）。 */
function fakeCockpitSessions(opts: { existing?: readonly string[]; deliverOutcome?: { delivered: boolean; detail: string } } = {}) {
  const existing = new Set(opts.existing ?? ["sess-1", "sess-2"]);
  const deliveries: { sessionId: string; text: string }[] = [];
  const titled: string[] = [];
  let seq = 0;
  return {
    deliveries,
    titled,
    sessionExists: async (sessionId: string) => existing.has(sessionId),
    deliverToSession: async (sessionId: string, text: string) => {
      deliveries.push({ sessionId, text });
      return opts.deliverOutcome ?? { delivered: true, detail: "已注入目标会话 steer 队列" };
    },
    listSessionMetadata: async () => [] as readonly StewardSessionMetaRow[],
    startDraftSession: async () => ({ sessionId: "sess-draft" }),
    createTitledSession: async (title: string) => {
      titled.push(title);
      seq += 1;
      return { sessionId: `sess-new-${seq}` };
    },
  };
}

interface CockpitRig {
  svc: StewardService;
  navigates: StewardNavigatePayload[];
}

function makeService(opts: {
  llm: StewardLlmPort & { calls: { request: StewardLlmRequest; round: number }[] };
  sessions: ReturnType<typeof fakeCockpitSessions>;
}): CockpitRig {
  const navigates: StewardNavigatePayload[] = [];
  const feeds: StewardFeedPayload[] = [];
  const svc = new StewardService({
    llm: opts.llm,
    orchestration: fakeOrchestration(),
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => true },
    emitFeed: (payload) => feeds.push(payload),
    sessions: opts.sessions,
    emitNavigate: (payload) => navigates.push(payload),
  });
  return { svc, navigates };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): StewardLlmResponse => ({
  kind: "toolCall",
  id,
  name,
  args,
});

// ── 1. deliver_to_session：提案 → 确认闸 ───────────────────

describe("驾驶舱：deliver_to_session（session 级 steer 投递）", () => {
  test("提案过确认闸：confirm_required 携全文，未确认零执行（deliverToSession 不被调）", async () => {
    const llm = fakeLlm([
      toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修登录超时，重点看锁等待" }),
    ]);
    const sessions = fakeCockpitSessions();
    const { svc } = makeService({ llm, sessions });
    const res = await svc.ask("把这句递给最近的会话");
    expect(res.status).toBe("confirm_required");
    if (res.status !== "confirm_required") throw new Error("unreachable");
    expect(res.agentId).toBe("sess-1");
    expect(res.message).toBe("继续修登录超时，重点看锁等待");
    expect(sessions.deliveries.length).toBe(0); // §5.2 防火墙：未确认零执行
  });

  test("存在性引导式校验：session 不存在 → toolResult 引导（提示 query_recent_work），循环继续直答", async () => {
    const llm = fakeLlm([
      toolCall("call-1", "deliver_to_session", { sessionId: "ghost", text: "hello" }),
      { kind: "text", text: "没有找到该会话" },
    ]);
    const sessions = fakeCockpitSessions();
    const { svc } = makeService({ llm, sessions });
    const res = await svc.ask("递给 ghost 会话");
    expect(res.status).toBe("answer"); // 引导式失败不终断——LLM 收 toolResult 后继续
    const history = await svc.getHistory();
    const guidance = history.find(
      (r) => r.kind === "toolResult" && r.name === "deliver_to_session",
    );
    expect(guidance).toBeDefined();
    if (guidance?.kind !== "toolResult") throw new Error("unreachable");
    expect(guidance.text).toContain("不存在");
    expect(guidance.text).toContain("query_recent_work");
    expect(sessions.deliveries.length).toBe(0);
  });

  test("confirm 放行：投递到达 sessions 源（sessionId + 原文）+ steward.navigate 广播目标会话", async () => {
    const llm = fakeLlm([
      toolCall("call-1", "deliver_to_session", { sessionId: "sess-2", text: "把测试补上" }),
    ]);
    const sessions = fakeCockpitSessions();
    const { svc, navigates } = makeService({ llm, sessions });
    const res = await svc.ask("对第二个会话说：把测试补上");
    if (res.status !== "confirm_required") throw new Error(`expect confirm_required, got ${res.status}`);
    const confirmed = await svc.confirm(res.actionId);
    expect(confirmed.status).toBe("ok");
    expect(sessions.deliveries).toEqual([{ sessionId: "sess-2", text: "把测试补上" }]);
    expect(navigates).toEqual([{ sessionId: "sess-2" }]); // 投递成功 → 切页指令
  });

  test("投递失败：confirm 回 error 回执 + 零 navigate（切页只在成功后）", async () => {
    const llm = fakeLlm([
      toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "hi" }),
    ]);
    const sessions = fakeCockpitSessions({ deliverOutcome: { delivered: false, detail: "目标会话正在中断，请稍后再发" } });
    const { svc, navigates } = makeService({ llm, sessions });
    const res = await svc.ask("递话");
    if (res.status !== "confirm_required") throw new Error("unreachable");
    const confirmed = await svc.confirm(res.actionId);
    expect(confirmed.status).toBe("error");
    expect(sessions.deliveries.length).toBe(1); // 执行面被调（结果 = 拒绝）
    expect(navigates.length).toBe(0);
  });

  test("确认闸单次消费：actionId 二次 confirm → error（既有语义不回退）", async () => {
    const llm = fakeLlm([
      toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "hi" }),
    ]);
    const sessions = fakeCockpitSessions();
    const { svc } = makeService({ llm, sessions });
    const res = await svc.ask("递话");
    if (res.status !== "confirm_required") throw new Error("unreachable");
    await svc.confirm(res.actionId);
    const again = await svc.confirm(res.actionId);
    expect(again.status).toBe("error");
    expect(sessions.deliveries.length).toBe(1); // 恰一次执行
  });
});

// ── 2. create_session：建完即切 ───────────────────────────

describe("驾驶舱：create_session 建完即切", () => {
  test("confirm 成功 → steward.navigate 携新建 sessionId", async () => {
    const llm = fakeLlm([
      toolCall("call-1", "create_session", { title: "重构调度器" }),
    ]);
    const sessions = fakeCockpitSessions();
    const { svc, navigates } = makeService({ llm, sessions });
    const res = await svc.ask("开个新会话，主题重构调度器");
    if (res.status !== "confirm_required") throw new Error("unreachable");
    const confirmed = await svc.confirm(res.actionId);
    expect(confirmed.status).toBe("ok");
    expect(navigates).toEqual([{ sessionId: "sess-new-1" }]); // 建完即切（用户语义）
  });
});

// ── 3. 意图路由（prompt 段 + 工具目录） ─────────────────────

describe("驾驶舱：意图路由三分类（system prompt 契约）", () => {
  test("prompt 含路由段：问管家 / 开新会话 / 对会话说 三分类 + deliver_to_session 引导", () => {
    expect(STEWARD_SYSTEM_PROMPT).toContain("意图路由");
    expect(STEWARD_SYSTEM_PROMPT).toContain("问管家");
    expect(STEWARD_SYSTEM_PROMPT).toContain("开新会话");
    expect(STEWARD_SYSTEM_PROMPT).toContain("对会话说");
    expect(STEWARD_SYSTEM_PROMPT).toContain("deliver_to_session");
    expect(STEWARD_SYSTEM_PROMPT).toContain("query_recent_work");
  });

  test("工具目录含 deliver_to_session：required = sessionId + text", async () => {
    const llm = fakeLlm([{ kind: "text", text: "好的" }]);
    const sessions = fakeCockpitSessions();
    const { svc } = makeService({ llm, sessions });
    await svc.ask("在吗");
    const tools = llm.calls[0]!.request.tools;
    const tool = tools.find((t) => t.name === "deliver_to_session");
    expect(tool).toBeDefined();
    const params = (tool?.parameters ?? {}) as { required?: string[] };
    expect(params.required).toContain("sessionId");
    expect(params.required).toContain("text");
  });
});

// ── 4. EventStream.broadcastStewardNavigate（订阅闸门） ─────

describe("驾驶舱：EventStream.broadcastStewardNavigate", () => {
  test("仅已订阅 steward 的连接收帧；帧形 = channel steward / type steward.navigate / payload {sessionId}", () => {
    const es = new EventStream();
    const subFrames: unknown[] = [];
    const otherFrames: unknown[] = [];
    const subSender = (f: unknown) => subFrames.push(f);
    const otherSender = (f: unknown) => otherFrames.push(f);
    es.attach(subSender);
    es.attach(otherSender);
    es.subscribeSteward(subSender);
    es.broadcastStewardNavigate({ sessionId: "sess-1" });
    expect(subFrames.length).toBe(1);
    const frame = subFrames[0] as { channel?: string; type: string; sessionId: string; payload: { sessionId: string } };
    expect(frame.type).toBe("steward.navigate");
    expect(frame.channel).toBe("steward");
    expect(frame.sessionId).toBe("__system__");
    expect(frame.payload).toEqual({ sessionId: "sess-1" });
    expect(otherFrames.length).toBe(0); // 未订阅连接零投递
  });
});

// ── 5. 路由纠偏（管家拒绝走 deliver_to_session 修复批） ──────

describe("管家路由纠偏：会话投递主通道化（prompt 契约 + 行为锁）", () => {
  /** 意图路由段子串（段内序断言的锚定窗口——prompt 全文其他段（职责三分法）
   *  也提及两工具名，序断言必须锚在路由段内才有效）。 */
  const routingSection = STEWARD_SYSTEM_PROMPT.slice(STEWARD_SYSTEM_PROMPT.indexOf("意图路由"));

  test("路由段内 deliver_to_session 条目排在 propose_send 之前（用户意图主通道在前）", () => {
    const deliver = routingSection.indexOf("deliver_to_session");
    const send = routingSection.indexOf("propose_send");
    expect(deliver).toBeGreaterThanOrEqual(0);
    expect(send).toBeGreaterThanOrEqual(0);
    expect(deliver).toBeLessThan(send);
  });

  test("路由判据 = 目标语义：对会话/继续话题/发到会话 → deliver_to_session，且明示无论目标会话是否空闲", () => {
    expect(routingSection).toContain("对会话说");
    expect(routingSection).toContain("无论目标会话是否空闲");
    expect(routingSection).toContain("继续那个话题");
  });

  test("propose_send 收窄为 SubAgent 补充通道：须明确指向运行中的 agent 实例", () => {
    expect(routingSection).toContain("propose_send");
    expect(routingSection).toContain("补充通道");
    expect(routingSection).toContain("运行中的 agent");
  });

  test("反判例行：不得以『没有运行中的 agent 实例』为由拒绝会话投递；空闲投递自动开新轮次是正常路径", () => {
    expect(STEWARD_SYSTEM_PROMPT).toContain("没有运行中的 agent 实例");
    expect(STEWARD_SYSTEM_PROMPT).toContain("空闲会话投递会自动开新轮次");
    expect(STEWARD_SYSTEM_PROMPT).toContain("正常路径");
  });

  test("工作记忆治理：历史自述冲突时以本规则为准（热修历史判例路径依赖）", () => {
    expect(STEWARD_SYSTEM_PROMPT).toContain("以本规则为准");
  });

  test("行为锁（目标会话空闲）：LLM 提案 deliver_to_session → confirm_required（不因无运行中实例被拒）", async () => {
    const llm = fakeLlm([
      toolCall("call-1", "deliver_to_session", { sessionId: "sess-idle", text: "继续调研语音链路" }),
    ]);
    const sessions = fakeCockpitSessions({ existing: ["sess-idle"] });
    // 空闲形态：orchestration 零运行中实例（fakeOrchestration status() 恒空）
    const { svc } = makeService({ llm, sessions });
    const res = await svc.ask("发到那个会话");
    expect(res.status).toBe("confirm_required"); // 服务面无 agentId 前置——空闲会话照样成案
    expect(sessions.deliveries.length).toBe(0); // 未确认零执行不变
  });

  test("行为锁（目标会话 running）：同一提案通道——deliver_to_session 不被劫持到 propose_send", async () => {
    const llm = fakeLlm([
      toolCall("call-1", "deliver_to_session", { sessionId: "sess-running", text: "把结论写进报告" }),
    ]);
    const sessions = fakeCockpitSessions({ existing: ["sess-running"] });
    const { svc } = makeService({ llm, sessions });
    const res = await svc.ask("发到那个会话");
    expect(res.status).toBe("confirm_required");
    if (res.status !== "confirm_required") throw new Error("unreachable");
    expect(res.agentId).toBe("sess-running"); // 提案形态 = session 投递（非 agentId 递话）
  });
});
