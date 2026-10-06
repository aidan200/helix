/**
 * 管家可靠性根修批单测（2026-10-06 19:38 事故根修——TDD 红→绿）。
 *
 * 事故链（已定性）：write 档挂闸 → confirm_required 无入口（快捷键唤不出）
 * → runActive 永真 → finishRun 永不执行 → 后续 ask 永远 queued → 管家装死
 * 20 分钟零日志。死锁三要素：确认闸无超时、run 无看门狗、挂起无日志。
 *
 * 断言面（brief 测试要求逐条）：
 * 1. run 看门狗：注入时钟模拟「run 挂起无事件推进」→ 180s 后 abortInFlight
 *    被调（幂等——同集 episode 二次 tick 不重触）+ 队列恢复（后续 ask 不
 *    queued）+ 挂起通知发出；当前行为：永不恢复（红）。
 * 2. 确认闸 TTL：pending 卡 300s 无 confirm/cancel → 自动作废（复用 cancel
 *    内部语义）+ action.completed {ok:false, detail 含「确认超时」} + 用户
 *    提醒发出；作废后再 confirm 报已消费（单次消费不变量）。
 * 3. confirm_required 可达性：发出后 30s 无人消费 → 提醒帧发出（不重复）。
 * 4. 生命周期日志：run 开始/收口/确认闸暂停/看门狗触发/确认 TTL 作废全打日志。
 * 5. 事故场景端到端：write 档确认无人点 → 看门狗 180s 恢复队列 + 300s 后
 *    自动作废 + 提醒 + 队列可继续服务。
 *
 * 约束（kg 切片）：E-204 两段式确认闸不变（本批只加超时兜底）；E-240
 * askQueue/runActive/finishRun 行为等价（上限 3/queued 双帧/drain 不变）；
 * E-206 pending 跨重启重放不做（只做超时作废）；E-253 act 分险挂闸语义不变
 * （本文件以 propose_send 为 write 档代表——同一确认闸单点，M2 测试另钉 act）。
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
  StewardFeedPayload,
  StewardNotifyPayload,
} from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";

// ── fakes（最小面——只装本批断言需要的探针） ─────────────────

/** 可靠性批服务装配：注入时钟 + notify/actionCompleted/feed 日志探针 +
 *  abort 探针（createEngine 包装——看门狗「abortInFlight 被调」直接断言面）。 */
function makeReliabilityService(opts: {
  llm: StewardLlmPort;
  nowRef: { now: number };
}) {
  const notifies: StewardNotifyPayload[] = [];
  const actionCompleted: StewardActionCompletedPayload[] = [];
  const feeds: StewardFeedPayload[] = [];
  const aborts: number[] = [];
  const logger = fakeLogger();
  const orchestration = fakeOrchestration([
    { agentId: "agent-1", state: "running", displayState: "active", profileKind: "subagent-worker", task: "修复登录超时" },
  ]);
  const innerCreate = createEngineFromPort(opts.llm);
  const svc = new StewardService({
    llm: opts.llm,
    orchestration,
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    dialog: new StewardDialogMemory(fakeDialogStore()),
    clock: () => opts.nowRef.now,
    feedGate: { hasStewardSubscribers: () => false }, // 零订阅 → 自动沉淀零 LLM 消耗（剧本轮次确定性）
    emitFeed: (payload) => feeds.push(payload),
    emitNotify: (payload) => notifies.push(payload),
    emitActionCompleted: (payload) => actionCompleted.push(payload),
    logger,
    createEngine: (engineOpts) => {
      const inner = innerCreate(engineOpts);
      // 探针包装（仅加 abort 计数——其余成员透传，代际守卫比对包装体自身）
      return {
        start: (input: string, listener: unknown, images?: readonly string[]) => inner.start(input, listener as never, images),
        steer: (text: string) => inner.steer(text),
        abort: () => {
          aborts.push(aborts.length);
          inner.abort();
        },
        isStreaming: () => inner.isStreaming(),
        ...(inner.resume !== undefined ? { resume: (t: string, d: never) => inner.resume!(t, d) } : {}),
        ...(inner.setSystemPrompt !== undefined ? { setSystemPrompt: (t: string) => inner.setSystemPrompt!(t) } : {}),
      };
    },
  });
  return { svc, orchestration, notifies, actionCompleted, feeds, logger, aborts };
}

