/**
 * 管家手动停止批单测（2026-10-09 15:30 卡死事故后续——TDD 红→绿）。
 *
 * 事故背景：provider 流挂死（self-signed 代理环境）→ runActive 永真 → 队列
 * 饿死 4 分钟，用户只能重启 daemon。当时距看门狗自愈（180s+15s=195s）还差
 * 12s——被动自愈对语音交互场景太慢。本批给用户主动权：
 *
 * 断言面（brief 测试要求逐条）：
 * 1. interrupt 快进强制收口：手动 abort 后 8s 仍 runActive（挂死流 abort
 *    打不醒——E-240 实测事实）→ 直接弃引擎强制收口 + 队列驱动恢复（对比
 *    被动看门狗 195s）；8s 前零强制；正常收口后手动锚复位（不误伤下一 run）。
 * 2. 强制停止词（TR-240 口令纪律同款：词表单源全等匹配 + 归一剥尾标点，
 *    仅 runActive 在场时路由）：命中 → 全停（abort 当前 + 清空排队 + stopped
 *    回执携丢弃条数）；空闲态命中不吞（原样走 LLM）；确认口令（「取消」）
 *    优先于停止词路由（卡语义不被吞）；挂闸阻塞态命中 → 全停且 pending 卡
 *    保留（卡生命周期 TTL 域独立）。
 *
 * 约束（kg 切片）：E-240 askQueue/runActive/finishRun 行为等价（本批只加
 * 快进轨与入口路由，不动队列语义）；TR-240 确认口令路由序在前（停止词后
 * 于确认口令检查）；E-278 判定序不动（停止词在 ask 入口 LLM/执行层，非
 * 语音判定链）。
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
import type { StewardAskResultPayload } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";

// ── fakes（对齐 steward-reliability.test.ts 装配——探针：abort 计数/日志） ──

function makeStopService(opts: { llm: StewardLlmPort; nowRef: { now: number }; runningAgents?: readonly string[] }) {
  const aborts: number[] = [];
  const logger = fakeLogger();
  const running = opts.runningAgents ?? ["agent-1"];
  const orchestration = fakeOrchestration(
    running.map((agentId) => ({
      agentId,
      state: "running",
      displayState: "active",
      profileKind: "subagent-worker",
      task: "修复登录超时",
    })),
  );
  const innerCreate = createEngineFromPort(opts.llm);
  const svc = new StewardService({
    llm: opts.llm,
    orchestration,
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    dialog: new StewardDialogMemory(fakeDialogStore()),
    clock: () => opts.nowRef.now,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {}, // 零订阅测试形态（类型闭合——本批不断言 feed 帧）
    logger,
    createEngine: (engineOpts) => {
      const inner = innerCreate(engineOpts);
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
  return { svc, orchestration, logger, aborts };
}

/** 挂起剧本 fake LLM（reliability 批同款）：hangRounds 命中轮次永不收口
 *  ——provider 流挂死形态（abort 打不醒，正是快进强制收口轨的针对场景）。 */
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

/** 微任务/投影链排空（reliability 批同款）。 */
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

// ── ① interrupt 快进强制收口 ─────────────────────────────

describe("手动停止①：interrupt 快进强制收口（挂死流 8s 恢复，对比看门狗 195s）", () => {
  test("手动 abort 后 8s 仍 runActive（挂死流）→ 弃引擎强制收口 + 排队照常驱动；8s 前零强制", async () => {
    const nowRef = { now: 0 };
    // 2026-10-09 事故形态：round 0 挂死（provider 流挂死，abort 打不醒）
    const llm = fakeLlm([answer("（挂死轮占位——永不返回）"), answer("第二答"), answer("第三答")], new Set([0]));
    const { svc, logger } = makeStopService({ llm, nowRef });

    const hung = svc.ask("第一问");
    await settle(6); // 装配段 settle → runActive 置位

    // 排队一条（E-240 行为等价：interrupt 只停当前，队列保留）
    const delivered: StewardAskResultPayload[] = [];
    const second = await svc.ask("第二问", {}, (payload) => delivered.push(payload));
    expect(second.status).toBe("queued");

    // 用户手动停（barge-in interrupt / 面板按钮同源）
    expect(svc.abortInFlight("手动停止")).toBe(true);

    // 8s 宽限内：零强制收口（挂死的第一问仍未收口、无强制日志）
    nowRef.now = 7_999;
    svc.reliabilityTick();
    await settle(2);
    expect(logger.warns.some((m) => m.includes("强制收口"))).toBe(false);

    // 8s 到：弃引擎强制收口——挂死轮拿到 error 交代 + 排队第二问自动驱动
    nowRef.now = 8_000;
    svc.reliabilityTick();
    await settle();
    expect(logger.warns.some((m) => m.includes("强制收口"))).toBe(true);
    const firstOutcome = await hung;
    expect(firstOutcome.status).toBe("error");
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.status).toBe("answer");
    if (delivered[0]!.status !== "answer") throw new Error("unreachable");
    expect(delivered[0]!.text).toBe("第二答");

    // 队列恢复：新 ask 直接服务（新引擎懒重建）
    const third = await svc.ask("第三问");
    expect(third.status).toBe("answer");
    if (third.status !== "answer") throw new Error("unreachable");
    expect(third.text).toBe("第三答");
  });

  test("run 正常收口后手动锚复位：空闲态 abortInFlight 返回 false 零副作用（幂等不变量保持）", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([answer("答一"), answer("答二")]);
    const { svc, logger } = makeStopService({ llm, nowRef });

    const first = await svc.ask("第一问");
    expect(first.status).toBe("answer");

    // 空闲态手动停：false（幂等 no-op）+ 后续 tick 零强制
    expect(svc.abortInFlight("手动停止")).toBe(false);
    nowRef.now = 60_000;
    svc.reliabilityTick();
    await settle(2);
    expect(logger.warns.some((m) => m.includes("强制收口"))).toBe(false);

    // 下一 run 不受影响（手动锚已随收口复位）
    const second = await svc.ask("第二问");
    expect(second.status).toBe("answer");
  });
});

