/**
 * StewardService A2 批单测（管家能力面：L1 情景查询 + 操作工具扩展）。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. 动态 prompt：快照段存在性 / 预算上限 / 查询失败静默降级（三用例）；
 * 2. query_recent_work：四时间档 + 项目过滤 + 空结果（红：工具不存在→绿）；
 * 3. create_session / spawn_review_task：确认闸单次消费 / 无索引引导式失败 /
 *    paramsSchema 透传（红：无实现→绿）；
 * 4. 快照与 list_instances 口径一致（交叉断言——活跃 agent 数同源）。
 *
 * 设计锚点（见 a2-brief）：会话创建走 SessionDirectoryPort.startDraftSession
 * 同款窄接口；任务发起走 TaskEnginePort.createTask（paramsSchema 校验在引擎，
 * TaskError message 原样透传）；kg 索引判定走 KgProjectService 同款窄接口
 * （resolve + hasIndex）。
 */
import { describe, expect, test } from "bun:test";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { AgentOrchestrationPort } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type { StewardFeedPayload } from "@helix/protocol";
import {
  StewardService,
  buildContextSnapshot,
  assembleStewardSystemPrompt,
  timeRangeWindow,
  CONTEXT_SNAPSHOT_MAX_CHARS,
  STEWARD_SYSTEM_PROMPT,
  type StewardSessionMetaRow,
  type TimeRange,
} from "../../src/application/steward/StewardService";

// ── fakes ─────────────────────────────────────────────────

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

function fakeOrchestration(
  statuses: readonly { agentId: string; state: "running" | "done"; task?: string; summary?: string }[],
): Pick<AgentOrchestrationPort, "status" | "send"> {
  const full = statuses.map((s) => ({
    ...s,
    displayState: (s.state === "running" ? "active" : "done") as "active" | "done",
    profileKind: "subagent-worker" as const,
  }));
  return {
    status: (agentId?: string) => (agentId === undefined ? [...full] : full.filter((s) => s.agentId === agentId)),
    send: (_agentId: string, _message: string) => ({ delivered: true, detail: "已投递" }),
  };
}

/** A2 会话源 fake（listSessionMetadata + startDraftSession/createTitledSession 记录调用；
 *  驾驶舱批新增两成员提供恒真/恒成功缺省——本批用例不触达）。 */
function fakeSessions(rows: readonly StewardSessionMetaRow[]) {
  const created: { text: string; mode?: string }[] = [];
  const titled: string[] = [];
  let seq = 0;
  return {
    created,
    titled,
    listSessionMetadata: async () => [...rows],
    startDraftSession: async (text: string, mode?: string) => {
      created.push({ text, mode });
      seq += 1;
      return { sessionId: `sess-new-${seq}` };
    },
    createTitledSession: async (title: string) => {
      titled.push(title);
      seq += 1;
      return { sessionId: `sess-new-${seq}` };
    },
    sessionExists: async (_sessionId: string) => true,
    deliverToSession: async (_sessionId: string, _text: string) => ({ delivered: true, detail: "已投递" }),
  };
}