/** 挂起剧本 fake LLM：hangRounds 命中的轮次永不收口（provider 流挂死形态——
 *  pi EventStream 不竞速 abort，正是看门狗强制收口轨的针对场景）。 */
function fakeLlm(script: readonly StewardLlmResponse[], hangRounds: ReadonlySet<number> = new Set()): StewardLlmPort {
  let round = 0;
  return {
    modelId: "fake/flash",
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      const current = round;
      round += 1;
      if (hangRounds.has(current)) return new Promise<StewardLlmResponse>(() => {}); // 永不收口
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

/** 生命周期日志探针（brief 测试要求 4：mock logger 断言全链路日志点）。 */
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


/** 微任务/投影链排空（多轮 setTimeout(1)——abort→finishRun→队列驱动全链 settle）。 */
async function settle(rounds = 12): Promise<void> {
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

// ── ① run 看门狗 ─────────────────────────────────────────

describe("可靠性①：run 看门狗（挂起自动 abort + 队列恢复 + 通知）", () => {
  test("run 挂起无事件推进 180s → 看门狗触发：abort 被调（幂等）+ 挂起通知 + abort 宽限后强制收口恢复队列（后续 ask 不 queued）", async () => {
    const nowRef = { now: 0 };
    // 形态 B（provider 流挂死）：round 0 永不收口——pi EventStream 不竞速
    // abort signal，abort 后 run promise 仍永悬 → 看门狗强制收口轨的针对场景
    //（上一批任务引擎 provider 额度耗尽起步即挂即此形态）。
    const llm = fakeLlm([answer("（挂起轮占位——永不返回）"), answer("第二答"), answer("第三答")], new Set([0]));
    const { svc, notifies, aborts } = makeReliabilityService({ llm, nowRef });

    // 事故现场：第一问挂死在 provider 流上（runActive 永真、零事件推进）
    const hung = svc.ask("第一问");
    await settle(6); // driveAsk 前置（快照/记忆召回）settle 后 runActive 置位

    // 队列：忙碌态第二问入队（E-240 行为等价——queued 双帧回执不变）
    const delivered: StewardAskResultPayload[] = [];
    const second = await svc.ask("第二问", {}, (payload) => delivered.push(payload));
    expect(second.status).toBe("queued");
    if (second.status !== "queued") throw new Error("unreachable");
    expect(second.position).toBe(1);

    // 180s 前巡检：零触发（无通知、零 abort）
    nowRef.now = 179_999;
    svc.reliabilityTick();
    expect(notifies.length).toBe(0);
    expect(aborts.length).toBe(0);

    // 180s 看门狗：挂起通知 + abort（幂等——同集二次 tick 不重复 abort/通知）
    nowRef.now = 180_000;
    svc.reliabilityTick();
    svc.reliabilityTick();
    expect(aborts.length).toBe(1);
    expect(notifies.length).toBe(1);
    expect(notifies[0]!.title).toContain("恢复");
    expect(notifies[0]!.urgency).toBe("high");

    // abort 唤不醒挂死流 → 宽限窗（15s）后强制收口：弃引擎重建 + 队列自动驱动
    await settle(4);
    nowRef.now = 200_000;
    svc.reliabilityTick();
    await settle();

    // 挂死的第一问不再永悬（用户拿到 error 交代）+ 排队第二问经 deliver 收 answer
    const firstOutcome = await hung;
    expect(firstOutcome.status).toBe("error");
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.status).toBe("answer");
    if (delivered[0]!.status !== "answer") throw new Error("unreachable");
    expect(delivered[0]!.text).toBe("第二答");

    // 队列恢复证明：第三问直接执行不 queued（新引擎重建后正常服务）
    const third = await svc.ask("第三问");
    expect(third.status).toBe("answer");
    if (third.status !== "answer") throw new Error("unreachable");
    expect(third.text).toBe("第三答");
  });

  test("事件推进重置看门狗：活跃 run（有事件流）不触发", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([answer("答")]);
    const { svc, notifies } = makeReliabilityService({ llm, nowRef });
    const first = await svc.ask("问题");
    expect(first.status).toBe("answer");
    // run 已收口 → 空闲态巡检零动作
    nowRef.now = 600_000;
    svc.reliabilityTick();
    expect(notifies.length).toBe(0);
  });
});

// ── ② 确认闸 TTL ─────────────────────────────────────────

describe("可靠性②：确认闸 TTL（pending 卡 300s 自动作废 + 提醒 + 单次消费不变量）", () => {
  test("pending 300s 无 confirm/cancel → 自动作废：action.completed {ok:false} + 用户提醒；作废后再 confirm 报已消费", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话" }),
      answer("后续答"),
    ]);
    const { svc, orchestration, notifies, actionCompleted } = makeReliabilityService({ llm, nowRef });
    const first = await svc.ask("递话给 agent-1");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    const actionId = first.actionId;

    // 299s：未到 TTL 零作废
    nowRef.now = 299_999;
    svc.reliabilityTick();
    expect(actionCompleted.length).toBe(0);

    // 300s：自动作废（复用 cancel 内部语义——删除即作废）+ 执行回执 + 用户提醒
    nowRef.now = 300_000;
    svc.reliabilityTick();
    expect(actionCompleted.length).toBe(1);
    expect(actionCompleted[0]!.actionId).toBe(actionId);
    expect(actionCompleted[0]!.ok).toBe(false);
    expect(actionCompleted[0]!.detail).toContain("确认超时");
    expect(notifies.some((n) => n.body.includes("作废"))).toBe(true);
    // 零执行（未确认零执行不变量——两段式防火墙保持）
    expect(orchestration.sends.length).toBe(0);

    // 作废后再 confirm 报已消费（单次消费不变量——E-204）
    const confirmed = await svc.confirm(actionId);
    expect(confirmed.status).toBe("error");
  });

  test("confirm 前置正常路径不受 TTL 影响（150s 内 confirm 照常执行）", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话" }),
      answer("后续答"),
    ]);
    const { svc, orchestration, actionCompleted } = makeReliabilityService({ llm, nowRef });
    const first = await svc.ask("递话给 agent-1");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    nowRef.now = 150_000;
    svc.reliabilityTick();
    const completed: StewardActionCompletedPayload[] = [];
    const confirmed = await svc.confirm(first.actionId, (p) => completed.push(p));
    expect(confirmed.status).toBe("accepted");
    await settle();
    expect(orchestration.sends.length).toBe(1);
    expect(actionCompleted.length).toBe(0); // 无 TTL 作废
    expect(completed.length).toBe(1);
    expect(completed[0]!.ok).toBe(true);
  });
});

