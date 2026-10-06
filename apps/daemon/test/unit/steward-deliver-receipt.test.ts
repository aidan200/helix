/**
 * 管家语音交互闭环批 ④ 投递反馈简化（用户第 10 项设计决策落地；TDD 红→绿）。
 *
 * 病根（2026-10-06 22:15 事故链复盘）：投递回执 detail 念 sessionId（用户听
 *不懂），确认受理回执机械（「已确认执行（sess-4f78…）」）；目标会话明明有
 * 人类可读标题（title > topic > firstUserText）却查而不显。
 *
 * 断言面（brief ④ 测试要求逐条）：
 * 1. formatDeliverReceipt（纯函数单源）：
 *    - 有短标题：idle → 「已投递到『<标题>』会话」；steered → 「已加入『<标题>』
 *      执行队列」——两分支均不念 sessionId；
 *    - 标题缺失：回退现文案（含 sessionId 的旧 copy——不空指针不空串）。
 * 2. deliver 提案 displayTarget 带短标题（提案期查 sessionTitleOf 轻量单会话
 *    查询——非全量列表）；标题缺失回退 sessionId。
 * 3. confirm 受理回执（口令路由路径）口语化带短标题——不念裸 sessionId。
 *
 * 约束（kg 切片）：E-204 两段式核心语义不动（受理即回/action.completed 回执
 * 不变）；投递 steer 队列/新轮次分流语义不动（B1）；TR-240 pendingKeyOf 键域
 * 不动（deliver 键仍 sessionId|contentHash——displayTarget 只是显示面）。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { AgentOrchestrationPort, AgentInstanceStatus } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import { StewardService, formatDeliverReceipt, DELIVER_TITLE_MAX_CHARS } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";

// ── fakes（steward-reliability.test.ts 同构——最小面探针） ─────────

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort {
  let round = 0;
  return {
    modelId: "fake/flash",
    async complete(_request: StewardLlmRequest): Promise<StewardLlmResponse> {
      const next = script[round];
      round += 1;
      if (next === undefined) throw new Error(`fake LLM 剧本耗尽（round=${round - 1}）`);
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

function fakeOrchestration(statuses: readonly AgentInstanceStatus[]) {
  return {
    status: (agentId?: string): AgentInstanceStatus[] =>
      agentId === undefined ? [...statuses] : statuses.filter((s) => s.agentId === agentId),
    send: () => ({ delivered: true, detail: "已投递" }),
  } as unknown as Pick<AgentOrchestrationPort, "status" | "send">;
}

const AGENT_1_RUNNING: AgentInstanceStatus = {
  agentId: "agent-1",
  state: "running",
  displayState: "active",
  profileKind: "subagent-worker",
  task: "修复登录超时",
};

/** ④ 会话源 fake：sessionTitleOf 轻量单会话标题查询（生产 = repo.readSessionTitle）。 */
function fakeSessions(opts: { titleOf?: (sessionId: string) => string | undefined } = {}) {
  return {
    listSessionMetadata: async () => [] as never[],
    startDraftSession: async () => ({ sessionId: "sess-new" }),
    createTitledSession: async () => ({ sessionId: "sess-new" }),
    sessionExists: async (_sessionId: string) => true,
    ...(opts.titleOf !== undefined
      ? { sessionTitleOf: async (sessionId: string) => Promise.resolve(opts.titleOf!(sessionId)) }
      : {}),
    deliverToSession: async () => ({ delivered: true, detail: "已投递" }),
    readSessionTail: async () => undefined,
  };
}

function makeService(opts: { llm: StewardLlmPort; sessions?: unknown; nowRef?: { now: number }; withAgent?: boolean }) {
  const notifies: unknown[] = [];
  const innerCreate = createEngineFromPort(opts.llm);
  const svc = new StewardService({
    llm: opts.llm,
    orchestration: fakeOrchestration(opts.withAgent === true ? [AGENT_1_RUNNING] : []),
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    dialog: new StewardDialogMemory(fakeDialogStore()),
    ...(opts.nowRef !== undefined ? { clock: () => opts.nowRef!.now } : {}),
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => undefined,
    emitNotify: (payload: unknown) => notifies.push(payload),
    ...(opts.sessions !== undefined ? { sessions: opts.sessions as never } : {}),
    createEngine: (engineOpts) => {
      const inner = innerCreate(engineOpts);
      return {
        start: (input: string, listener: unknown, images?: readonly string[]) => inner.start(input, listener as never, images),
        steer: (text: string) => inner.steer(text),
        abort: () => inner.abort(),
        isStreaming: () => inner.isStreaming(),
        ...(inner.resume !== undefined ? { resume: (t: string, d: never) => inner.resume!(t, d) } : {}),
        ...(inner.setSystemPrompt !== undefined ? { setSystemPrompt: (t: string) => inner.setSystemPrompt!(t) } : {}),
      };
    },
  });
  return { svc, notifies };
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

const toolCall = (name: string, args: Record<string, unknown>): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "toolCall", id: `call-${name}`, name, args }],
  stopReason: "toolUse",
});
const answer = (text: string): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "text", text }],
  stopReason: "stop",
});

// ── 1. formatDeliverReceipt 纯函数 ─────────────────────────

