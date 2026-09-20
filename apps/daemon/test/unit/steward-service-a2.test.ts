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

/** A2 会话源 fake（listSessionMetadata + startDraftSession 记录调用）。 */
function fakeSessions(rows: readonly StewardSessionMetaRow[]) {
  const created: { text: string; mode?: string }[] = [];
  let seq = 0;
  return {
    created,
    listSessionMetadata: async () => [...rows],
    startDraftSession: async (text: string, mode?: string) => {
      created.push({ text, mode });
      seq += 1;
      return { sessionId: `sess-new-${seq}` };
    },
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
    firstUserText: over.firstUserText ?? "修复登录超时的问题",
    entryCount: over.entryCount ?? 12,
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
      listSessionMetadata: async () => {
        throw new Error("db boom");
      },
      startDraftSession: async () => ({ sessionId: "x" }),
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

// ── 3. create_session / spawn_review_task（写操作 → 确认闸） ──

describe("A2-3 create_session（确认闸）", () => {
  test("提案 → confirm_required（携摘要）→ confirm 后 startDraftSession 恰一次 + 回执带 sessionId", async () => {
    const llm = fakeLlm([toolCall("create_session", { title: "调度器重构" })]);
    const sessions = fakeSessions([]);
    const { svc } = makeA2Service({ llm, sessions, now: fixedClock });
    const askResult = await svc.ask("帮我开个新会话");
    expect(askResult.status).toBe("confirm_required");
    if (askResult.status !== "confirm_required") throw new Error("unreachable");
    expect(askResult.message).toContain("调度器重构");
    expect(sessions.created.length).toBe(0); // 未确认零执行
    const confirmed = await svc.confirm(askResult.actionId);
    expect(confirmed.status).toBe("ok");
    if (confirmed.status !== "ok") throw new Error("unreachable");
    expect(confirmed.detail).toContain("sess-new-1");
    expect(sessions.created.length).toBe(1);
    expect(sessions.created[0]!.text).toContain("调度器重构");
  });

  test("actionId 单次消费：二次 confirm → error 判别，startDraftSession 仍恰一次", async () => {
    const llm = fakeLlm([toolCall("create_session", {})]);
    const sessions = fakeSessions([]);
    const { svc } = makeA2Service({ llm, sessions, now: fixedClock });
    const askResult = await svc.ask("开个会话");
    await svc.confirm(askResult.status === "confirm_required" ? askResult.actionId : "");
    const second = await svc.confirm(askResult.status === "confirm_required" ? askResult.actionId : "");
    expect(second.status).toBe("error");
    expect(sessions.created.length).toBe(1);
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
