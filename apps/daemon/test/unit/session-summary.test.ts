/**
 * SessionSummaryService（会话总结器）单测（会话总结器独立化批①；TDD 红绿证据链）。
 *
 * 断言面：
 * 1. 三产物 JSON 解析容错（parseSessionSummary）：```json 围栏剥壳 + 首尾
 *    大括号定位 + 字段缺席容忍（topic/progress/memoryPoints 任缺）+ memoryPoints
 *    数组/单串双形态 + 烂输出 → undefined（整体丢弃）；
 * 2. summary.everyTurns 可配且锚点节奏跟随生效（isSummaryAnchorTurn：count=1
 *    与 everyTurns 倍数；配置改值即改节拍——done+interrupted 合计计数）；
 * 3. summary.enabled=false 三产物全停（锚点轮零 LLM 调用零写入）；
 * 4. 记忆点入库（memoryPointsStore 委托 remember 查重入库）与防双写（本轮
 *    显式 remember 过 → 记忆点跳过，progress/topic 照常）；
 * 5. topic 演进语义全保留：「保持」哨兵 / cleanTopicText / 显式标题锁定 /
 *    updateTopic 单一写路径 + announceTopicChanged / interrupted 轮不进 topic；
 * 6. progress 语义：≤120 字与覆盖更新在 recordSessionProgress（StewardMemoryService）
 *    ——此处只验投递；烂输出整体丢弃零半产物；
 * 7. 只出标题降级形态（summary.model 未配）：旧纯文本协议零回归（文本即主题）。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { SessionEntryData } from "../../src/domain/session/SessionSnapshot";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { SummaryConfigState } from "../../src/application/summary/summaryConfig";
import {
  SessionSummaryService,
  TOPIC_SYSTEM_PROMPT,
  cleanTopicText,
  isSummaryAnchorTurn,
  parseSessionSummary,
  recentTurnPairsOf,
  recentUserTextsOf,
  type SessionSummaryServiceDeps,
  type SessionSummaryTarget,
} from "../../src/application/services/session-summary/SessionSummaryService";

// ── fakes ─────────────────────────────────────────────────

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

function fakeTarget(over: Partial<SessionSummaryTarget> = {}): SessionSummaryTarget & { updates: { topic: string; previous: string; anchorTurn: number }[] } {
  const updates: { topic: string; previous: string; anchorTurn: number }[] = [];
  const base: SessionSummaryTarget & { updates: typeof updates } = {
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

function summaryState(over: Partial<SummaryConfigState> = {}): SummaryConfigState {
  return {
    enabled: true,
    everyTurns: 3,
    model: "deepseek/summary-flash",
    task: { enabled: false, model: null },
    ...over,
  };
}

interface Rig {
  svc: SessionSummaryService;
  llm: StewardLlmPort & { calls: StewardLlmRequest[] };
  progress: { sessionId: string; text: string }[];
  memoryPoints: string[];
  updates: { topic: string; previous: string; anchorTurn: number }[];
  announces: string[];
  explicit: { since: number }[];
  setExplicitRemembered: (v: boolean) => void;
}

function makeRig(opts: {
  config?: Partial<SummaryConfigState>;
  script?: readonly string[];
  target?: ReturnType<typeof fakeTarget>;
  memoryPointsStore?: boolean;
  progressStore?: boolean;
}): Rig {
  const llm = fakeLlm(opts.script ?? []);
  const progress: { sessionId: string; text: string }[] = [];
  const memoryPoints: string[] = [];
  const announces: string[] = [];
  const explicit: { since: number }[] = [];
  let explicitRemembered = false;
  const target = opts.target ?? fakeTarget();
  const deps: SessionSummaryServiceDeps = {
    readConfig: () => summaryState(opts.config ?? {}),
    llm,
    resolveTarget: () => target,
    announceTopicChanged: (sessionId) => announces.push(sessionId),
    ...(opts.progressStore === false
      ? {}
      : {
          progressStore: {
            recordSessionProgress: async (sessionId: string, text: string): Promise<boolean> => {
              progress.push({ sessionId, text });
              return true;
            },
          },
        }),
    ...(opts.memoryPointsStore === false
      ? {}
      : {
          memoryPointsStore: {
            rememberMemoryPoint: async (text: string) => {
              memoryPoints.push(text);
              return { id: memoryPoints.length, updated: false };
            },
            explicitRememberedSince: (since: number) => {
              explicit.push({ since });
              return explicitRemembered;
            },
          },
        }),
  };
  return {
    svc: new SessionSummaryService(deps),
    llm,
    progress,
    memoryPoints,
    updates: target.updates,
    announces,
    explicit,
    setExplicitRemembered: (v) => {
      explicitRemembered = v;
    },
  };
}

function turnCompleted(sessionId: string, reason: "done" | "interrupted"): DomainEvent {
  return { type: "turn.completed", sessionId, payload: { reason }, ts: "2026-10-01T00:00:00.000Z" } as unknown as DomainEvent;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

// ── 纯函数 ────────────────────────────────────────────────

describe("总结器·纯函数", () => {
  test("isSummaryAnchorTurn：count=1 与 everyTurns 倍数为锚点（可配节奏）", () => {
    expect(isSummaryAnchorTurn(1, 3)).toBe(true);
    expect(isSummaryAnchorTurn(3, 3)).toBe(true);
    expect(isSummaryAnchorTurn(6, 3)).toBe(true);
    expect(isSummaryAnchorTurn(2, 3)).toBe(false);
    expect(isSummaryAnchorTurn(4, 3)).toBe(false);
    // everyTurns 可配：5 档锚点 = 1/5/10；1 档 = 每轮
    for (const n of [1, 5, 10]) expect(isSummaryAnchorTurn(n, 5)).toBe(true);
    expect(isSummaryAnchorTurn(3, 5)).toBe(false);
    for (const n of [1, 2, 3, 4]) expect(isSummaryAnchorTurn(n, 1)).toBe(true);
  });

  test("parseSessionSummary：裸 JSON / ```json 围栏 / 字段缺席容忍 / memoryPoints 双形态", () => {
    expect(parseSessionSummary('{"topic": "光球视觉", "progress": "三档亮度已交付", "memoryPoints": ["用户偏好简洁回复"]}')).toEqual({
      topic: "光球视觉",
      progress: "三档亮度已交付",
      memoryPoints: ["用户偏好简洁回复"],
    });
    expect(parseSessionSummary('```json\n{"topic": "保持", "progress": "继续调帧率", "memoryPoints": []}\n```')).toEqual({
      topic: "保持",
      progress: "继续调帧率",
    });
    expect(parseSessionSummary('{"progress": "只有进展"}')).toEqual({ progress: "只有进展" });
    expect(parseSessionSummary('{"topic": "只有主题"}')).toEqual({ topic: "只有主题" });
    // memoryPoints：单串容错为单元素数组；空串/非串元素过滤
    expect(parseSessionSummary('{"memoryPoints": "用户习惯用 vitest"}')).toEqual({ memoryPoints: ["用户习惯用 vitest"] });
    expect(parseSessionSummary('{"memoryPoints": ["有效", "", 42, "  "]}')).toEqual({ memoryPoints: ["有效"] });
    expect(parseSessionSummary("{}")).toEqual({});
  });

  test("parseSessionSummary：烂输出整体丢弃 → undefined", () => {
    expect(parseSessionSummary("这不是 JSON")).toBeUndefined();
    expect(parseSessionSummary('{"broken": ')).toBeUndefined();
    expect(parseSessionSummary("[1,2,3]")).toBeUndefined();
    expect(parseSessionSummary("")).toBeUndefined();
  });

  test("cleanTopicText：包裹引号剥壳 + 句读 + 「保持」/空 → null + 超长截断", () => {
    expect(cleanTopicText("「光球视觉调优」。")).toBe("光球视觉调优");
    expect(cleanTopicText("保持")).toBeNull();
    expect(cleanTopicText("   ")).toBeNull();
    expect([...cleanTopicText("一".repeat(50))!]).toHaveLength(30);
  });

  test("recentTurnPairsOf / recentUserTextsOf：投影 + 截断 + 末 N 条", () => {
    const entries = [
      { role: "user", text: "任务A" },
      { role: "assistant", text: "结论A1" },
      { role: "assistant", text: "结论A2" },
      { role: "user", text: "任务B" },
    ] as unknown as SessionEntryData[];
    expect(recentTurnPairsOf(entries, 6)).toEqual([
      { user: "任务A", assistant: "结论A2" },
      { user: "任务B" },
    ]);
    expect(recentUserTextsOf(entries, 10)).toEqual(["任务A", "任务B"]);
  });
});

// ── 三产物（summary.model 已配）──────────────────────────

describe("总结器·三产物 JSON", () => {
  test("① 同一锚点一次调用三产物：topic 演进 + progress + 记忆点各收货", async () => {
    const rig = makeRig({
      script: ['{"topic": "光球视觉调整", "progress": "三档亮度方案已交付", "memoryPoints": ["用户偏好先给方案再问细节", "用户习惯用 vitest 跑测试"]}'],
    });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await settle();
    expect(rig.llm.calls).toHaveLength(1);
    expect(rig.updates).toEqual([{ topic: "光球视觉调整", previous: "旧主题", anchorTurn: 3 }]);
    expect(rig.announces).toEqual(["sess-a"]);
    expect(rig.progress).toEqual([{ sessionId: "sess-a", text: "三档亮度方案已交付" }]);
    expect(rig.memoryPoints).toEqual(["用户偏好先给方案再问细节", "用户习惯用 vitest 跑测试"]);
    const userText = rig.llm.calls[0]!.messages[0] as { role: string; text: string };
    expect(userText.text).toContain("topic");
    expect(userText.text).toContain("progress");
    expect(userText.text).toContain("memoryPoints");
  });

  test("② 「保持」哨兵与显式标题锁定：topic 不动，其余产物照常", async () => {
    const keep = makeRig({ script: ['{"topic": "保持", "progress": "继续调帧率", "memoryPoints": ["用户讨厌长回复"]}'] });
    keep.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await settle();
    expect(keep.updates).toHaveLength(0);
    expect(keep.progress).toHaveLength(1);
    expect(keep.memoryPoints).toEqual(["用户讨厌长回复"]);

    const locked = makeRig({
      target: fakeTarget({ title: "用户起的名字", topic: undefined }),
      script: ['{"progress": "标题锁定会话的进展", "memoryPoints": ["用户要求中文回复"]}'],
    });
    locked.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await settle();
    expect(locked.updates).toHaveLength(0);
    const userText = locked.llm.calls[0]!.messages[0] as { text: string };
    expect(userText.text).not.toContain('"topic"'); // 锁定 = 不请求 topic 字段
    expect(locked.progress).toHaveLength(1);
  });

  test("③ 烂输出整体丢弃：零半产物（updateTopic/progress/记忆点全零）", async () => {
    const rig = makeRig({ script: ["抱歉我无法输出 JSON"] });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await settle();
    expect(rig.llm.calls).toHaveLength(1); // 调了但产物丢弃
    expect(rig.updates).toHaveLength(0);
    expect(rig.progress).toHaveLength(0);
    expect(rig.memoryPoints).toHaveLength(0);
  });

  test("④ interrupted 轮进展照进（progress+记忆点产、topic 不动）", async () => {
    const rig = makeRig({ script: ['{"progress": "会话在调整动画时序处被打断", "memoryPoints": []}'] });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "interrupted"));
    await settle();
    expect(rig.updates).toHaveLength(0);
    expect(rig.progress).toEqual([{ sessionId: "sess-a", text: "会话在调整动画时序处被打断" }]);
  });
});

// ── 锚点节奏与开关 ────────────────────────────────────────

describe("总结器·锚点节奏（summary.everyTurns）与总开关", () => {
  test("① everyTurns 可配且锚点节奏跟随生效（done+interrupted 合计计数）", async () => {
    const rig = makeRig({
      config: { everyTurns: 2 },
      script: ['{"progress": "第1轮"}', '{"progress": "第2轮"}', '{"progress": "第4轮"}'],
    });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done")); // count=1 锚点
    await settle();
    expect(rig.progress).toHaveLength(1);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "interrupted")); // count=2 锚点（everyTurns=2）
    await settle();
    expect(rig.progress).toHaveLength(2);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done")); // count=3 非锚点
    await settle();
    expect(rig.progress).toHaveLength(2);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done")); // count=4 锚点
    await settle();
    expect(rig.progress).toHaveLength(3);
  });

  test("② summary.enabled=false 三产物全停（锚点轮零 LLM 零写入）", async () => {
    const rig = makeRig({ config: { enabled: false }, script: [] });
    for (const reason of ["done", "interrupted"] as const) {
      rig.svc.onDomainEvent(turnCompleted("sess-a", reason));
    }
    await settle();
    expect(rig.llm.calls).toHaveLength(0);
    expect(rig.updates).toHaveLength(0);
    expect(rig.progress).toHaveLength(0);
    expect(rig.memoryPoints).toHaveLength(0);
  });

  test("③ 无默认纪律：summary.model 未配 → 进展/记忆点不产，标题走旧文本协议", async () => {
    const rig = makeRig({ config: { model: null }, script: ["光球视觉调优"] });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await settle();
    expect(rig.llm.calls).toHaveLength(1);
    expect(rig.llm.calls[0]!.systemPrompt).toBe(TOPIC_SYSTEM_PROMPT);
    expect(rig.updates).toEqual([{ topic: "光球视觉调优", previous: "旧主题", anchorTurn: 3 }]);
    expect(rig.progress).toHaveLength(0);
    expect(rig.memoryPoints).toHaveLength(0);
    // 纯文本协议「保持」哨兵零更新
    const keep = makeRig({ config: { model: null }, script: ["保持"] });
    keep.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await settle();
    expect(keep.updates).toHaveLength(0);
  });
});

// ── 记忆点入库与防双写 ────────────────────────────────────

describe("总结器·记忆点入库（查重在 remember 两段闸）与防双写", () => {
  test("① 记忆点逐条投递 rememberMemoryPoint（超量/超长护栏）", async () => {
    const long = "长".repeat(100);
    const rig = makeRig({
      script: [`{"memoryPoints": ["第一条", "${long}", "第二条", "第三条", "第四条"]}`],
    });
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await settle();
    // 上限 3 条/锚点；单条超长截断
    expect(rig.memoryPoints).toHaveLength(3);
    expect(rig.memoryPoints[0]).toBe("第一条");
    expect(rig.memoryPoints[1]).toBe(`${"长".repeat(60)}`);
    expect(rig.memoryPoints[2]).toBe("第二条");
  });

  test("② 防双写：本轮显式 remember 过 → 记忆点跳过，progress/topic 照常", async () => {
    const rig = makeRig({
      script: ['{"topic": "光球视觉", "progress": "帧率定稿", "memoryPoints": ["用户偏好简洁回复"]}'],
    });
    rig.setExplicitRemembered(true);
    rig.svc.onDomainEvent(turnCompleted("sess-a", "done"));
    await settle();
    expect(rig.memoryPoints).toHaveLength(0);
    expect(rig.progress).toHaveLength(1);
    expect(rig.updates).toHaveLength(1);
  });
});
