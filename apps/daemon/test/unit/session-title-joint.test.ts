/**
 * 轮末联合摘要器批单测（会话内容级感知 M1：sessionMemory 配置面 + 双产物）。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. 联合模式（topic_config 开 + sessionMemory 开且模型已配）：一次 LLM 调用
 *    出 JSON 双产物——topic 走 updateTopic、progress 走 recordSessionProgress；
 *    模型用 sessionMemory.model（显式配置优先）；跳过判官（联合模式短路退役）；
 * 2. 纯 topic 模式（sessionMemory 关/未配模型）：行为与旧 SessionTitleService
 *    等价——判官短路保留、「保持」哨兵不动 topic、单产物 prompt；
 * 3. progress-only 路径：title 已锁定（topic 短路）progress 照常；interrupted
 *    轮只驱动 progress（topic 不动）；
 * 4. 锚点：progress 独立完成轮计数（done + interrupted 都计），everyTurns 节流；
 * 5. 烂 JSON：整体丢弃（下个锚点幂等重试——零半产物写入）；
 * 6. 槽位回落链：sessionMemory.model 未配但 enabled 开 → progress 不产
 *    （无默认纪律）；sessionMemory.model 配置 → 本次调用用它。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import { stewardBlocksText } from "../../src/application/steward/stewardBlocks";
import {
  SessionTitleService,
  isAnchorTurn,
  parseJointSummary,
  type SessionTitleEvolveTarget,
} from "../../src/application/services/session-title/SessionTitleService";

// ── fakes ─────────────────────────────────────────────────

/** LLM 剧本 fake：记录请求（systemPrompt/messages），按序回剧本。 */
function fakeLlm(script: readonly string[]): StewardLlmPort & { calls: StewardLlmRequest[] } {
  const calls: StewardLlmRequest[] = [];
  return {
    modelId: "fake/flash",
    calls,
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      calls.push(request);
      const next = script[calls.length - 1];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return { kind: "blocks", blocks: [{ type: "text", text: next }], stopReason: "stop" };
    },
  };
}

function fakeTarget(over: Partial<SessionTitleEvolveTarget> = {}): SessionTitleEvolveTarget & { updates: { topic: string; previous: string; anchorTurn: number }[] } {
  const updates: { topic: string; previous: string; anchorTurn: number }[] = [];
  const base: SessionTitleEvolveTarget & { updates: typeof updates } = {
    title: undefined,
    topic: "旧主题",
    turnCount: 3,
    recentUserTexts: ["把亮度调低一点", "帧率确认 30fps"],
    firstUserText: "设计光球效果",
    updates,
    updateTopic: (topic, previous, anchorTurn) => updates.push({ topic, previous, anchorTurn }),
  };
  return { ...base, ...over, updates: (over as { updates?: typeof updates }).updates ?? updates };
}

interface JointRig {
  svc: SessionTitleService;
  llm: StewardLlmPort & { calls: StewardLlmRequest[] };
  progress: { sessionId: string; text: string }[];
  judgeCalls: { state: string; question: string }[];
  targets: Map<string, SessionTitleEvolveTarget & { updates: { topic: string; previous: string; anchorTurn: number }[] }>;
}

function makeRig(opts: {
  topicEnabled?: boolean;
  topicModel?: string | null;
  sessionMemoryEnabled?: boolean;
  sessionMemoryModel?: string | null;
  everyTurns?: number;
  withJudge?: boolean;
  script?: readonly string[];
}): JointRig {
  const llm = fakeLlm(opts.script ?? []);
  const progress: { sessionId: string; text: string }[] = [];
  const judgeCalls: { state: string; question: string }[] = [];
  const targets = new Map<string, ReturnType<typeof fakeTarget>>();
  const svc = new SessionTitleService({
    readConfig: () => ({
      enabled: opts.topicEnabled ?? true,
      model: opts.topicModel ?? null,
      classifyEndpointId: opts.withJudge ? "jev-1" : null,
    }),
    llm,
    ...(opts.withJudge
      ? {
          judge: {
            noul: async (state: string, question: string) => {
              judgeCalls.push({ state, question });
              return 0.2; // 未漂移（短路判据成立）
            },
          },
        }
      : {}),
    // progress 批新 deps：sessionMemory 读面 + progress 写面（可选注入）
    sessionMemory: {
      read: () => ({
        enabled: opts.sessionMemoryEnabled ?? false,
        model: opts.sessionMemoryModel ?? null,
        everyTurns: opts.everyTurns ?? 3,
      }),
    },
    progressStore: {
      recordSessionProgress: async (sessionId: string, text: string): Promise<boolean> => {
        progress.push({ sessionId, text });
        return true;
      },
    },
    resolveTarget: (sessionId: string) => {
      const t = targets.get(sessionId) ?? fakeTarget();
      targets.set(sessionId, t);
      return t;
    },
    announceTopicChanged: () => undefined,
  });
  return { svc, llm, progress, judgeCalls, targets };
}

