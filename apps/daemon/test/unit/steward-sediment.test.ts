/**
 * StewardService 自动沉淀判定管线单测（管家记忆 B4a 批；TDD 红绿证据链）。
 *
 * 断言面：
 * 1. 主钩子：answer 轮收口 → 判官调用一次（state 含用户文本+助手回复）；
 *    error/aborted 轮零判定（半成品不算数）；
 * 2. 三档分流：p < SKIP 阈值 → 零提案零事件；p ≥ 阈值 → sediment_proposal
 *    事件 + pending 提案（confirm → remember 执行，source=auto-sediment）；
 * 3. money 闸：零订阅 → 零判官调用（水位仍推进——不订阅轮次静默放弃）；
 * 4. 水位：存量缺省（lastJudgedAt 缺席 → 回落 lastActiveAt）零打扰；
 *    判定后推进；清空重置；
 * 5. 兜底：clearHistory 前补判未判定尾部（重启后未 ask 直接新对话场景；
 *    await 防水位竞态——clear 后水位不被旧值拉回）；
 * 6. 判官不可用/判官抛错 → 静默降级（不可用推水位；抛错不推水位下轮重试）；
 * 7. 候选截断：长用户消息 → 提案 text 截断上限。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { StewardSedimentProposalPayload } from "@helix/protocol";
import { StewardService, STEWARD_SEDIMENT_SKIP_THRESHOLD } from "../../src/application/steward/StewardService";
import { StewardDialogMemory, STEWARD_DIALOG_KEY } from "../../src/application/steward/StewardDialogMemory";
import type { StewardMemoryService } from "../../src/application/steward/StewardMemoryService";

// ── fakes ─────────────────────────────────────────────────

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key) => kv.get(key),
    set: async (key, value) => {
      kv.set(key, value);
    },
  };
}

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort & { calls: StewardLlmRequest[] } {
  const calls: StewardLlmRequest[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      calls.push(request);
      const next = script[calls.length - 1];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
    },
  };
}

/** 判官 fake（概率三档剧本；fail=true 抛错）。 */
function fakeJudge(probability: number, fail = false) {
  const calls: { state: string; question: string }[] = [];
  return {
    calls,
    available: true,
    async noul(state: string, question: string): Promise<number> {
      calls.push({ state, question });
      if (fail) throw new Error("判官 HTTP 500");
      return probability;
    },
  };
}

/** 记忆服务 fake（judge 面 + remember 收集面；available 可切）。 */
function fakeMemory(opts: { judgeAvailable?: boolean; judge?: ReturnType<typeof fakeJudge> } = {}) {
  const judge = opts.judge ?? fakeJudge(0.8);
  const remembers: { text: string; kind: string; source: string }[] = [];
  const memory = {
    remembers,
    judgeSedimentAvailable: () => opts.judgeAvailable ?? true,
    judgeSediment: (state: string, question: string) => judge.noul(state, question),
    remember: async (text: string, kind: "fact" | "preference", source: string) => {
      remembers.push({ text, kind, source });
      return { id: remembers.length, updated: false };
    },
    isAvailable: () => true,
    recallSection: async () => undefined,
    getMemoryState: () => ({
      enabled: true,
      available: true,
      endpoint: { id: "ep-1", name: "Ollama", model: "bge-m3", hasApiKey: false },
      judgeEndpoint: { id: "ep-9", name: "Jev", model: "jev-latest", hasApiKey: true },
      entryCount: remembers.length,
      dim: 3,
    }),
    setMemoryConfig: async () => ({ ok: true as const }),
    listEntries: () => [],
    appendMemoryEntry: async () => ({ ok: true as const }),
    updateMemoryEntry: async () => ({ ok: true as const }),
    forgetEntry: () => true,
  };
  return { memory: memory as unknown as StewardMemoryService, judge, remembers };
}

