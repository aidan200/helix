/**
 * 管家确认-执行-回执链路修复批单测（2026-10-06 12:13-12:28 事故链——TDD 红→绿）。
 *
 * 事故时间线（UTC+8）取材：
 * - 12:16:58 run#2 弹卡 action-1 → 12:17:16 用户点卡 → run 已中止凭据不可复用
 *   → run error（T5：run error 后卡凭据续活 + error 日志带原因）；
 * - run#3/#5/#7 三次 run error 日志无原因（T5：收口日志附引擎错误摘要）；
 * - 用户每次重述 → 新提案 → 新卡：action-2..7 六张卡同目标同内容并存（T1：
 *   在途提案登记簿幂等）；
 * - 12:25:08 action-5 确认成功送达 → 12:25:36 起 action-3/4/6/7 陆续 TTL 弹
 *   「失效投递」通知（T2：终局即收敛 + T6：通知去重）；
 * - 12:27:45 用户语音「确认了很多遍」被当新指令又弹 action-7（T3：口令路由）。
 *
 * 断言面（brief 测试要求 T1-T6 逐条；T7 回归 = 全量测试差分）。
 * 约束（kg 切片）：E-204 两段式语义不变（单次消费/受理即回/action.completed/
 * cancel 先删后执行）；E-240 队列行为断言等价；E-206 G8+跨重启残项本批收编
 * （收敛广播全订阅者 + pending.snapshot 清场帧）；E-250 notify 限流之上叠
 * 加去重（不替代）。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { AgentOrchestrationPort, AgentInstanceStatus } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type {
  StewardActionCompletedPayload,
  StewardAskResultPayload,
  StewardNotifyPayload,
} from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { EventEnvelope, StewardPendingSnapshotPayload } from "@helix/protocol";
import { handleStewardSubscribe } from "../../src/adapters/driving/ws-server/handlers/steward";

// ── fakes（最小面——只装本批断言需要的探针） ─────────────────

function fakeLlm(script: readonly StewardLlmResponse[], throws: ReadonlySet<number> = new Set()): StewardLlmPort {
  let round = 0;
  return {
    modelId: "fake/flash",
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      const current = round;
      round += 1;
      if (throws.has(current)) throw new Error("glm-5.3 引擎连接失败（provider 503）");
      const next = script[current];
      if (next === undefined) throw new Error(`fake LLM 剧本耗尽（round=${current}）`);
      void request;
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
  const sends: { agentId: string; message: string }[] = [];
  return {
    sends,
    status: (agentId?: string): AgentInstanceStatus[] =>
      agentId === undefined ? [...statuses] : statuses.filter((s) => s.agentId === agentId),
    send: (agentId: string, message: string): { delivered: boolean; detail: string } => {
      sends.push({ agentId, message });
      const target = statuses.find((s) => s.agentId === agentId && s.state === "running");
      if (target === undefined) return { delivered: false, detail: `实例 ${agentId} 非运行中` };
      return { delivered: true, detail: "已投递（turn 边界注入生效）" };
    },
  } as unknown as Pick<AgentOrchestrationPort, "status" | "send"> & { sends: typeof sends };
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

function fakeSurfaces() {
  const acts: { surfaceId: string; verb: string }[] = [];
  return {
    acts,
    list: async () => [],
    snapshot: async () => ({ ok: true, text: "page" }),
    read: async () => ({ ok: true, text: "page" }),
    act: async (req: { surfaceId: string; verb: string }) => {
      acts.push({ surfaceId: req.surfaceId, verb: req.verb });
      return { ok: true, seq: acts.length, detail: "click 完成" };
    },
  };
}

function fakeLogger() {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
  };
}

interface ServiceFixture {
  readonly svc: StewardService;
  readonly orchestration: ReturnType<typeof fakeOrchestration>;
  readonly sessions: ReturnType<typeof fakeSessions>;
  readonly surfaces: ReturnType<typeof fakeSurfaces>;
  readonly notifies: StewardNotifyPayload[];
  readonly actionCompleted: StewardActionCompletedPayload[];
  readonly logger: ReturnType<typeof fakeLogger>;
  /** 回合终态关注注册探针（onDelivered 接线验证）。 */
  readonly onDeliveredCalls: { sessionId: string; text?: string }[];
}