// ── ② 强制停止词（全停：abort 当前 + 清空排队） ──────────────

describe("手动停止②：强制停止词（在途全停 + 空闲不吞 + 确认口令优先 + 挂闸卡保留）", () => {
  test("挂死 run + 排队 2 条 → 停止词（尾标点归一）→ stopped 回执携丢弃数 + abort 被调 + 快进收口后队列恢复", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([answer("（挂死轮占位——永不返回）"), answer("恢复后答")], new Set([0]));
    const { svc, aborts } = makeStopService({ llm, nowRef });

    const hung = svc.ask("第一问");
    await settle(6);

    const q1 = await svc.ask("排队一");
    expect(q1.status).toBe("queued");
    const q2 = await svc.ask("排队二");
    expect(q2.status).toBe("queued");

    // 语音转写常带句读：「别说了。」→ 归一命中停止词
    const stopped = await svc.ask("别说了。");
    expect(stopped.status).toBe("stopped");
    if (stopped.status !== "stopped") throw new Error("unreachable");
    expect(stopped.dropped).toBe(2);
    expect(aborts.length).toBeGreaterThanOrEqual(1);

    // 快进轨收口挂死 run（stopped 回执即刻返回，收口由 8s 轨异步完成）
    nowRef.now = 8_000;
    svc.reliabilityTick();
    await settle();
    const firstOutcome = await hung;
    expect(firstOutcome.status).toBe("error");

    // 队列已清空：新 ask 直接服务（无残留排队抢先消费）
    const after = await svc.ask("恢复后的问题");
    expect(after.status).toBe("answer");
    if (after.status !== "answer") throw new Error("unreachable");
    expect(after.text).toBe("恢复后答");
  });

  test("空闲态停止词不吞：无在途 run 时原样走 LLM（TR-240 同款纪律——词表仅在场路由）", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([answer("闲聊答")]);
    const { svc } = makeStopService({ llm, nowRef });

    const r = await svc.ask("停");
    expect(r.status).toBe("answer");
    if (r.status !== "answer") throw new Error("unreachable");
    expect(r.text).toBe("闲聊答");
  });

  test("确认口令优先于停止词：pending 卡在场「取消」走卡作废路由（不被停止词吞）", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([toolCall("propose_send", { agentId: "agent-1", message: "递话" }), answer("后续答")]);
    const { svc, orchestration } = makeStopService({ llm, nowRef });

    const first = await svc.ask("递话给 agent-1");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");

    // 「取消」是确认口令（TR-240 词表）——不是停止词，走卡作废
    const cancelled = await svc.ask("取消");
    expect(cancelled.status).not.toBe("stopped");

    // 卡已作废：confirm 报已消费 + 零执行
    const confirmed = await svc.confirm(first.actionId);
    expect(confirmed.status).toBe("error");
    expect(orchestration.sends.length).toBe(0);
  });

  test("挂闸阻塞态停止词全停：abort + 清队列 + pending 卡保留（卡生命周期 TTL 域独立，confirm 仍可消费）", async () => {
    const nowRef = { now: 0 };
    const llm = fakeLlm([toolCall("propose_send", { agentId: "agent-1", message: "递话" }), answer("后续答")]);
    const { svc, orchestration, aborts } = makeStopService({ llm, nowRef });

    const first = await svc.ask("递话给 agent-1");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    const actionId = first.actionId;

    // 挂闸态（runActive=true + pausedGateToken 在场）：停止词全停
    const stopped = await svc.ask("别说了");
    expect(stopped.status).toBe("stopped");
    if (stopped.status !== "stopped") throw new Error("unreachable");
    expect(stopped.dropped).toBe(0); // 挂闸态没有排队（挂闸 ask 本会 abort-再驱动）
    expect(aborts.length).toBeGreaterThanOrEqual(1);

    // 快进轨收口后：卡仍在（不被停止词撤卡）——confirm 照常消费执行
    nowRef.now = 8_000;
    svc.reliabilityTick();
    await settle();
    const completed: { ok: boolean; detail: string }[] = [];
    const confirmed = await svc.confirm(actionId, (p) => completed.push({ ok: p.ok, detail: p.detail }));
    expect(confirmed.status).toBe("accepted");
    await settle();
    expect(orchestration.sends.length).toBe(1);
  });
});