describe("④ 投递回执纯函数（formatDeliverReceipt——标题直拼零 LLM）", () => {
  test("有短标题：idle 分支「已投递到『标题』会话」、steered 分支「已加入『标题』执行队列」——均不念 sessionId", () => {
    const idle = formatDeliverReceipt("F7-8 端口排查", "new", "sess-4f782ae8");
    expect(idle).toContain("F7-8 端口排查");
    expect(idle).toContain("已投递到");
    expect(idle).not.toContain("sess-4f782ae8");

    const busy = formatDeliverReceipt("F7-8 端口排查", "steered", "sess-4f782ae8");
    expect(busy).toContain("F7-8 端口排查");
    expect(busy).toContain("已加入");
    expect(busy).toContain("执行队列");
    expect(busy).not.toContain("sess-4f782ae8");
  });

  test("标题缺失：两分支回退现文案（含 sessionId——不空指针不空串）", () => {
    const idle = formatDeliverReceipt(undefined, "new", "sess-4f782ae8");
    expect(idle).toContain("sess-4f782ae8");
    expect(idle.length).toBeGreaterThan(4);

    const busy = formatDeliverReceipt(undefined, "steered", "sess-4f782ae8");
    expect(busy).toContain("sess-4f782ae8");
    expect(busy.length).toBeGreaterThan(4);
  });

  test("超长短标题截断（DELIVER_TITLE_MAX_CHARS——回执不念长文）", () => {
    const long = "这是一个特别特别特别特别特别特别长的会话标题远超上限的场外文案";
    const receipt = formatDeliverReceipt(long, "new", "sess-x");
    expect(receipt).toContain("…"); // 截断标记在场
    expect(receipt).not.toContain("场外文案"); // 超限尾部不进回执
    const cappedTitle = receipt.slice("已投递到「".length, receipt.indexOf("…"));
    expect([...cappedTitle].length).toBeLessThanOrEqual(DELIVER_TITLE_MAX_CHARS);
  });
});

// ── 2. deliver 提案 displayTarget 带短标题 ──────────────────

describe("④ deliver 提案 displayTarget（提案期轻量标题查询）", () => {
  test("sessionTitleOf 命中 → confirm_required.agentId/displayTarget = 短标题（非 sessionId）", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "sess-4f782ae8", text: "暂时显示F七八号" }),
      answer("后续答"),
    ]);
    const { svc } = makeService({
      llm,
      sessions: fakeSessions({ titleOf: (id) => (id === "sess-4f782ae8" ? "F7-8 端口排查" : undefined) }),
    });
    const first = await svc.ask("现在投递的应该是另一个对话");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    expect(first.agentId).toBe("F7-8 端口排查");
  });

  test("标题缺失 → displayTarget 回退 sessionId（不空指针）", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "sess-4f782ae8", text: "话" }),
      answer("后续答"),
    ]);
    const { svc } = makeService({ llm, sessions: fakeSessions({ titleOf: () => undefined }) });
    const first = await svc.ask("投递");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    expect(first.agentId).toBe("sess-4f782ae8");
  });

  test("sessionTitleOf 查询抛错 → 回退 sessionId（提案不因标题查询失败而断）", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "sess-4f782ae8", text: "话" }),
      answer("后续答"),
    ]);
    const brokenTitleOf = {
      ...fakeSessions(),
      sessionTitleOf: async () => {
        throw new Error("db busy");
      },
    };
    const { svc } = makeService({ llm, sessions: brokenTitleOf });
    const first = await svc.ask("投递");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    expect(first.agentId).toBe("sess-4f782ae8");
  });

  test(`超长标题截断至 ${DELIVER_TITLE_MAX_CHARS} 码点（displayTarget 短名）`, async () => {
    const long = "这是一个特别特别特别特别特别特别长的会话标题远超上限的场外文案";
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "sess-x", text: "话" }),
      answer("后续答"),
    ]);
    const { svc } = makeService({
      llm,
      sessions: fakeSessions({ titleOf: () => long }),
    });
    const first = await svc.ask("投递");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    expect([...first.agentId].length).toBeLessThanOrEqual(DELIVER_TITLE_MAX_CHARS + 1); // 截断标记容差
  });
});

// ── 3. confirm 受理回执口语化 ─────────────────────────────

describe("④ confirm 受理回执（口令路由路径——语音一句话，零额外卡/toast）", () => {
  test("deliver 卡口令确认 → answer 文本口语化带短标题，不念裸 sessionId", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "sess-4f782ae8", text: "暂时显示F七八号" }),
      answer("后续答"),
    ]);
    const { svc, notifies } = makeService({
      llm,
      sessions: fakeSessions({ titleOf: () => "F7-8 端口排查" }),
      nowRef: { now: 0 },
    });
    const first = await svc.ask("投递到那个会话");
    expect(first.status).toBe("confirm_required");

    const receipt = await svc.ask("确认执行");
    expect(receipt.status).toBe("answer");
    if (receipt.status !== "answer") throw new Error("unreachable");
    expect(receipt.text).toContain("F7-8 端口排查");
    expect(receipt.text).not.toContain("sess-4f782ae8");
    await settle();
    // 受理回执即语音一句话：confirm 路径零额外 notify 卡（纯语音反馈）
    expect(notifies.length).toBe(0);
  });

  test("非 deliver 卡口令确认 → 维持现回执形态（带 displayTarget）", async () => {
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话" }),
      answer("后续答"),
    ]);
    const { svc } = makeService({ llm, withAgent: true });
    const first = await svc.ask("递话给 agent-1");
    expect(first.status).toBe("confirm_required");
    const receipt = await svc.ask("确认执行");
    expect(receipt.status).toBe("answer");
    if (receipt.status !== "answer") throw new Error("unreachable");
    expect(receipt.text).toContain("agent-1");
    expect(receipt.text).toContain("已确认执行");
  });
});