/** 本批服务装配：deliver/surface 执行面探针 + notify/actionCompleted 广播探针。 */
function makeService(opts: { llm: StewardLlmPort; nowRef?: { now: number }; sessions?: boolean; surfaces?: boolean }): ServiceFixture {
  const nowRef = opts.nowRef ?? { now: 0 };
  const notifies: StewardNotifyPayload[] = [];
  const actionCompleted: StewardActionCompletedPayload[] = [];
  const logger = fakeLogger();
  const orchestration = fakeOrchestration([
    { agentId: "agent-1", state: "running", displayState: "active", profileKind: "subagent-worker", task: "部署服务" },
  ]);
  const sessions = fakeSessions();
  const surfaces = fakeSurfaces();
  const onDeliveredCalls: { sessionId: string; text?: string }[] = [];
  const innerCreate = createEngineFromPort(opts.llm);
  const svc = new StewardService({
    llm: opts.llm,
    orchestration,
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    dialog: new StewardDialogMemory(fakeDialogStore()),
    clock: () => nowRef.now,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => undefined,
    emitNotify: (payload) => notifies.push(payload),
    emitActionCompleted: (payload) => actionCompleted.push(payload),
    logger,
    ...(opts.sessions === true ? { sessions } : {}),
    ...(opts.surfaces === true ? { surfaces } : {}),
    ...(opts.sessions === true ? { onDelivered: (sessionId: string, text?: string) => onDeliveredCalls.push({ sessionId, text }) } : {}),
    createEngine: (engineOpts) => innerCreate(engineOpts),
  });
  return { svc, orchestration, sessions, surfaces, notifies, actionCompleted, logger, onDeliveredCalls };
}

/** 微任务/投影链排空（多轮 setTimeout(1)——abort→finishRun→队列驱动全链 settle）。 */
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

/** 挂闸弹卡快捷面：ask → confirm_required（actionId 提取）。 */
async function askForCard(svc: StewardService, text: string): Promise<{ actionId: string; message: string }> {
  const outcome = await svc.ask(text);
  if (outcome.status !== "confirm_required") throw new Error(`预期 confirm_required，实际 ${outcome.status}`);
  return { actionId: outcome.actionId, message: outcome.message };
}

// ── T1 在途提案登记簿（幂等：同 key 复用旧卡同 actionId） ─────────

describe("T1 登记簿幂等：同 key 提案仅一张卡（治事故 action-2..7 六卡并存）", () => {
  test("run error 后用户重述 → 同提案复用旧卡返回同 actionId（不新弹不新凭据）", async () => {
    // 事故形态：run#2 弹卡后 run error；用户重述「对。确认。」→ 管家新提案同内容
    const llm = fakeLlm(
      [
        toolCall("propose_send", { agentId: "agent-1", message: "重启部署服务并验证健康检查" }),
        answer("占位（run#3 轮——实际 throw）"),
        toolCall("propose_send", { agentId: "agent-1", message: "重启部署服务并验证健康检查" }),
        answer("已有一张待确认卡，请在卡片上确认"),
      ],
      new Set([1]), // run#3 轮引擎失败（事故 glm-5.3 形态）
    );
    const { svc } = makeService({ llm });
    const first = await askForCard(svc, "让 agent-1 重启部署服务");
    expect(first.actionId).toBe("steward-action-1");

    // run#2 error 收口（新 ask 触发 abort-再驱动 + 引擎失败——事故 run#3 形态）
    const secondAsk = svc.ask("对。确认。");
    await settle();
    const second = await secondAsk;
    expect(second.status).toBe("error"); // 引擎失败如实交代（重述轮）

    // 重述后再提案（新 run）→ 复用旧卡：同 actionId、pending 仍只一张
    const third = await askForCard(svc, "重启部署服务");
    expect(third.actionId).toBe(first.actionId); // 幂等：同 key 同 actionId
    expect(svc.pendingSnapshot().length).toBe(1);
  });

  test("已成功的同 key 提案 → 不弹卡，LLM 收「已执行过」回灌（run 终答）", async () => {
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话：加快进度" }),
      answer("该操作此前已执行过（steward-action-1），无需重复确认。"),
    ]);
    const { svc, orchestration } = makeService({ llm });
    const card = await askForCard(svc, "递话给 agent-1");
    const confirmed = await svc.confirm(card.actionId);
    expect(confirmed.status).toBe("accepted");
    await settle();
    expect(orchestration.sends.length).toBe(1); // 真执行了一次

    // 已成功后再提案同内容 → 无新卡，run 拿「已执行过」toolResult 终答
    const again = await svc.ask("再递一次同样的话");
    expect(again.status).toBe("answer");
    if (again.status !== "answer") throw new Error("unreachable");
    expect(again.text).toContain("已执行过");
    expect(svc.pendingSnapshot().length).toBe(0); // 零新卡
    expect(orchestration.sends.length).toBe(1); // 零重复执行
  });

  test("已作废（cancel）的同 key 提案 → 按新提案处理（新 actionId 弹新卡）", async () => {
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话：切换分支" }),
      toolCall("propose_send", { agentId: "agent-1", message: "递话：切换分支" }),
      answer("已重新提案"),
    ]);
    const { svc, orchestration } = makeService({ llm });
    const first = await askForCard(svc, "递话切换分支");
    svc.cancel(first.actionId); // 用户放弃（挂闸 run 保留旗 → 下述 abort 唤醒收口）
    svc.abortInFlight("放弃后收口挂闸 run");
    await settle();
    expect(orchestration.sends.length).toBe(0); // 作废零执行

    const second = await askForCard(svc, "还是递话切换分支");
    expect(second.actionId).not.toBe(first.actionId); // 新提案新凭据
    expect(svc.pendingSnapshot().length).toBe(1);
  });
});