// ── ③ confirm_required 可达性提醒 ─────────────────────────

describe("可靠性③：confirm_required 可达性提醒（30s 无人消费 → 提醒帧，不重复）", () => {
  test("30s 无人消费 → 提醒 notify 发出恰一次；300s 后进入 TTL 作废轨（提醒与作废两帧）", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话" }),
      answer("后续答"),
    ]);
    const { svc, notifies, actionCompleted } = makeReliabilityService({ llm, nowRef });
    const first = await svc.ask("递话给 agent-1");
    expect(first.status).toBe("confirm_required");

    nowRef.now = 30_000;
    svc.reliabilityTick();
    svc.reliabilityTick(); // 不重复（一次提醒）
    const reminders = notifies.filter((n) => n.title === "待确认操作");
    expect(reminders.length).toBe(1);
    expect(reminders[0]!.body).toContain("agent-1");

    nowRef.now = 100_000;
    svc.reliabilityTick();
    expect(notifies.filter((n) => n.title === "待确认操作").length).toBe(1); // 仍只有提醒帧

    // 299s：跨 180s 看门狗阈值（挂闸阻塞的 run 被唤醒收口——恢复通知属正常生产行为）
    nowRef.now = 299_999;
    svc.reliabilityTick();
    expect(notifies.filter((n) => n.title === "待确认操作").length).toBe(1); // 提醒不重复
    expect(notifies.filter((n) => n.title === "确认已超时").length).toBe(0); // 未到 TTL 零作废

    nowRef.now = 300_000;
    svc.reliabilityTick();
    expect(actionCompleted.length).toBe(1); // TTL 作废轨
    expect(notifies.filter((n) => n.title === "待确认操作").length).toBe(1); // 提醒仍仅一次
    expect(notifies.filter((n) => n.title === "确认已超时").length).toBe(1); // 作废提醒恰一帧
  });

  test("确认卡被消费（confirm/cancel）后不再提醒", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话" }),
      answer("后续答"),
    ]);
    const { svc, notifies } = makeReliabilityService({ llm, nowRef });
    const first = await svc.ask("递话给 agent-1");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    svc.cancel(first.actionId); // 用户放弃 → daemon 作废簿记
    nowRef.now = 30_000;
    svc.reliabilityTick();
    expect(notifies.filter((n) => n.title === "待确认操作").length).toBe(0);
  });
});