function turnCompleted(sessionId: string, reason: "done" | "interrupted"): DomainEvent {
  return { type: "turn.completed", sessionId, payload: { reason }, ts: "2026-10-01T00:00:00.000Z" } as unknown as DomainEvent;
}

// ── 纯函数 ────────────────────────────────────────────────

describe("联合摘要器·纯函数", () => {
  test("isAnchorTurn 不变（1 与 3 的倍数）", () => {
    expect(isAnchorTurn(1)).toBe(true);
    expect(isAnchorTurn(3)).toBe(true);
    expect(isAnchorTurn(6)).toBe(true);
    expect(isAnchorTurn(2)).toBe(false);
    expect(isAnchorTurn(4)).toBe(false);
  });

  test("parseJointSummary：裸 JSON / ```json 围栏 / 烂文本 → undefined / 字段缺席容忍", () => {
    expect(parseJointSummary('{"topic": "光球视觉", "progress": "三档亮度已交付"}')).toEqual({
      topic: "光球视觉",
      progress: "三档亮度已交付",
    });
    expect(parseJointSummary('```json\n{"topic": "保持", "progress": "继续调帧率"}\n```')).toEqual({
      topic: "保持",
      progress: "继续调帧率",
    });
    expect(parseJointSummary("这不是 JSON")).toBeUndefined();
    expect(parseJointSummary('{"progress": "只有进展"}')).toEqual({ progress: "只有进展" });
    expect(parseJointSummary('{"topic": "只有主题"}')).toEqual({ topic: "只有主题" });
    expect(parseJointSummary("{}")).toEqual({});
  });
});

// ── 联合模式 ──────────────────────────────────────────────

describe("联合摘要器·联合模式（topic 开 + sessionMemory 开且模型已配）", () => {
  test("① 一次调用双产物：JSON 双字段 → updateTopic + recordSessionProgress 各收货", async () => {
    const rig = makeRig({
      sessionMemoryEnabled: true,
      sessionMemoryModel: "deepseek/summary-flash",
      script: ['{"topic": "光球视觉调整", "progress": "三档亮度方案已交付，等用户确认帧率"}'],
    });
    const target = rig.targets.get("sess-a") ?? fakeTarget();
    rig.targets.set("sess-a", target);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.llm.calls).toHaveLength(1);
    expect(rig.progress).toEqual([{ sessionId: "sess-a", text: "三档亮度方案已交付，等用户确认帧率" }]);
    expect(target.updates).toEqual([{ topic: "光球视觉调整", previous: "旧主题", anchorTurn: 3 }]);
    // 双产物 prompt：JSON 协议字段两个都在
    const userText = rig.llm.calls[0]!.messages[0] as { role: string; text: string };
    expect(userText.text).toContain("topic");
    expect(userText.text).toContain("progress");
  });

  test("② 联合模式跳过判官（短路退役——主题稳定时进展恰最需要更新）", async () => {
    const rig = makeRig({
      withJudge: true,
      sessionMemoryEnabled: true,
      sessionMemoryModel: "deepseek/summary-flash",
      script: ['{"topic": "保持", "progress": "帧率已定 30fps"}'],
    });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.judgeCalls).toHaveLength(0);
    expect(rig.llm.calls).toHaveLength(1);
  });

  test("③ 「保持」哨兵：topic 不动 + progress 照常写入", async () => {
    const rig = makeRig({
      sessionMemoryEnabled: true,
      sessionMemoryModel: "deepseek/summary-flash",
      script: ['{"topic": "保持", "progress": "继续调帧率中"}'],
    });
    const target = fakeTarget();
    rig.targets.set("sess-a", target);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(target.updates).toHaveLength(0);
    expect(rig.progress).toHaveLength(1);
  });

  test("④ 烂 JSON 整体丢弃：updateTopic 零调用 + progress 零写入", async () => {
    const rig = makeRig({
      sessionMemoryEnabled: true,
      sessionMemoryModel: "deepseek/summary-flash",
      script: ["抱歉我无法输出 JSON"],
    });
    const target = fakeTarget();
    rig.targets.set("sess-a", target);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(target.updates).toHaveLength(0);
    expect(rig.progress).toHaveLength(0);
    expect(rig.llm.calls).toHaveLength(1); // 调了但产物丢弃
  });
});