function fakeProjects(opts: { roots?: Record<string, string>; indexed?: string[] } = {}) {
  const roots = new Map(Object.entries(opts.roots ?? { helix: "/ws/helix", "other-proj": "/ws/other-proj" }));
  const indexed = new Set(opts.indexed ?? ["helix"]);
  return {
    resolve: (project: string) => roots.get(project),
    hasIndex: (projectRoot: string) => indexed.has(projectRoot) || [...roots.values()].some((r) => r === projectRoot && indexed.has(r.replace(/^\/ws\//, ""))),
  };
}

function fakeTaskEngine() {
  const created: { type: string; projects: readonly string[]; params: Record<string, unknown>; createdBy: string }[] = [];
  return {
    created,
    createTask: async (input: { type: string; projects: readonly string[]; params: Record<string, unknown>; createdBy: string }) => {
      if (input.type === "code-review" && input.params.scope === "bad") {
        return Promise.reject(new Error("[KG_E_PARAM] params.scope 不在枚举内（code-review）"));
      }
      created.push(input);
      return { jobId: "task-abc123" };
    },
  };
}

/** A2 装配（新注入面全部可选——缺省 = A1 形态，兼容既有面）。 */
function makeA2Service(opts: {
  llm: StewardLlmPort & { calls: { request: StewardLlmRequest; round: number }[] };
  sessions?: ReturnType<typeof fakeSessions>;
  projects?: ReturnType<typeof fakeProjects>;
  taskEngine?: ReturnType<typeof fakeTaskEngine>;
  hasGitRepo?: (projectRoot: string) => boolean;
  now?: () => number;
}) {
  const orchestration = fakeOrchestration([
    { agentId: "agent-1", state: "running", task: "修复登录超时" },
    { agentId: "agent-2", state: "done", summary: "已完成" },
    { agentId: "agent-3", state: "running", task: "写文档" },
  ]);
  const feeds: StewardFeedPayload[] = [];
  const svc = new StewardService({
    llm: opts.llm,
    orchestration,
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => true },
    emitFeed: (payload) => feeds.push(payload),
    ...(opts.sessions !== undefined ? { sessions: opts.sessions } : {}),
    ...(opts.projects !== undefined ? { projects: opts.projects } : {}),
    ...(opts.taskEngine !== undefined ? { taskEngine: opts.taskEngine } : {}),
    ...(opts.hasGitRepo !== undefined ? { hasGitRepo: opts.hasGitRepo } : {}),
    ...(opts.now !== undefined ? { clock: opts.now } : {}),
  });
  return { svc, orchestration };
}

const toolCall = (name: string, args: Record<string, unknown>): StewardLlmResponse => ({
  kind: "toolCall",
  id: `call-${name}`,
  name,
  args,
});

// 固定时基：2026-09-19 周六 15:00 本地（避免测试随真实时钟漂移）。
const NOW = new Date(2026, 8, 19, 15, 0, 0).getTime();
const fixedClock = () => NOW;

function sessRow(over: Partial<StewardSessionMetaRow> & { sessionId: string }): StewardSessionMetaRow {
  return {
    createdAt: over.createdAt ?? "2026-09-19T02:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-09-19T03:00:00.000Z",
    // 显式 null（标题会话零消息形态）需可构造——?? 会把 null 回落成缺省，
    // 故用 !== undefined 判别（L1 投影修复批：title 会话 firstUserText 恒 null）。
    firstUserText: over.firstUserText !== undefined ? over.firstUserText : "修复登录超时的问题",
    entryCount: over.entryCount ?? 12,
    ...(over.title !== undefined ? { title: over.title } : {}),
    sessionId: over.sessionId,
  };
}

// ── 1. 动态 prompt 组装管道 ────────────────────────────────

describe("A2-1 动态 prompt：context_snapshot 段", () => {
  test("快照段存在性：ask 组装的 systemPrompt = 静态人格段 + <context_snapshot> 包裹的情景段", async () => {
    const llm = fakeLlm([{ kind: "text", text: "好的" }]);
    const sessions = fakeSessions([
      sessRow({ sessionId: "s1", firstUserText: "修复登录超时", updatedAt: "2026-09-19T06:00:00.000Z" }),
      sessRow({ sessionId: "s2", firstUserText: "重构调度器", updatedAt: "2026-09-19T05:00:00.000Z" }),
    ]);
    const { svc } = makeA2Service({ llm, sessions, now: fixedClock });
    await svc.ask("最近在忙什么？");
    const prompt = llm.calls[0]!.request.systemPrompt;
    // 静态人格段保留（A1 契约不回退）
    expect(prompt.startsWith(STEWARD_SYSTEM_PROMPT)).toBe(true);
    // 快照段：XML 标签包裹 + 当前时间 + 计数 + 最近会话主题
    expect(prompt).toContain("<context_snapshot>");
    expect(prompt).toContain("</context_snapshot>");
    expect(prompt).toContain("2026-09-19");
    expect(prompt).toContain("活跃 agent");
    expect(prompt).toContain("2");
    expect(prompt).toContain("修复登录超时");
  });

  test("预算上限：快照段整体 ≤ CONTEXT_SNAPSHOT_MAX_CHARS（标签内字符硬顶）", () => {
    const snapshot = buildContextSnapshot({
      nowMs: NOW,
      activeAgents: 2,
      totalAgents: 5,
      sessionCount: 23,
      recentSessions: Array.from({ length: 2 }, (_, i) => ({
        title: "超长会话主题".repeat(200),
        updatedAt: "2026-09-19T06:00:00.000Z",
        sessionId: `s-${i}`,
      })),
    });
    expect(snapshot.length).toBeLessThanOrEqual(CONTEXT_SNAPSHOT_MAX_CHARS);
    expect(snapshot.startsWith("<context_snapshot>")).toBe(true);
    expect(snapshot.endsWith("</context_snapshot>")).toBe(true);
  });

  test("查询失败静默降级：sessions 源抛错 → systemPrompt 无快照段，对话主链路不受阻", async () => {
    const llm = fakeLlm([{ kind: "text", text: "好的" }]);
    const broken: ReturnType<typeof fakeSessions> = {
      created: [],
      titled: [],
      listSessionMetadata: async () => {
        throw new Error("db boom");
      },
      startDraftSession: async () => ({ sessionId: "x" }),
      createTitledSession: async () => ({ sessionId: "x" }),
      sessionExists: async () => true,
      deliverToSession: async () => ({ delivered: true, detail: "x" }),
    };
    const { svc } = makeA2Service({ llm, sessions: broken, now: fixedClock });
    const result = await svc.ask("最近在忙什么？");
    expect(result.status).toBe("answer"); // 主链路不受阻
    const prompt = llm.calls[0]!.request.systemPrompt;
    expect(prompt).not.toContain("<context_snapshot>");
    expect(prompt).toBe(STEWARD_SYSTEM_PROMPT); // 降级 = 纯静态段
  });

  test("assembleStewardSystemPrompt 纯函数：undefined 快照 → 原样静态段", () => {
    expect(assembleStewardSystemPrompt(undefined)).toBe(STEWARD_SYSTEM_PROMPT);
  });
});

// ── 2. query_recent_work 工具 ─────────────────────────────

describe("A2-2 query_recent_work（参数化查询）", () => {
  const rows = [
    sessRow({ sessionId: "today", updatedAt: "2026-09-19T06:00:00.000Z", createdAt: "2026-09-19T05:30:00.000Z" }),
    sessRow({ sessionId: "yday", updatedAt: "2026-09-18T10:00:00.000Z", createdAt: "2026-09-18T09:00:00.000Z", firstUserText: "昨天的会话" }),
    sessRow({ sessionId: "old", updatedAt: "2026-08-01T10:00:00.000Z", firstUserText: "上月的会话" }),
  ];

  async function askRecent(range: TimeRange | undefined, project?: string) {
    const llm = fakeLlm([
      toolCall("query_recent_work", range === undefined && project === undefined ? {} : { ...(range !== undefined ? { time_range: range } : {}), ...(project !== undefined ? { project } : {}) }),
      { kind: "text", text: "总结" },
    ]);
    const sessions = fakeSessions(rows);
    const { svc } = makeA2Service({ llm, sessions, now: fixedClock });
    await svc.ask("最近在忙什么？");
    return llm;
  }

  test("today 档：仅命中今日会话（LLM 回灌含标题/起止/消息量级）", async () => {
    const llm = await askRecent("today");
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "query_recent_work");
    expect(tr).toBeDefined();
    expect(tr!.text).toContain("修复登录超时");
    expect(tr!.text).toContain("09-19");
    expect(tr!.text).not.toContain("昨天的会话");
  });

  test("yesterday 档：命中昨日会话、不含今日与上月", async () => {
    const llm = await askRecent("yesterday");
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "query_recent_work");
    expect(tr!.text).toContain("昨天的会话");
    expect(tr!.text).not.toContain("修复登录超时的问题");
    expect(tr!.text).not.toContain("上月的会话");
  });

  test("this_week（默认档）：无 time_range 参数走本周；last_week 档窗口独立", async () => {
    const llm = await askRecent(undefined);
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "query_recent_work");
    expect(tr!.text).toContain("修复登录超时");
    expect(tr!.text).toContain("昨天的会话");
    expect(tr!.text).not.toContain("上月的会话");
    const llm2 = await askRecent("last_week");
    const tr2 = llm2.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "query_recent_work");
    expect(tr2!.text).toContain("无记录");
  });

  test("project 过滤：project=none 时任务清单按项目收窄（会话不滤）", async () => {
    const llm = fakeLlm([
      toolCall("query_recent_work", { time_range: "this_week", project: "helix" }),
      { kind: "text", text: "总结" },
    ]);
    const sessions = fakeSessions(rows);
    const orchestration = fakeOrchestration([{ agentId: "a", state: "running" }]);
    const svc = new StewardService({
      llm,
      orchestration,
      tasks: {
        listTasks: () => [
          {
            jobId: "j1",
            type: "code-review",
            title: "评审 helix",
            status: "done",
            projects: ["helix"],
            createdAt: "2026-09-19T01:00:00.000Z",
            progress: null,
            error: null,
          },
          {
            jobId: "j2",
            type: "code-review",
            title: "评审 other",
            status: "done",
            projects: ["other-proj"],
            createdAt: "2026-09-19T01:00:00.000Z",
            progress: null,
            error: null,
          },
        ] as never,
      },
      config: fakeConfig({ "steward.enabled": "1" }),
      feedGate: { hasStewardSubscribers: () => true },
      emitFeed: () => {},
      sessions,
      clock: fixedClock,
    });
    await svc.ask("最近在忙什么？");
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "query_recent_work");
    expect(tr!.text).toContain("评审 helix");
    expect(tr!.text).not.toContain("评审 other");
  });

  test("空结果：返回明确的『该时间范围无记录』文本", async () => {
    const llm = fakeLlm([
      toolCall("query_recent_work", { time_range: "last_week" }),
      { kind: "text", text: "好" },
    ]);
    const { svc } = makeA2Service({ llm, sessions: fakeSessions(rows), now: fixedClock });
    await svc.ask("上周做了什么？");
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "query_recent_work");
    expect(tr!.text).toContain("无记录");
  });

  test("timeRangeWindow 纯函数：四档窗口边界（today/昨/本周/上周）", () => {
    const today = timeRangeWindow("today", NOW);
    expect(today.label).toBe("today");
    expect(new Date(today.untilMs).getTime()).toBe(NOW);
    const start = new Date(today.sinceMs);
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(19);
    const yday = timeRangeWindow("yesterday", NOW);
    expect(new Date(yday.sinceMs).getDate()).toBe(18);
    expect(new Date(yday.untilMs).getDate()).toBe(19);
    expect(new Date(yday.untilMs).getHours()).toBe(0);
    const tw = timeRangeWindow("this_week", NOW);
    expect(new Date(tw.sinceMs).getDay()).toBe(1); // 周一
    const lw = timeRangeWindow("last_week", NOW);
    expect(new Date(lw.untilMs).getTime()).toBe(tw.sinceMs);
    expect(new Date(lw.sinceMs).getDay()).toBe(1);
  });
});