// ── T2 终局即收敛（同 key 其余卡静默撤除，全订阅者广播） ─────────

describe("T2 终局收敛：任一卡终局 → 同 key 其余卡静默撤除（治「已送达后又弹失效通知」）", () => {
  test("action-A 成功 → 同 key 卡 B 收敛撤除：广播 superseded 帧 + 零失效通知", async () => {
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话：重新部署" }),
      answer("已确认"),
    ]);
    const { svc, actionCompleted, notifies } = makeService({ llm });
    const cardA = await askForCard(svc, "递话重新部署");

    // 防御纵深测试接缝：直接向 pending 注入同 key 卡 B（登记簿正常路径已防
    // 并存；收敛机制作为纵深仍须可断言——key 相同 = action 内容相同）
    const internal = (svc as unknown as { core: { ledger: { pending: Map<string, { action: unknown; createdAt: number; remindedAt: number | undefined }> } } }).core.ledger; // 批 1 接缝迁移：pending 已收编 ProposalLedger；体量门 P4：登记簿随内核迁 StewardCore（防御纵深注入面不变）
    const entryA = internal.pending.get(cardA.actionId)!;
    internal.pending.set("steward-action-901", {
      action: entryA.action,
      createdAt: 0,
      remindedAt: undefined,
    });
    expect(svc.pendingSnapshot().length).toBe(2);

    await svc.confirm(cardA.actionId);
    await settle();
    expect(svc.pendingSnapshot().length).toBe(0); // B 已随 A 终局收敛
    const superseded = actionCompleted.filter((p) => (p as { outcome?: string }).outcome === "superseded");
    expect(superseded.length).toBe(1); // B 的收敛帧（全订阅者广播出口）
    expect(superseded[0]!.actionId).toBe("steward-action-901");
    // 零「失效投递」类通知（收敛静默——不 emitNotify）
    expect(notifies.filter((n) => n.body.includes("作废") || n.body.includes("失效"))).toHaveLength(0);
  });

  test("TTL 作废同样收敛：outcome=timeout 帧标注 + 同 key 其余卡撤除", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([toolCall("propose_send", { agentId: "agent-1", message: "递话：重试" })]);
    const { svc, actionCompleted } = makeService({ llm, nowRef });
    const cardA = await askForCard(svc, "递话重试");
    const internal = (svc as unknown as { core: { ledger: { pending: Map<string, { action: unknown; createdAt: number; remindedAt: number | undefined }> } } }).core.ledger; // 批 1 接缝迁移：pending 已收编 ProposalLedger；体量门 P4：登记簿随内核迁 StewardCore（防御纵深注入面不变）
    const entryA = internal.pending.get(cardA.actionId)!;
    internal.pending.set("steward-action-902", { action: entryA.action, createdAt: 0, remindedAt: undefined });

    nowRef.now = 300_001;
    svc.reliabilityTick();
    await settle();
    expect(svc.pendingSnapshot().length).toBe(0); // A 与 B 均不在 pending
    const timeouts = actionCompleted.filter((p) => (p as { outcome?: string }).outcome === "timeout");
    expect(timeouts.length).toBeGreaterThanOrEqual(1); // A 的作废帧带 outcome 标注
    const superseded = actionCompleted.filter((p) => (p as { outcome?: string }).outcome === "superseded");
    expect(superseded.length).toBe(1); // B 收敛帧
  });
});