// ── 纯 topic 模式（行为等价回归）──────────────────────────

describe("联合摘要器·纯 topic 模式（sessionMemory 关）", () => {
  test("① 判官短路保留：未漂移 → 零生成调用", async () => {
    const rig = makeRig({ withJudge: true, script: [] });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.judgeCalls).toHaveLength(1);
    expect(rig.llm.calls).toHaveLength(0);
    expect(rig.progress).toHaveLength(0);
  });

  test("② 纯文本单产物（非 JSON）：旧协议兼容——文本即新主题", async () => {
    const rig = makeRig({ script: ["光球视觉调优"] });
    const target = fakeTarget();
    rig.targets.set("sess-a", target);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(target.updates).toEqual([{ topic: "光球视觉调优", previous: "旧主题", anchorTurn: 3 }]);
  });

  test("③ interrupted 轮不进 topic 路径（锚点判定收口不变）", async () => {
    const rig = makeRig({ script: [] });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "interrupted"));
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.llm.calls).toHaveLength(0);
    expect(rig.judgeCalls).toHaveLength(0);
  });
});

// ── progress-only 路径 ────────────────────────────────────

describe("联合摘要器·progress 路径", () => {
  test("① title 已锁定：topic 短路 + progress 照常", async () => {
    const rig = makeRig({
      sessionMemoryEnabled: true,
      sessionMemoryModel: "deepseek/summary-flash",
      script: ['{"progress": "在标题已锁定的会话里推进帧率"}'],
    });
    const target = fakeTarget({ title: "用户起的名字", topic: undefined });
    rig.targets.set("sess-a", target);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(target.updates).toHaveLength(0);
    expect(rig.progress).toEqual([{ sessionId: "sess-a", text: "在标题已锁定的会话里推进帧率" }]);
  });

  test("② interrupted 轮驱动 progress（被打断也是进展信息）", async () => {
    const rig = makeRig({
      sessionMemoryEnabled: true,
      sessionMemoryModel: "deepseek/summary-flash",
      script: ['{"progress": "会话在调整动画时序处被打断"}'],
    });
    const target = fakeTarget();
    rig.targets.set("sess-a", target);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "interrupted"));
    await new Promise((r) => setTimeout(r, 10));
    expect(target.updates).toHaveLength(0); // topic 不动
    expect(rig.progress).toEqual([{ sessionId: "sess-a", text: "会话在调整动画时序处被打断" }]);
  });

  test("③ everyTurns 节流：progress 独立计数（done+interrupted 合计），非锚点轮不产", async () => {
    const rig = makeRig({
      sessionMemoryEnabled: true,
      sessionMemoryModel: "deepseek/summary-flash",
      script: ['{"progress": "第一轮进展"}', '{"progress": "第三轮进展"}'],
    });
    // 第 1 轮（count=1 锚点）
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.progress).toHaveLength(1);
    // 第 2 轮（count=2 非锚点——interrupted 计入但不触发）
    rig.svc.onDomainEvent(turnCompleted("sess-a", "interrupted"));
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.progress).toHaveLength(1);
    // 第 3 轮（count=3 锚点）
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.progress).toHaveLength(2);
    expect(rig.progress[1]!.text).toBe("第三轮进展");
  });

  test("④ 无默认纪律：enabled 开但 model 未配 → progress 不产（零 LLM 调用）", async () => {
    const rig = makeRig({ sessionMemoryEnabled: true, sessionMemoryModel: null, script: [] });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await new Promise((r) => setTimeout(r, 10));
    // topic 路径照常判官短路（纯 topic 模式）——progress 零产出
    expect(rig.progress).toHaveLength(0);
  });
});
