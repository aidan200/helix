/**
 * SessionTitleService 单测（动态主题批；TDD 红绿证据链）。
 *
 * 覆盖面：
 * 1. 纯函数：锚点判定 / 输出清洗（保持哨兵、引号剥壳、句读修剪、超长截断）
 * 2. evolve 主流程（剧本化 fake LLM/判官/target，与 steward-service.test 同构）：
 *    money gate（开关关 = 零调用）、锚点外短路、显式标题锁定、冷会话跳过、
 *    两段式判官分流（未漂移省生成）、一段式「保持」、成功更新 + 广播、
 *    LLM 失败静默降级、同会话防抖；
 * 3. Session 域守卫：updateTopic 显式标题保护 / 空串拒绝 / 快照往返。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import {
  SessionTitleService,
  isAnchorTurn,
  cleanTopicText,
  buildTopicPrompt,
  buildDriftJudgeInput,
  recentUserTextsOf,
  TOPIC_DRIFT_THRESHOLD,
  TOPIC_KEEP_SENTINEL,
  TOPIC_MAX_CHARS,
  type SessionTopicRuntimeConfig,
  type SessionTitleEvolveTarget,
} from "../../src/application/services/session-title/SessionTitleService";
import { Session } from "../../src/domain/session/Session";
import type { SessionSnapshot } from "../../src/domain/session/SessionSnapshot";

// ── fakes ─────────────────────────────────────────────────

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

function fakeJudge(script: readonly number[]): { noul: (s: string, q: string) => Promise<number> } & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async noul(state: string, question: string): Promise<number> {
      calls.push(`${state}||${question}`);
      const next = script[calls.length - 1];
      if (next === undefined) throw new Error("fake judge 剧本耗尽");
      return next;
    },
  };
}

function makeTarget(overrides: Partial<SessionTitleEvolveTarget> = {}): SessionTitleEvolveTarget & {
  updates: { topic: string; previous: string; anchorTurn: number }[];
} {
  const updates: { topic: string; previous: string; anchorTurn: number }[] = [];
  return {
    title: undefined,
    topic: undefined,
    turnCount: 1,
    recentUserTexts: ["帮我看看这个项目的结构"],
    firstUserText: "帮我看看这个项目的结构",
    updateTopic: (topic, previous, anchorTurn) => updates.push({ topic, previous, anchorTurn }),
    updates,
    ...overrides,
  };
}

function makeService(deps: {
  config?: Partial<SessionTopicRuntimeConfig>;
  llm: StewardLlmPort & { calls: StewardLlmRequest[] };
  judge?: { noul(s: string, q: string): Promise<number> } & { calls: string[] };
  target?: SessionTitleEvolveTarget;
  announced?: string[];
}): { service: SessionTitleService } {
  const announced = deps.announced ?? [];
  return {
    service: new SessionTitleService({
      readConfig: () => ({
        enabled: true,
        model: null,
        classifyEndpointId: null,
        ...(deps.config ?? {}),
      }),
      llm: deps.llm,
      ...(deps.judge !== undefined ? { judge: deps.judge } : {}),
      resolveTarget: () => deps.target ?? undefined,
      announceTopicChanged: (sessionId) => announced.push(sessionId),
    }),
  };
}

/** turn.completed 事件（reason 可配）。 */
function turnDone(sessionId: string, reason: "done" | "aborted" = "done"): DomainEvent {
  return { type: "turn.completed", sessionId, payload: { reason }, occurredAt: "2026-09-24T10:00:00.000Z" };
}