function makeService(opts: {
  llm: StewardLlmPort;
  config: RuntimeConfigPort & { kv: Map<string, string> };
  memory?: StewardMemoryService;
  feedSubscribers?: boolean;
  now?: () => number;
}) {
  const proposals: StewardSedimentProposalPayload[] = [];
  const dialog = new StewardDialogMemory(opts.config, opts.now !== undefined ? { now: opts.now } : {});
  const svc = new StewardService({
    llm: opts.llm,
    orchestration: { status: () => [], send: () => ({ delivered: true, detail: "ok" }) },
    tasks: { listTasks: () => [] },
    config: opts.config,
    dialog,
    feedGate: { hasStewardSubscribers: () => opts.feedSubscribers ?? true },
    emitFeed: () => {},
    emitSedimentProposal: (payload) => proposals.push(payload),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
    ...(opts.now !== undefined ? { clock: opts.now } : {}),
  });
  return { svc, proposals, dialog };
}

const answer = (text: string): StewardLlmResponse => ({ kind: "text", text });

describe("管家记忆 B4a：自动沉淀判定管线", () => {
  test("① 主钩子：answer 轮收口 → 判官一次（state 含用户+助手文本）；error 轮零判定", async () => {
    const { memory, judge } = fakeMemory({ judge: fakeJudge(0.8) });
    const { svc } = makeService({
      llm: fakeLlm([answer("好的，记下了")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
    });
    const result = await svc.ask("以后别用 bun test 跑 shell 测试", {});
    expect(result.status).toBe("answer");
    await svc.flushSediment();
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toContain("以后别用 bun test");
    expect(judge.calls[0]!.state).toContain("好的，记下了");

    // error 轮（LLM 剧本耗尽抛错 → error 收口）→ 零判定
    const { memory: mem2, judge: judge2 } = fakeMemory({ judge: fakeJudge(0.8) });
    const { svc: svc2 } = makeService({
      llm: fakeLlm([]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: mem2,
    });
    const failed = await svc2.ask("随便一句", {});
    expect(failed.status).toBe("error");
    await svc2.flushSediment();
    expect(judge2.calls).toHaveLength(0);
  });

  test("② 三档分流：p < 阈值 → 零提案零事件；p ≥ 阈值 → 提案事件 + confirm → remember(auto-sediment)", async () => {
    // 低档：静默跳过
    const { memory: lowMem, judge: lowJudge, remembers: lowRemembers } = fakeMemory({ judge: fakeJudge(STEWARD_SEDIMENT_SKIP_THRESHOLD - 0.01) });
    const { svc: lowSvc, proposals: lowProposals } = makeService({
      llm: fakeLlm([answer("嗯")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: lowMem,
    });
    await lowSvc.ask("今天天气不错", {});
    await lowSvc.flushSediment();
    expect(lowJudge.calls).toHaveLength(1);
    expect(lowProposals).toHaveLength(0);
    expect(lowRemembers).toHaveLength(0);

    // 高档：提案 + confirm 入库
    const { memory, remembers } = fakeMemory({ judge: fakeJudge(0.7) });
    const { svc, proposals } = makeService({
      llm: fakeLlm([answer("好的")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
    });
    await svc.ask("以后别用 bun test", {});
    await svc.flushSediment();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.text).toBe("以后别用 bun test");
    expect(proposals[0]!.kind).toBe("preference");
    const confirmResult = await svc.confirm(proposals[0]!.actionId);
    expect(confirmResult.status).toBe("accepted"); // B1 两段式：受理即回
    expect(remembers).toHaveLength(1);
    expect(remembers[0]!.source).toBe("auto-sediment");
    // 单次消费
    const again = await svc.confirm(proposals[0]!.actionId);
    expect(again.status).toBe("error");
    expect(remembers).toHaveLength(1);
  });

  test("③ money 闸：零订阅 → 零判官调用（水位仍推进——下轮不重复判定）", async () => {
    const { memory, judge } = fakeMemory({ judge: fakeJudge(0.9) });
    const { svc } = makeService({
      llm: fakeLlm([answer("嗯"), answer("嗯")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
      feedSubscribers: false,
    });
    await svc.ask("以后别用 bun test", {});
    await svc.flushSediment();
    expect(judge.calls).toHaveLength(0);
    // 订阅恢复后新轮正常判定（旧轮不重判）
    const { svc: svc2, proposals } = makeService({
      llm: fakeLlm([answer("嗯")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
    });
    await svc2.ask("以后回复要简洁", {});
    await svc2.flushSediment();
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toContain("以后回复要简洁");
    expect(proposals).toHaveLength(1);
  });

  test("④ 水位：存量缺省回落 lastActiveAt 零打扰；判定后推进；clear 重置", async () => {
    // 存量 KV：无 lastJudgedAt 字段 → 全部已判定 → 零补偿判定
    const existing = JSON.stringify({
      records: [{ kind: "user", text: "历史偏好：用 vitest", at: 1000 }],
      lastActiveAt: 1001,
    });
    const config = fakeConfig({ "steward.enabled": "1", [STEWARD_DIALOG_KEY]: existing });
    const { memory, judge } = fakeMemory({ judge: fakeJudge(0.9) });
    const now = () => 2000;
    const { svc, dialog } = makeService({
      llm: fakeLlm([answer("嗯")]),
      config,
      memory,
      now,
    });
    await svc.ask("新偏好：别用 bun test", {});
    await svc.flushSediment();
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toContain("新偏好");
    expect(judge.calls[0]!.state).not.toContain("历史偏好");
    // 水位推进到本轮
    expect(dialog.judgedWatermark()).toBe(2000);
    // clear 重置（新对话后水位归零语义——空对话无可判）
    await svc.clearHistory();
    expect(dialog.judgedWatermark()).toBe(0);
  });

  test("⑤ 兜底：clearHistory 前补判未判定尾部（重启后未 ask 直接新对话）；await 防水位竞态", async () => {
    // 预置：lastJudgedAt=500，尾部 at=1000 未判定（重启补偿未跑的场景）
    const existing = JSON.stringify({
      records: [{ kind: "user", text: "尾部偏好：别用 bun test", at: 1000 }],
      lastActiveAt: 1001,
      lastJudgedAt: 500,
    });
    const config = fakeConfig({ "steward.enabled": "1", [STEWARD_DIALOG_KEY]: existing });
    const { memory, judge, remembers } = fakeMemory({ judge: fakeJudge(0.8) });
    const { svc, proposals, dialog } = makeService({
      llm: fakeLlm([]),
      config,
      memory,
      now: () => 2000, // 时钟注入——预置 KV（lastActiveAt=1001）免触发 72h TTL 清空闸
    });
    await svc.clearHistory();
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toContain("尾部偏好");
    expect(proposals).toHaveLength(1);
    // 水位竞态防线：clear 后水位为 0（不被旧判定值拉回——新对话记录不重复判定）
    expect(dialog.judgedWatermark()).toBe(0);
    // 尾部提案 pending 随 clear 作废（单次消费自然过期）
    const late = await svc.confirm(proposals[0]!.actionId);
    expect(late.status).toBe("error");
    expect(remembers).toHaveLength(0);
  });

  test("⑥ 降级：判官不可用推水位静默跳过；判官抛错不推水位（下轮重试）", async () => {
    // 不可用：零调用零事件 + 水位推进
    const { memory: offMem } = fakeMemory({ judgeAvailable: false });
    const now = () => 3000;
    const { svc, dialog } = makeService({
      llm: fakeLlm([answer("嗯")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: offMem,
      now,
    });
    await svc.ask("以后别用 bun test", {});
    await svc.flushSediment();
    expect(dialog.judgedWatermark()).toBe(3000);

    // 抛错：水位不推进（下轮重试面）
    const { memory: failMem } = fakeMemory({ judge: fakeJudge(0.8, true) });
    const { svc: svc2, dialog: dialog2 } = makeService({
      llm: fakeLlm([answer("嗯")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: failMem,
      now,
    });
    await svc2.ask("以后回复要简洁", {});
    await svc2.flushSediment();
    expect(dialog2.judgedWatermark()).toBe(0);
  });

  test("⑦ 候选截断：长用户消息 → 提案 text 截断上限", async () => {
    const { memory } = fakeMemory({ judge: fakeJudge(0.9) });
    const { svc, proposals } = makeService({
      llm: fakeLlm([answer("嗯")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
    });
    const longText = "记住：" + "很长的偏好描述".repeat(50);
    await svc.ask(longText, {});
    await svc.flushSediment();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.text.length).toBeLessThanOrEqual(201); // 200 + 省略号
    expect(proposals[0]!.text.endsWith("…")).toBe(true);
  });
});