// ── ④ 生命周期日志 ────────────────────────────────────────

describe("可靠性④：steward 生命周期日志（挂起可见——daemon 日志零输出事故根修）", () => {
  test("run 开始/确认闸暂停/run 收口 打 info；看门狗触发/确认 TTL 作废打 warn", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "递话" }),
      answer("第二答"),
    ]);
    const { svc, logger } = makeReliabilityService({ llm, nowRef });
    const first = await svc.ask("递话给 agent-1");
    expect(first.status).toBe("confirm_required");
    // info：run 开始 + 确认闸暂停
    expect(logger.infos.some((m) => m.includes("run 开始"))).toBe(true);
    expect(logger.infos.some((m) => m.includes("确认闸暂停"))).toBe(true);

    // 看门狗触发（warn）→ abort 收口 → run 收口 info
    nowRef.now = 180_000;
    svc.reliabilityTick();
    await settle();
    expect(logger.warns.some((m) => m.includes("看门狗"))).toBe(true);
    expect(logger.infos.some((m) => m.includes("run 收口"))).toBe(true);

    // 确认 TTL 作废（warn）
    nowRef.now = 300_000;
    svc.reliabilityTick();
    expect(logger.warns.some((m) => m.includes("TTL 作废"))).toBe(true);
  });
});

// ── ⑤ 事故场景端到端 ──────────────────────────────────────

describe("可靠性⑤：事故场景端到端（write 档确认无人点 → 自愈全链）", () => {
  test("挂闸无人确认 → 180s 看门狗恢复队列服务 + 300s 确认卡自动作废 + 两段提醒 + 零执行", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([
      toolCall("propose_send", { agentId: "agent-1", message: "顺带跑一下 lint" }),
      answer("排队的第二问已处理"),
      answer("恢复后的新问答"),
    ]);
    const { svc, orchestration, notifies, actionCompleted, logger } = makeReliabilityService({ llm, nowRef });

    // 事故时间线 t0：用户让管家递话 → write 档挂闸（act write 档同闸——E-253）；
    // 确认卡无人消费，用户对后续输入装死（本用例不再发 ask——纯无人介入时间线）
    const first = await svc.ask("帮我切到那个会话，顺带给 agent-1 递话");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    const actionId = first.actionId;

    // t+180s：看门狗 → abort 唤醒挂闸阻塞的 run + 挂起通知 + 队列服务恢复
    nowRef.now = 180_000;
    svc.reliabilityTick();
    await settle();
    expect(notifies.some((n) => n.urgency === "high" && n.title.includes("恢复"))).toBe(true);

    // t+300s：确认卡 TTL 自动作废 + 用户提醒 + action.completed 超时回执 + 零执行
    nowRef.now = 300_000;
    svc.reliabilityTick();
    expect(actionCompleted.length).toBe(1);
    expect(actionCompleted[0]!.actionId).toBe(actionId);
    expect(actionCompleted[0]!.detail).toContain("确认超时");
    expect(notifies.some((n) => n.body.includes("作废"))).toBe(true);
    expect(orchestration.sends.length).toBe(0); // 未确认零执行（防火墙不变）

    // 自愈证明：作废后新 ask 直接服务（不 queued）——≤5 分钟自愈且全程日志可见
    const after = await svc.ask("恢复后的问题");
    expect(after.status).toBe("answer");
    expect(logger.infos.some((m) => m.includes("run 开始"))).toBe(true);
    expect(logger.warns.some((m) => m.includes("看门狗"))).toBe(true);
    expect(logger.warns.some((m) => m.includes("TTL 作废"))).toBe(true);
  });
});