// ── T3 确认口令路由（词表命中绑定最近 pending 卡，零 LLM） ─────────

describe("T3 口令路由：「确认执行」消费最近 pending 卡（治「确认了很多遍」又弹新卡）", () => {
  test("pending 卡存在时输入「确认执行」→ 卡被消费且 deliver 真执行（不经 LLM 新提案）", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "s-1", text: "继续执行部署计划" }),
      answer("不应走到这里（口令路由不应再进 LLM 轮）"),
    ]);
    const { svc, sessions, actionCompleted } = makeService({ llm, sessions: true });
    const card = await askForCard(svc, "把部署计划发给会话 s-1");
    expect(card.actionId).toBe("steward-action-1");

    // 用户语音/文字口令 → 绑定最近 pending 卡消费
    const outcome = await svc.ask("确认执行");
    expect(outcome.status).toBe("answer");
    if (outcome.status !== "answer") throw new Error("unreachable");
    expect(outcome.text).toContain("已确认");
    await settle();
    expect(sessions.deliveries.length).toBe(1); // deliver 真执行
    expect(sessions.deliveries[0]!.sessionId).toBe("s-1");
    expect(svc.pendingSnapshot().length).toBe(0); // 卡已消费
    // 执行回执经广播出口交代（口令来自任意连接——全订阅者帧）
    const done = actionCompleted.find((p) => p.actionId === card.actionId);
    expect(done).toBeDefined();
    expect(done!.ok).toBe(true);
  });

  test("「不要了」→ cancel 语义：卡作废零执行", async () => {
    const llm = fakeLlm([toolCall("deliver_to_session", { sessionId: "s-1", text: "内容" })]);
    const { svc, sessions } = makeService({ llm, sessions: true });
    await askForCard(svc, "发给 s-1");
    const outcome = await svc.ask("不要了");
    expect(outcome.status).toBe("answer");
    if (outcome.status !== "answer") throw new Error("unreachable");
    expect(outcome.text).toContain("已放弃");
    expect(svc.pendingSnapshot().length).toBe(0);
    await settle();
    expect(sessions.deliveries.length).toBe(0); // 零执行
  });

  test("无 pending 卡时「确认执行」原样走 LLM（不路由不误答）", async () => {
    const llm = fakeLlm([answer("目前没有待确认的操作——请先提出要做的事。")]);
    const { svc } = makeService({ llm });
    const outcome = await svc.ask("确认执行");
    expect(outcome.status).toBe("answer");
    if (outcome.status !== "answer") throw new Error("unreachable");
    expect(outcome.text).toContain("没有待确认");
  });

  test("非全等口令（长句）不路由：卡保留，走 LLM 轮", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "s-1", text: "内容" }),
      answer("好——你说的是要我做别的事吗？"),
    ]);
    const { svc } = makeService({ llm, sessions: true });
    await askForCard(svc, "发给 s-1");
    const outcome = await svc.ask("请帮我确认执行一下那个部署计划吧");
    expect(outcome.status).toBe("answer"); // 走 LLM（非全等口令零路由）
    expect(svc.pendingSnapshot().length).toBe(1); // 卡未被误消费
  });
});

// ── T4 生命周期统一（启动清场 + 死卡用户语义） ─────────

describe("T4 跨重启清场与死卡语义", () => {
  test("服务重建（daemon 重启模拟）→ pendingSnapshot 空集；点死卡回用户语义非内部异常", async () => {
    const llm = fakeLlm([toolCall("propose_send", { agentId: "agent-1", message: "递话" })]);
    const { svc } = makeService({ llm });
    await askForCard(svc, "递话");
    // daemon 重启 = 服务重建（内存 pending 不持久化——事故中 shell 残卡场景）
    const rebooted = makeService({ llm: fakeLlm([]) });
    expect(rebooted.svc.pendingSnapshot()).toEqual([]);

    // 点重启前的旧卡 → 用户语义提示（非「审批闸未知 pauseToken」类内部异常）
    const outcome = await rebooted.svc.confirm("steward-action-1");
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("unreachable");
    expect(outcome.reason).toContain("已失效");
    expect(outcome.reason).not.toContain("pauseToken");
  });
});

// ── T5 run error 后卡续活 + error 收口日志带原因 ─────────