// ── 2b. query_recent_work 投影修复（L1 查询投影批） ─────
// 双缺陷修复（brief 红绿证据链）：① 标题会话（title 非空 + firstUserText
// null）不再显示「（无主题）」；② 会话行携完整 sessionId（deliver_to_session
// 参数源——prompt 路由行承诺「结果含 sessionId」由此兑现）；③ 可选
// title_contains 按显示标题过滤会话清单（命中/未命中）。
describe("A2-2b query_recent_work 投影修复（title 优先 + sessionId 完整 + title_contains）", () => {
  const TITLED_SID = "76cabd4f-3f2a-4c1e-9d21-8a7b6c5e4f01";
  const rows = [
    sessRow({ sessionId: TITLED_SID, title: "Godot MCP 调研", firstUserText: null, entryCount: 0, updatedAt: "2026-09-19T06:00:00.000Z", createdAt: "2026-09-19T05:00:00.000Z" }),
    sessRow({ sessionId: "sess-auto-named", firstUserText: "修复登录超时", updatedAt: "2026-09-19T05:00:00.000Z" }),
  ];

  async function askRecentWork(args: Record<string, unknown>, rowsOverride?: readonly StewardSessionMetaRow[]): Promise<string> {
    const llm = fakeLlm([
      toolCall("query_recent_work", args),
      { kind: "text", text: "总结" },
    ]);
    const sessions = fakeSessions(rowsOverride ?? rows);
    const { svc } = makeA2Service({ llm, sessions, now: fixedClock });
    await svc.ask("最近在忙什么？");
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "query_recent_work");
    if (tr === undefined || tr.text === undefined) throw new Error("query_recent_work toolResult 缺失");
    return tr.text;
  }

  test("红①：标题会话（title 非空 + firstUserText null）显示 title 而非「（无主题）」", async () => {
    const text = await askRecentWork({ time_range: "this_week" });
    expect(text).toContain("Godot MCP 调研");
    expect(text).not.toContain("（无主题）");
  });

  test("红①b：title 与 firstUserText 并存时显式标题列优先（旧自动会话仍回落首条消息）", async () => {
    const text = await askRecentWork(
      { time_range: "this_week" },
      [sessRow({ sessionId: "sid-both", title: "显式标题", firstUserText: "首条用户消息正文", updatedAt: "2026-09-19T06:00:00.000Z" })],
    );
    expect(text).toContain("显式标题");
    expect(text).not.toContain("首条用户消息正文");
  });

  test("红②：会话行含完整 sessionId（与构造值全等；无省略号截断）", async () => {
    const text = await askRecentWork({ time_range: "this_week" });
    expect(text).toContain(TITLED_SID);
    expect(text).toContain("sess-auto-named");
    expect(text).not.toContain(`${TITLED_SID.slice(0, 8)}…`);
  });

  test("红③：title_contains 命中——仅列显示标题含关键词的会话（计数同口径）", async () => {
    const text = await askRecentWork({ time_range: "this_week", title_contains: "Godot" });
    expect(text).toContain("Godot MCP 调研");
    expect(text).not.toContain("修复登录超时");
    expect(text).toContain("【会话·1】");
  });

  test("红③b：title_contains 未命中——会话段为空但与「真无记录」可区分（不吞任务清单段头）", async () => {
    const text = await askRecentWork({ time_range: "this_week", title_contains: "不存在的关键词" });
    expect(text).not.toContain("Godot MCP 调研");
    expect(text).not.toContain("修复登录超时");
    expect(text).not.toContain("无记录");
    expect(text).toContain("【会话·0】");
    expect(text).toContain("均不含关键词");
  });
});