/** onDomainEvent 异步链冲刷（evolve fire-and-forget——await 后断言）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── 纯函数 ─────────────────────────────────────────────────

describe("isAnchorTurn（轮次锚点：1 + 每 10）", () => {
  test("1/10/20/30 是锚点；2/9/11/15/0 非", () => {
    for (const n of [1, 10, 20, 30]) expect(isAnchorTurn(n)).toBe(true);
    for (const n of [0, 2, 9, 11, 15, 100 + 5]) expect(isAnchorTurn(n)).toBe(false);
  });
});

describe("cleanTopicText（输出清洗）", () => {
  test("正常短语直通 + 句读修剪", () => {
    expect(cleanTopicText("会话主题演进设计。")).toBe("会话主题演进设计");
    expect(cleanTopicText("  空白修剪  ")).toBe("空白修剪");
  });
  test("「保持」哨兵 → null（一段式未漂移出口）", () => {
    expect(cleanTopicText("保持")).toBeNull();
    expect(cleanTopicText(TOPIC_KEEP_SENTINEL)).toBeNull();
  });
  test("包裹引号剥壳（最多两层）", () => {
    expect(cleanTopicText("「会话主题演进」")).toBe("会话主题演进");
    expect(cleanTopicText("『「双壳」』")).toBe("双壳");
  });
  test("空串/纯空白/纯句号 → null", () => {
    expect(cleanTopicText("")).toBeNull();
    expect(cleanTopicText("   ")).toBeNull();
    expect(cleanTopicText("。。。")).toBeNull();
  });
  test("超 30 Unicode 码点截断", () => {
    expect([...cleanTopicText("x".repeat(50))!].length).toBe(TOPIC_MAX_CHARS);
  });
});

describe("buildTopicPrompt / buildDriftJudgeInput / recentUserTextsOf", () => {
  test("一段式给「保持」出口；两段式只产新主题", () => {
    const base = { displayTitle: "旧主题", recentUserTexts: ["a"], firstAssistantText: undefined };
    expect(buildTopicPrompt({ ...base, skipJudge: false })).toContain(TOPIC_KEEP_SENTINEL);
    expect(buildTopicPrompt({ ...base, skipJudge: true })).not.toContain("只输出「保持」");
  });
  test("判官输入 state 与 question 分离", () => {
    const input = buildDriftJudgeInput({ displayTitle: "旧主题", recentUserTexts: ["m1", "m2"] });
    expect(input.state).toContain("旧主题");
    expect(input.state).toContain("m1");
    expect(input.question).toContain("实质漂移");
  });
  test("recentUserTextsOf：user 过滤 + 时间升序 + 单条截断", () => {
    const long = "y".repeat(300);
    const out = recentUserTextsOf(
      [
        { role: "user", text: "first" } as never,
        { role: "assistant", text: "skip" } as never,
        { role: "user", text: long } as never,
      ],
      10,
    );
    expect(out).toEqual(["first", "y".repeat(200)]);
  });
});

// ── evolve 主流程 ─────────────────────────────────────────

describe("SessionTitleService.onDomainEvent（锚点演进链）", () => {
  test("money gate：开关关 → 零 LLM/判官调用", async () => {
    const llm = fakeLlm([{ kind: "text", text: "新主题" }]);
    const target = makeTarget();
    const { service } = makeService({ config: { enabled: false }, llm, target });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(llm.calls.length).toBe(0);
    expect(target.updates.length).toBe(0);
  });

  test("非 done 轮（aborted/steerDrained）不计锚点", async () => {
    const llm = fakeLlm([{ kind: "text", text: "新主题" }]);
    const target = makeTarget();
    const { service } = makeService({ llm, target });
    service.onDomainEvent(turnDone("s1", "aborted"));
    await settle();
    expect(llm.calls.length).toBe(0);
  });

  test("非 turn.completed 事件零动作", async () => {
    const llm = fakeLlm([{ kind: "text", text: "新主题" }]);
    const { service } = makeService({ llm });
    service.onDomainEvent({ type: "message.completed", sessionId: "s1", payload: {}, occurredAt: "2026-09-24T10:00:00.000Z" });
    await settle();
    expect(llm.calls.length).toBe(0);
  });

  test("锚点外轮次（2/9/11）短路零调用", async () => {
    const llm = fakeLlm([{ kind: "text", text: "新主题" }]);
    const target = makeTarget({ turnCount: 2 });
    const { service } = makeService({ llm, target });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(llm.calls.length).toBe(0);
  });

  test("显式标题锁定：title 存在 → 零演进（域守卫前置）", async () => {
    const llm = fakeLlm([{ kind: "text", text: "新主题" }]);
    const target = makeTarget({ title: "用户命名的会话", turnCount: 10 });
    const { service } = makeService({ llm, target });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(llm.calls.length).toBe(0);
    expect(target.updates.length).toBe(0);
  });

  test("冷会话（resolveTarget undefined）安全跳过", async () => {
    const llm = fakeLlm([{ kind: "text", text: "新主题" }]);
    const { service } = makeService({ llm, target: undefined });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(llm.calls.length).toBe(0);
  });

  test("一段式成功：新主题 → updateTopic + 广播；previous = topic ?? 推导", async () => {
    const llm = fakeLlm([{ kind: "text", text: "「会话主题演进设计」。" }]);
    const target = makeTarget({ turnCount: 10, topic: "旧主题" });
    const announced: string[] = [];
    const { service } = makeService({ llm, target, announced });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(llm.calls.length).toBe(1);
    expect(llm.calls[0]!.messages[0]).toMatchObject({ role: "user" });
    expect(target.updates).toEqual([{ topic: "会话主题演进设计", previous: "旧主题", anchorTurn: 10 }]);
    expect(announced).toEqual(["s1"]);
  });

  test("一段式「保持」→ 不更新不广播", async () => {
    const llm = fakeLlm([{ kind: "text", text: "保持" }]);
    const target = makeTarget({ turnCount: 10, topic: "旧主题" });
    const announced: string[] = [];
    const { service } = makeService({ llm, target, announced });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(target.updates.length).toBe(0);
    expect(announced).toEqual([]);
  });

  test("两段式：noul ≥ 阈值 → 进生成；prompt 不含「保持」出口", async () => {
    const llm = fakeLlm([{ kind: "text", text: "新主题短语" }]);
    const judge = fakeJudge([TOPIC_DRIFT_THRESHOLD + 0.1]);
    const target = makeTarget({ turnCount: 20, topic: "旧主题" });
    const { service } = makeService({ config: { classifyEndpointId: "jev-1" }, llm, judge, target });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(judge.calls.length).toBe(1);
    expect(llm.calls.length).toBe(1);
    expect((llm.calls[0]!.messages[0] as { text: string }).text).not.toContain(TOPIC_KEEP_SENTINEL);
    expect(target.updates).toEqual([{ topic: "新主题短语", previous: "旧主题", anchorTurn: 20 }]);
  });

  test("两段式：noul < 阈值 → 短路省生成调用", async () => {
    const llm = fakeLlm([{ kind: "text", text: "新主题短语" }]);
    const judge = fakeJudge([TOPIC_DRIFT_THRESHOLD - 0.1]);
    const target = makeTarget({ turnCount: 20, topic: "旧主题" });
    const { service } = makeService({ config: { classifyEndpointId: "jev-1" }, llm, judge, target });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(judge.calls.length).toBe(1);
    expect(llm.calls.length).toBe(0);
    expect(target.updates.length).toBe(0);
  });

  test("未选分类模型（classifyEndpointId null）→ 判官能力在场也不启用，生成模型兼任判断", async () => {
    const llm = fakeLlm([{ kind: "text", text: TOPIC_KEEP_SENTINEL }]);
    const judge = fakeJudge([TOPIC_DRIFT_THRESHOLD + 0.1]);
    const target = makeTarget({ turnCount: 20, topic: "旧主题" });
    const { service } = makeService({ config: { classifyEndpointId: null }, llm, judge, target });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(judge.calls.length).toBe(0); // 判官零调用（生成模型一次调用自带判别）
    expect(llm.calls.length).toBe(1);
    expect((llm.calls[0]!.messages[0] as { text: string }).text).toContain(TOPIC_KEEP_SENTINEL); // 「保持」出口在场
  });

  test("LLM 失败 → 静默降级（保留旧 topic 零更新）", async () => {
    const calls: StewardLlmRequest[] = [];
    const llm: StewardLlmPort & { calls: StewardLlmRequest[] } = {
      modelId: "x/y",
      calls,
      async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
        calls.push(request);
        throw new Error("网络炸了");
      },
    };
    const target = makeTarget({ turnCount: 10, topic: "旧主题" });
    const { service } = makeService({ llm, target });
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(llm.calls.length).toBe(1); // 调了但失败
    expect(target.updates.length).toBe(0);
  });

  test("同会话防抖：in-flight 窗口第二事件不重复演进", async () => {
    let release: (() => void) | undefined;
    const llm = fakeLlm([
      new Promise<StewardLlmResponse>((resolve) => {
        release = () => resolve({ kind: "text", text: "新主题" });
      }) as never as StewardLlmResponse,
    ]);
    const target = makeTarget({ turnCount: 10 });
    const { service } = makeService({ llm, target });
    service.onDomainEvent(turnDone("s1"));
    await settle(); // 第一演进挂起中
    service.onDomainEvent(turnDone("s1"));
    await settle();
    expect(llm.calls.length).toBe(1); // 防抖生效
    release?.();
    await settle();
    expect(target.updates.length).toBe(1);
  });
});

// ── Session 域守卫 ────────────────────────────────────────

describe("Session topic 域（updateTopic 守卫 + 快照往返）", () => {
  test("updateTopic 正常更新 + currentTopic 读", () => {
    const s = Session.create("sess-1", "2026-09-24T00:00:00.000Z");
    expect(s.currentTopic()).toBeUndefined();
    s.updateTopic("会话主题演进设计");
    expect(s.currentTopic()).toBe("会话主题演进设计");
  });

  test("显式标题保护：title 定格 → 拒绝演进（结构性保证）", () => {
    const s = Session.create("sess-1", "2026-09-24T00:00:00.000Z", undefined, "用户命名");
    expect(() => s.updateTopic("自动主题")).toThrow("永不覆盖");
  });

  test("空串/纯空白拒绝", () => {
    const s = Session.create("sess-1", "2026-09-24T00:00:00.000Z");
    expect(() => s.updateTopic("   ")).toThrow("不能为空");
  });

  test("快照往返：topic 持久化与恢复闭环", () => {
    const s = Session.create("sess-1", "2026-09-24T00:00:00.000Z");
    s.updateTopic("演进主题短语");
    const restored = Session.restoreFrom(s.toSnapshot());
    expect(restored.currentTopic()).toBe("演进主题短语");
  });

  test("旧快照无 topic → 恢复为 undefined（前向兼容）", () => {
    const s = Session.create("sess-1", "2026-09-24T00:00:00.000Z");
    const snap = s.toSnapshot();
    const withoutTopic = { ...snap } as SessionSnapshot & { topic?: string };
    delete withoutTopic.topic;
    expect(Session.restoreFrom(withoutTopic).currentTopic()).toBeUndefined();
  });
});