describe("T5 run error：卡凭据续活（deliver 类）+ 收口日志附引擎错误摘要", () => {
  test("run#2 弹卡 → run#3 引擎失败 → confirm 旧卡成功执行（12:25:08 事故兑底）+ error 行含原因", async () => {
    const llm = fakeLlm(
      [
        toolCall("deliver_to_session", { sessionId: "s-1", text: "重启部署服务" }),
        answer("占位（run#3 轮——实际 throw）"),
      ],
      new Set([1]), // run#3 轮引擎失败（glm-5.3 事故形态）
    );
    const { svc, sessions, actionCompleted, logger } = makeService({ llm, sessions: true });
    const card = await askForCard(svc, "把重启指令发给 s-1");

    // run#3：用户重述 → abort run#2 + 新 run 引擎失败收口
    const retried = svc.ask("你这边好像失败了");
    await settle();
    const retryOutcome = await retried;
    expect(retryOutcome.status).toBe("error");

    // ⑤ error 收口日志带引擎错误摘要（事故：三次 run error 日志无原因）
    const errorLines = logger.warns.filter((m) => m.includes("run 收口"));
    expect(errorLines.length).toBeGreaterThanOrEqual(1);
    expect(errorLines.some((m) => m.includes("引擎连接失败"))).toBe(true);

    // ④ 卡凭据续活：confirm 该 run 的卡 → deliver 成功执行（run 死不废投递意图）
    const confirmed = await svc.confirm(card.actionId, (payload) => actionCompleted.push(payload));
    expect(confirmed.status).toBe("accepted");
    await settle();
    expect(sessions.deliveries.length).toBe(1); // 投递真送达
    const done = actionCompleted.find((p) => p.actionId === card.actionId);
    expect(done).toBeDefined();
    expect(done!.ok).toBe(true); // resume 凭据过期降级不吞真实执行结果
    expect(svc.pendingSnapshot().length).toBe(0);
  });

  test("run error 收口时 destructive 卡即时撤除+明示（不可续活）；普通卡续活", async () => {
    const llm = fakeLlm(
      [
        toolCall("act", { surfaceId: "browser:tab-1", verb: "click", args: { selector: "#delete" }, risk: "destructive" }),
        answer("占位（run2 轮——实际 throw）"),
      ],
      new Set([1]),
    );
    const { svc, surfaces, actionCompleted, notifies } = makeService({ llm, surfaces: true });
    const card = await askForCard(svc, "点删除按钮");
    expect(svc.pendingSnapshot().length).toBe(1);

    const retried = svc.ask("失败了？");
    await settle();
    const retryOutcome = await retried;
    expect(retryOutcome.status).toBe("error");

    // destructive 卡已撤除（广播 superseded + 明示通知）
    expect(svc.pendingSnapshot().length).toBe(0);
    const superseded = actionCompleted.filter((p) => (p as { outcome?: string }).outcome === "superseded");
    expect(superseded.length).toBe(1);
    expect(superseded[0]!.actionId).toBe(card.actionId);
    expect(notifies.length).toBe(1); // 明示（一条——不是静默也不是刷屏）
    await settle();
    expect(surfaces.acts.length).toBe(0); // 零执行
  });
});

// ── T4/T6 EventStream 面（清场帧广播 + notify 60s 短窗去重） ─────────

describe("EventStream：pending.snapshot 清场帧（全订阅者广播/点对点回发）", () => {
  test("广播面：仅已订阅 steward 的连接收 steward.pending.snapshot 帧", () => {
    const stream = new EventStream();
    const subscribed: EventEnvelope[] = [];
    const bystander: EventEnvelope[] = [];
    const subSender = (frame: EventEnvelope) => subscribed.push(frame);
    const otherSender = (frame: EventEnvelope) => bystander.push(frame);
    stream.attach(subSender);
    stream.attach(otherSender);
    stream.subscribeSteward(subSender);

    const payload: StewardPendingSnapshotPayload = { actionIds: [] };
    stream.broadcastStewardPendingSnapshot(payload);
    expect(subscribed.length).toBe(1);
    expect(subscribed[0]!.type).toBe("steward.pending.snapshot");
    expect(subscribed[0]!.payload).toEqual({ actionIds: [] });
    expect(bystander.length).toBe(0); // 未订阅连接不收
  });

  test("点对点面：sendStewardPendingSnapshot 直发单连接（订阅对账回执）", () => {
    const stream = new EventStream();
    const frames: EventEnvelope[] = [];
    const sender = (frame: EventEnvelope) => frames.push(frame);
    stream.sendStewardPendingSnapshot(sender, { actionIds: ["steward-action-1"] });
    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe("steward.pending.snapshot");
    expect(frames[0]!.payload).toEqual({ actionIds: ["steward-action-1"] });
  });
});