// ── 3. create_session / spawn_review_task（写操作 → 确认闸） ──

describe("A2-3 create_session（确认闸）", () => {
  test("提案 → confirm_required（携摘要）→ confirm 后 createTitledSession 恰一次 + 回执带 sessionId（修复批①：同轨不同入口，title 不再被当首条消息发送）", async () => {
    const llm = fakeLlm([toolCall("create_session", { title: "调度器重构" })]);
    const sessions = fakeSessions([]);
    const { svc } = makeA2Service({ llm, sessions, now: fixedClock });
    const askResult = await svc.ask("帮我开个新会话");
    expect(askResult.status).toBe("confirm_required");
    if (askResult.status !== "confirm_required") throw new Error("unreachable");
    expect(askResult.message).toContain("调度器重构");
    expect(sessions.titled.length).toBe(0); // 未确认零执行
    expect(sessions.created.length).toBe(0); // 旧入口 startDraftSession 零调用（死锁链根因封堵）
    const confirmed = await svc.confirm(askResult.actionId);
    expect(confirmed.status).toBe("ok");
    if (confirmed.status !== "ok") throw new Error("unreachable");
    expect(confirmed.detail).toContain("sess-new-1");
    expect(sessions.titled).toEqual(["调度器重构"]); // 新入口恰一次，title 原样
    expect(sessions.created.length).toBe(0);
  });

  test("actionId 单次消费：二次 confirm → error 判别，createTitledSession 仍恰一次", async () => {
    const llm = fakeLlm([toolCall("create_session", {})]);
    const sessions = fakeSessions([]);
    const { svc } = makeA2Service({ llm, sessions, now: fixedClock });
    const askResult = await svc.ask("开个会话");
    await svc.confirm(askResult.status === "confirm_required" ? askResult.actionId : "");
    const second = await svc.confirm(askResult.status === "confirm_required" ? askResult.actionId : "");
    expect(second.status).toBe("error");
    expect(sessions.titled.length).toBe(1);
  });

  test("title 缺省自动生成（含时间）", async () => {
    const llm = fakeLlm([toolCall("create_session", {})]);
    const sessions = fakeSessions([]);
    const { svc } = makeA2Service({ llm, sessions, now: fixedClock });
    const askResult = await svc.ask("开个会话");
    expect(askResult.status).toBe("confirm_required");
    if (askResult.status !== "confirm_required") throw new Error("unreachable");
    expect(askResult.message).toContain("会话");
    expect(askResult.message.length).toBeGreaterThan(4);
  });

  test("confirm 执行结果回灌工作记忆（下轮 ask LLM 可见新 session 回执）", async () => {
    const llmA = fakeLlm([toolCall("create_session", { title: "调研" })]);
    const sessions = fakeSessions([]);
    const { svc } = makeA2Service({ llm: llmA, sessions, now: fixedClock });
    const askResult = await svc.ask("开个会话");
    await svc.confirm(askResult.status === "confirm_required" ? askResult.actionId : "");
    // 下轮 ask：LLM 窗口应含 spawn_review_task/create_session 的执行 toolResult
    const llmB = fakeLlm([{ kind: "text", text: "已创建" }]);
    const svc2 = undefined; // 同一 service 实例继续对话（工作记忆持久）
    void svc2;
    const llmC = fakeLlm([{ kind: "text", text: "ok" }]);
    void llmC;
    const follow = await svc.ask("刚才那个会话建好了吗？");
    void follow;
    void llmB;
    // 用第二次 ask 的请求窗口断言（llmA 已耗尽——改用新 fake 挂回）
    // 直接断言 getHistory：confirm 后应有 create_session 的 toolResult 记录
    const history = await svc.getHistory();
    const tr = history.find((r) => r.kind === "toolResult" && r.name === "create_session");
    expect(tr).toBeDefined();
    if (tr !== undefined && tr.kind === "toolResult") {
      expect(tr.text).toContain("sess-new-1");
    }
  });
});