describe("EventStream：steward.notify 60s 短窗去重（叠加限流之上，不替代）", () => {
  test("同 key（title+body）60s 内两次 broadcast → 只发一帧；窗外再发可达；不同内容不去重", () => {
    const nowRef = { now: 1_000_000 };
    const stream = new EventStream({ clock: () => nowRef.now });
    const frames: EventEnvelope[] = [];
    const sender = (frame: EventEnvelope) => frames.push(frame);
    stream.attach(sender);
    stream.subscribeSteward(sender);

    const notify = (title: string, body: string) =>
      stream.broadcastStewardNotify({ urgency: "normal", title, body, seq: 0 });

    notify("确认已超时", "操作 A 超过 300s 未确认，已自动作废");
    notify("确认已超时", "操作 A 超过 300s 未确认，已自动作废"); // 60s 内重复
    expect(frames.length).toBe(1);

    nowRef.now += 61_000; // 出窗
    notify("确认已超时", "操作 A 超过 300s 未确认，已自动作废");
    expect(frames.length).toBe(2);

    notify("确认已超时", "操作 B 超过 300s 未确认，已自动作废"); // 不同内容（key 异）
    expect(frames.length).toBe(3);
  });
});

describe("handler：steward.subscribe 受理即回发 pending 快照（跨重启对账）", () => {
  test("订阅登记 + 点对点回发当前快照（服务重建后空集即清场指令）", async () => {
    const stream = new EventStream();
    const frames: EventEnvelope[] = [];
    const sender = (frame: EventEnvelope) => frames.push(frame);
    stream.attach(sender); // 订阅登记的前提（连接在册）
    const svc = makeService({ llm: fakeLlm([]) }).svc;
    const ctx = {
      ws: { data: { sender } },
      type: "steward.subscribe",
      payload: {},
      steward: { stream, service: svc },
      commandError: () => {
        throw new Error("不应走到 commandError");
      },
      rawSender: () => sender,
      sendNow: (_sender: unknown, frame: EventEnvelope) => frames.push(frame),
    };
    handleStewardSubscribe(ctx as never);
    await settle(2);
    expect(stream.hasStewardSubscribers()).toBe(true);
    const snapshot = frames.find((f) => f.type === "steward.pending.snapshot");
    expect(snapshot).toBeDefined(); // 订阅即对账（shell 撤旧卡的清场路径）
    expect((snapshot!.payload as { actionIds?: string[] }).actionIds).toEqual([]);
  });
});

// ── T8 start_session 关注注册（回合终态感知覆盖面——治「新会话跑完无通知」） ─────────

describe("T8 start_session 初始话题投递注册回合终态关注", () => {
  test("start_session 确认执行 → 初始话题投递成功 → onDelivered(sessionId, initial_message)", async () => {
    const llm = fakeLlm([
      toolCall("start_session", { title: "找图片工具", initial_message: "帮我找找 AI 生成图片的工具项目" }),
      answer("已开启会话并带入话题。"),
    ]);
    const { svc, onDeliveredCalls } = makeService({ llm, sessions: true });
    const card = await askForCard(svc, "开个新会话帮我找 AI 生成图片的工具项目");
    const confirmed = await svc.confirm(card.actionId);
    expect(confirmed.status).toBe("accepted");
    await settle();
    // 回合终态关注注册：新会话回合结束即命中「那边回完了」分诊锚
    expect(onDeliveredCalls.length).toBe(1);
    expect(onDeliveredCalls[0]?.sessionId).toBe("s-找图片工具");
    expect(onDeliveredCalls[0]?.text).toBe("帮我找找 AI 生成图片的工具项目");
  });

  test("create_session 空会话（无 initial_message）→ 零关注注册（无投递无等待）", async () => {
    const llm = fakeLlm([
      toolCall("create_session", { title: "空会话" }),
      answer("已创建空会话。"),
    ]);
    const { svc, onDeliveredCalls } = makeService({ llm, sessions: true });
    const card = await askForCard(svc, "开个空会话");
    const confirmed = await svc.confirm(card.actionId);
    expect(confirmed.status).toBe("accepted");
    await settle();
    expect(onDeliveredCalls.length).toBe(0); // 空会话无初始投递 → 零关注
  });
});