describe("A2-3 spawn_review_task（前置校验 + 确认闸）", () => {
  function reviewLlm(args: Record<string, unknown>) {
    return fakeLlm([toolCall("spawn_review_task", args)]);
  }

  test("提案 → confirm_required（agentId 携 type@project 摘要）→ confirm 后 createTask 恰一次", async () => {
    const llm = reviewLlm({ review_type: "code-review", project: "helix", params: { scope: "diff" } });
    const taskEngine = fakeTaskEngine();
    const { svc } = makeA2Service({
      llm,
      sessions: fakeSessions([]),
      projects: fakeProjects(),
      taskEngine,
      hasGitRepo: () => true,
      now: fixedClock,
    });
    const askResult = await svc.ask("给 helix 开个 code-review");
    expect(askResult.status).toBe("confirm_required");
    if (askResult.status !== "confirm_required") throw new Error("unreachable");
    expect(askResult.agentId).toContain("code-review");
    expect(askResult.message).toContain("helix");
    expect(taskEngine.created.length).toBe(0); // 未确认零执行
    const confirmed = await svc.confirm(askResult.actionId);
    expect(confirmed.status).toBe("ok");
    expect(taskEngine.created.length).toBe(1);
    expect(taskEngine.created[0]!.type).toBe("code-review");
    expect(taskEngine.created[0]!.projects).toEqual(["helix"]);
    expect(taskEngine.created[0]!.params).toEqual({ scope: "diff" });
    expect(taskEngine.created[0]!.createdBy).toBe("chat");
  });

  test("kg-review 无索引 → 引导式失败（toolResult 提示需先 kg-bootstrap，不进确认闸）", async () => {
    const llm = fakeLlm([
      toolCall("spawn_review_task", { review_type: "kg-review", project: "helix" }),
      { kind: "text", text: "该项目还没有知识图谱，需要先运行 kg-bootstrap。" },
    ]);
    const taskEngine = fakeTaskEngine();
    const { svc } = makeA2Service({
      llm,
      sessions: fakeSessions([]),
      projects: fakeProjects({ indexed: [] }), // helix 无 .kg 索引
      taskEngine,
      now: fixedClock,
    });
    const askResult = await svc.ask("给 helix 开个 kg-review");
    expect(askResult.status).toBe("answer"); // 引导式：工具结果回灌 → LLM 可转述/追问
    expect(taskEngine.created.length).toBe(0);
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "spawn_review_task");
    expect(tr).toBeDefined();
    expect(tr!.text).toContain("kg-bootstrap");
  });

  test("code-review 无 git 仓 → 引导式失败", async () => {
    const llm = fakeLlm([
      toolCall("spawn_review_task", { review_type: "code-review", project: "helix" }),
      { kind: "text", text: "该项目没有 git 仓，无法评审。" },
    ]);
    const taskEngine = fakeTaskEngine();
    const { svc } = makeA2Service({
      llm,
      sessions: fakeSessions([]),
      projects: fakeProjects(),
      taskEngine,
      hasGitRepo: () => false,
      now: fixedClock,
    });
    const askResult = await svc.ask("给 helix 开个 code-review");
    expect(askResult.status).toBe("answer");
    expect(taskEngine.created.length).toBe(0);
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "spawn_review_task");
    expect(tr!.text).toContain("git");
  });

  test("项目不存在 → 引导式失败（提示 workspace 项目清单）", async () => {
    const llm = fakeLlm([
      toolCall("spawn_review_task", { review_type: "code-review", project: "no-such" }),
      { kind: "text", text: "没有找到这个项目，请确认项目名。" },
    ]);
    const taskEngine = fakeTaskEngine();
    const { svc } = makeA2Service({
      llm,
      sessions: fakeSessions([]),
      projects: fakeProjects(),
      taskEngine,
      hasGitRepo: () => true,
      now: fixedClock,
    });
    const askResult = await svc.ask("给 no-such 开个评审");
    expect(askResult.status).toBe("answer");
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "spawn_review_task");
    expect(tr!.text).toContain("no-such");
  });

  test("review_type 非法 → 引导式失败（枚举提示）", async () => {
    const llm = fakeLlm([
      toolCall("spawn_review_task", { review_type: "xxx", project: "helix" }),
      { kind: "text", text: "评审类型不对，只能是 code-review 或 kg-review。" },
    ]);
    const taskEngine = fakeTaskEngine();
    const { svc } = makeA2Service({
      llm,
      sessions: fakeSessions([]),
      projects: fakeProjects(),
      taskEngine,
      now: fixedClock,
    });
    const askResult = await svc.ask("开个 xxx");
    expect(askResult.status).toBe("answer");
    const tr = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult" && m.name === "spawn_review_task");
    expect(tr!.text).toContain("code-review");
  });

  test("paramsSchema 违规：confirm 后引擎错误原样透传回执 + 回灌工作记忆", async () => {
    const llm = reviewLlm({ review_type: "code-review", project: "helix", params: { scope: "bad" } });
    const taskEngine = fakeTaskEngine();
    const { svc } = makeA2Service({
      llm,
      sessions: fakeSessions([]),
      projects: fakeProjects(),
      taskEngine,
      hasGitRepo: () => true,
      now: fixedClock,
    });
    const askResult = await svc.ask("给 helix 开个 code-review");
    expect(askResult.status).toBe("confirm_required"); // 前置校验过（引擎 paramsSchema 在确认后）
    const confirmed = await svc.confirm(askResult.status === "confirm_required" ? askResult.actionId : "");
    expect(confirmed.status).toBe("error");
    if (confirmed.status !== "error") throw new Error("unreachable");
    expect(confirmed.reason).toContain("KG_E_PARAM");
    // 回灌工作记忆：LLM 下轮可见违规原文（可转述）
    const history = await svc.getHistory();
    const tr = history.find((r) => r.kind === "toolResult" && r.name === "spawn_review_task");
    expect(tr).toBeDefined();
    if (tr !== undefined && tr.kind === "toolResult") {
      expect(tr.text).toContain("KG_E_PARAM");
    }
  });

  test("确认闸单次消费：二次 confirm → error，createTask 仍恰一次", async () => {
    const llm = reviewLlm({ review_type: "kg-review", project: "helix" });
    const taskEngine = fakeTaskEngine();
    const { svc } = makeA2Service({
      llm,
      sessions: fakeSessions([]),
      projects: fakeProjects({ indexed: ["/ws/helix"] }),
      taskEngine,
      now: fixedClock,
    });
    const askResult = await svc.ask("给 helix 开个 kg-review");
    expect(askResult.status).toBe("confirm_required");
    const actionId = askResult.status === "confirm_required" ? askResult.actionId : "";
    await svc.confirm(actionId);
    const second = await svc.confirm(actionId);
    expect(second.status).toBe("error");
    expect(taskEngine.created.length).toBe(1);
  });
});

// ── 4. 快照与 list_instances 口径一致 ─────────────────────

describe("A2-4 快照与工具口径一致性", () => {
  test("快照『活跃 agent 数』与 list_instances 紧凑投影同源（orchestration.status() 同一调用面）", async () => {
    const llmA = fakeLlm([{ kind: "text", text: "ok" }]);
    const sessions = fakeSessions([sessRow({ sessionId: "s1" })]);
    const { svc, orchestration } = makeA2Service({ llm: llmA, sessions, now: fixedClock });
    await svc.ask("现在什么状态？");
    const prompt = llmA.calls[0]!.request.systemPrompt;
    const snapshotBlock = prompt.slice(prompt.indexOf("<context_snapshot>"), prompt.indexOf("</context_snapshot>"));
    // 从同一 orchestration 面数 running（与 list_instances 工具路径同源）
    const runningCount = orchestration.status().filter((s) => s.state === "running").length;
    expect(runningCount).toBe(2);
    expect(snapshotBlock).toContain(`活跃 agent：${runningCount}`);
  });
});
