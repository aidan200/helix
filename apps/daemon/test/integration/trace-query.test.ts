import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import { MAIN_SESSION_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SUBAGENT_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * CL-5 trace 查询面集成（I 层，T2.1；契约 v0.4 §1/§4 + architecture.md §3.4/§3.5/§3.5b）：
 * 真组合根（createDaemon + FakeAgentEngine 注入）× 真 SQLite（tmp home）× loopback WS。
 * - ① trace.query roundtrip：混合事件（主+Sub+多类型+跨时间窗）→ WS 命令 →
 *   结果帧形态（filterEcho/instances/events/page）与过滤语义（instanceIds 多选
 *   /agentKind/types/timeRange 含起含止/空数组=空结果/缺省全量）；
 * - ② 分页：id 游标遍历不重不漏 + hasMore 收口；
 * - ③ 三发布点：会话转正（首个用户条目）→主 instantiated（systemPrompt
 *   全文）；spawn→Sub instantiated（model=三级链解析结果）；
 *   model.set→model.changed（from/to）；
 * - ④ 实例面板 fold：主+多 Sub 混合会话 → InstanceRecord 字段齐全；
 * - ⑤ 重启回填：spawn（带 model）→ 重启恢复 → instances[] model 非缺失 +
 *   instantiated/model.changed 可查；
 * - ⑥ 校验失败 → connection.error（command.invalid_payload，点对点）。
 */

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

interface TraceRow {
  id: number;
  ts: string;
  sessionId: string;
  instanceId: string;
  agentKind: string;
  type: string;
  payload: Record<string, unknown>;
}

interface TraceResultPayload {
  filterEcho: {
    sessionId: string;
    instanceIds: string[] | null;
    agentKind: string | null;
    types: string[] | null;
    timeRange: { from: string | null; to: string | null } | null;
    page: { limit: number; beforeId: number | null };
  };
  instances: Record<string, unknown>[];
  events: TraceRow[];
  page: { loaded: number; total: number; hasMore: boolean };
}

/** 收集帧的 loopback WS 测试客户端（同 ws-server.test.ts 先例）。 */
class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async open(): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, 3000, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** 发 trace.query 并等新结果帧（afterIndex 之前的同型帧不算）。 */
  async traceQuery(payload: Record<string, unknown>): Promise<TraceResultPayload> {
    const at = this.frames.length;
    this.send({ v: PROTOCOL_VERSION, type: "trace.query", payload });
    await until(
      () => this.frames.slice(at).some((f) => f.type === "trace.query.result"),
      3000,
      "等待 trace.query.result",
    );
    return this.frames.slice(at).find((f) => f.type === "trace.query.result")!.payload as unknown as TraceResultPayload;
  }

  /** 轮询直到某查询满足谓词（WriteQueue 异步落盘屏障）。 */
  async traceQueryUntil(
    payload: Record<string, unknown>,
    pred: (r: TraceResultPayload) => boolean,
    what: string,
  ): Promise<TraceResultPayload> {
    const t0 = Date.now();
    for (;;) {
      const r = await this.traceQuery(payload);
      if (pred(r)) return r;
      if (Date.now() - t0 > 5000) throw new Error(`等待超时：${what}`);
      await new Promise((r2) => setTimeout(r2, 10));
    }
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-trace-it-"));
}

interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createDaemon>>;
  client: TestClient;
  sessionId: string;
}

/** 组合根全链装配 + 握手（engine 初始模型 anthropic/claude-sonnet-4-5 → spawn 快照/切模 from 同源）。 */
async function makeRig(home: string, opts: { initialModel?: string; replies?: { text: string }[] } = {}): Promise<Rig> {
  const engine = new FakeAgentEngine({
    initialModel: opts.initialModel ?? "anthropic/claude-sonnet-4-5",
    replies: opts.replies,
  });
  const daemon = await createDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  const client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
  await client.open();
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  // T4：握手命中零条目内存草稿（welcome.draft）时不 attach 不推快照——显式
  // session.subscribe 订阅当前会话（v0 兼容面）；重启恢复的真实会话握手维持现状。
  await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  const welcome = client.frames.find((f) => f.type === "connection.welcome")!;
  if (welcome.payload.draft === true) {
    client.send({ v: 0, type: "session.subscribe", payload: {} });
  }
  await until(() => client.frames.some((f) => f.type === "session.snapshot"), 3000, "握手快照");
  return { home, daemon, client, sessionId: daemon.registry.currentSessionId() };
}

/**
 * 混合现场：主实例一轮对话 + 两个 Sub（agent-1 运行中 / agent-2 killed）+
 * 一次 model.set（anthropic/claude-sonnet-4-5 → anthropic/claude-haiku-4-5）；落盘屏障后返回。
 */
async function seedMixedSession(rig: Rig): Promise<void> {
  const { daemon, client, sessionId } = rig;
  client.send({ v: PROTOCOL_VERSION, sessionId, type: "chat.send", payload: { text: "你好" } });
  await until(
    () => client.frames.some((f) => f.type === "chat.turn.completed"),
    5000,
    "首轮对话收口",
  );

  const s1 = daemon.orchestration.spawn("任务一");
  expect(s1.status === "run" || s1.status === "queued").toBe(true);
  const s2 = daemon.orchestration.spawn("任务二");
  expect(s2.status === "run" || s2.status === "queued").toBe(true);
  const agent2 = s2.status === "run" || s2.status === "queued" ? s2.agentId : "";
  const killed = daemon.orchestration.kill(agent2);
  expect(killed.killed).toBe(true);

  client.send({
    v: PROTOCOL_VERSION,
    sessionId,
    type: "model.set",
    payload: { model: "anthropic/claude-haiku-4-5" },
  });
  await until(() => client.frames.some((f) => f.type === "model.changed"), 3000, "model.changed 广播");

  // 落盘屏障：轮询到 agent-2 的 killed 与 model.changed 均可查（fan-out → WriteQueue 异步）
  await client.traceQueryUntil(
    { sessionId, types: ["agent.killed", "agent.model.changed"] },
    (r) => r.events.length >= 2,
    "killed/model.changed 落盘",
  );
}

describe("① trace.query roundtrip：结果帧形态与过滤语义（契约 v0.4 §1/§4）", () => {
  test("缺省全量 + filterEcho 归一 + 信封章印；实例/类型/时间窗/空数组过滤语义", async () => {
    const home = tmpHome();
    const rig = await makeRig(home, { replies: [{ text: "你好，我是主会话。" }] });
    try {
      await seedMixedSession(rig);
      const { client, sessionId } = rig;

      // ── 缺省全量：只传 sessionId ──
      const all = await client.traceQuery({ sessionId });
      // 信封章印（trace 新族 + 目标会话归属）
      const frame = rig.client.frames.filter((f) => f.type === "trace.query.result").at(-1)!;
      expect(frame.channel).toBe("trace");
      expect(frame.sessionId).toBe(sessionId);
      expect(frame.v).toBe(PROTOCOL_VERSION);
      // filterEcho：缺省维归一 null + page 缺省 50/游标 null
      expect(all.filterEcho).toEqual({
        sessionId,
        instanceIds: null,
        agentKind: null,
        types: null,
        timeRange: null,
        page: { limit: 50, beforeId: null },
      });
      // 事件行：id 降序（最新在前）；总量 < 50 → 一页装完、hasMore 收口
      expect(all.page.total).toBeGreaterThan(10);
      expect(all.page.loaded).toBe(all.page.total);
      expect(all.page.hasMore).toBe(false);
      const ids = all.events.map((e) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
      // 行形态：六字段齐全
      for (const row of all.events) {
        expect(typeof row.id).toBe("number");
        expect(typeof row.ts).toBe("string");
        expect(row.sessionId).toBe(sessionId);
        expect(typeof row.instanceId).toBe("string");
        expect(["main", "subagent"]).toContain(row.agentKind);
        expect(typeof row.type).toBe("string");
      }

      // ── instanceIds 多选 ──
      const subOnly = await client.traceQuery({ sessionId, instanceIds: ["agent-1"] });
      expect(subOnly.filterEcho.instanceIds).toEqual(["agent-1"]);
      expect(subOnly.events.length).toBeGreaterThan(0);
      expect(subOnly.events.every((e) => e.instanceId === "agent-1")).toBe(true);
      expect(subOnly.page.total).toBe(subOnly.events.length);

      // ── 空数组 = 空结果（不展开为「全部」）──
      const emptyInstances = await client.traceQuery({ sessionId, instanceIds: [] });
      expect(emptyInstances.events).toEqual([]);
      expect(emptyInstances.page.total).toBe(0);
      const emptyTypes = await client.traceQuery({ sessionId, types: [] });
      expect(emptyTypes.events).toEqual([]);
      expect(emptyTypes.page.total).toBe(0);

      // ── agentKind 过滤 ──
      const subs = await client.traceQuery({ sessionId, agentKind: "subagent" });
      expect(subs.events.length).toBeGreaterThan(0);
      expect(subs.events.every((e) => e.agentKind === "subagent")).toBe(true);

      // ── types 多选 ──
      const lifecycle = await client.traceQuery({ sessionId, types: ["agent.spawned", "agent.instantiated"] });
      expect(lifecycle.events.length).toBe(5); // 两 Sub 各 spawned+instantiated + 主 instantiated
      expect(lifecycle.events.every((e) => e.type === "agent.spawned" || e.type === "agent.instantiated")).toBe(true);

      // ── timeRange 含起含止（窗口取自行数据，边界行两侧皆含）──
      const rows = all.events; // id 降序
      const from = rows[Math.min(3, rows.length - 1)]!.ts;
      const to = rows[0]!.ts;
      const ranged = await client.traceQuery({ sessionId, timeRange: { from, to } });
      const expected = rows.filter((e) => e.ts >= from && e.ts <= to);
      expect(ranged.events.map((e) => e.id)).toEqual(expected.map((e) => e.id));
      expect(ranged.page.total).toBe(expected.length);
      expect(ranged.filterEcho.timeRange).toEqual({ from, to });
      // 单边窗（只给 to）：含止于 to
      const onlyTo = await client.traceQuery({ sessionId, timeRange: { to: rows[1]!.ts } });
      expect(onlyTo.events.every((e) => e.ts <= rows[1]!.ts)).toBe(true);
      expect(onlyTo.events.some((e) => e.ts === rows[1]!.ts)).toBe(true); // 含止

      // ── 面板独立：过滤不影响 instances 块（恒全会话 fold，AF-5）──
      expect(subOnly.instances.length).toBe(all.instances.length);
    } finally {
      await rig.client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("校验失败 → connection.error（command.invalid_payload，点对点）", async () => {
    const home = tmpHome();
    const rig = await makeRig(home);
    try {
      const at = rig.client.frames.length;
      rig.client.send({ v: PROTOCOL_VERSION, type: "trace.query", payload: {} }); // sessionId 缺失
      await until(
        () => rig.client.frames.slice(at).some((f) => f.type === "connection.error"),
        3000,
        "等待错误回帧",
      );
      const err = rig.client.frames.slice(at).find((f) => f.type === "connection.error")!;
      expect((err.payload as { code: string }).code).toBe("command.invalid_payload");
      expect(String((err.payload as { message: string }).message)).toContain("sessionId");
    } finally {
      await rig.client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("② 分页：id 游标遍历不重不漏 + hasMore 收口（契约 §4 机械判据）", () => {
  test("limit=4 遍历拼接 = 全量 id 集合；每页 id < beforeId；末页 hasMore=false", async () => {
    const home = tmpHome();
    const rig = await makeRig(home, {
      replies: [{ text: "第一轮回复。" }, { text: "第二轮回复。" }],
    });
    try {
      await seedMixedSession(rig);
      // 再补一轮对话加厚事件量
      rig.client.send({ v: PROTOCOL_VERSION, sessionId: rig.sessionId, type: "chat.send", payload: { text: "再来一轮" } });
      await until(
        () => rig.client.frames.filter((f) => f.type === "chat.turn.completed").length >= 2,
        5000,
        "次轮对话收口",
      );

      const full = await rig.client.traceQueryUntil(
        { sessionId: rig.sessionId },
        (r) => r.events.every(() => true) && r.page.total === r.page.loaded,
        "全量一页装完",
      );
      expect(full.page.total).toBeGreaterThan(12);
      const fullIds = full.events.map((e) => e.id);

      // 游标遍历（limit=4）
      const walked: number[] = [];
      let beforeId: number | undefined;
      for (;;) {
        const page = await rig.client.traceQuery({
          sessionId: rig.sessionId,
          page: { limit: 4, ...(beforeId !== undefined ? { beforeId } : {}) },
        });
        expect(page.page.loaded).toBe(page.events.length);
        if (beforeId !== undefined) {
          expect(page.events.every((e) => e.id < beforeId!)).toBe(true); // 游标语义
          expect(page.filterEcho.page.beforeId).toBe(beforeId);
        }
        walked.push(...page.events.map((e) => e.id));
        if (!page.page.hasMore) break;
        beforeId = page.events.at(-1)!.id;
      }
      // 不重不漏：拼接 id 序列与全量完全一致（同序同集）
      expect(walked).toEqual(fullIds);
      expect(new Set(walked).size).toBe(walked.length);
    } finally {
      await rig.client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("③ 三发布点落盘断言（F5.7 锚 1-2 / F5.9 锚 1；T4：主 instantiated 发布点 = 转正）", () => {
  test("会话转正→主 instantiated（systemPrompt 全文）；spawn→Sub instantiated（model=三级链结果）；model.set→model.changed", async () => {
    const home = tmpHome();
    const rig = await makeRig(home, { replies: [{ text: "回复。" }] });
    try {
      await seedMixedSession(rig);
      const { client, sessionId } = rig;

      // ── 主实例 instantiated（会话创建发布点）──
      const mainInst = await client.traceQuery({ sessionId, types: ["agent.instantiated"], instanceIds: ["main"] });
      expect(mainInst.events.length).toBe(1);
      const mainSnap = (mainInst.events[0]!.payload as { profileKind: string; profileSnapshot: { systemPrompt: string; tools: string[]; model: string; compaction?: { enabled: boolean }; hooks?: string[] } });
      expect(mainSnap.profileKind).toBe("main-session");
      // M6 T3 快照供给改读组装缓存：systemPrompt = 瘦身 base 全文前缀 + 动态工具段
      expect(mainSnap.profileSnapshot.systemPrompt.startsWith(MAIN_SESSION_SYSTEM_PROMPT)).toBe(true); // base 全文非引用（组装产物前缀）
      expect(mainSnap.profileSnapshot.systemPrompt).toContain("可用工具："); // 组装产物（T2 三段组装器）
      expect(mainSnap.profileSnapshot.tools).toContain("bash");
      expect(mainSnap.profileSnapshot.model).toBe("anthropic/claude-sonnet-4-5"); // 创建时引擎观测值
      expect(mainSnap.profileSnapshot.compaction?.enabled).toBe(true);
      expect(mainSnap.profileSnapshot.hooks).toEqual(["steer", "minimal"]);

      // ── Sub instantiated（spawn 同批；model=三级链解析结果，与 spawn 透传同源）──
      const subEvents = await client.traceQuery({ sessionId, types: ["agent.spawned", "agent.instantiated"], agentKind: "subagent" });
      const subInst = subEvents.events.filter((e) => e.type === "agent.instantiated");
      expect(subInst.length).toBe(2);
      for (const row of subInst) {
        const p = row.payload as { instanceId: string; profileKind: string; profileSnapshot: { systemPrompt: string; model: string } };
        expect(p.profileKind).toBe("subagent-worker");
        expect(p.profileSnapshot.systemPrompt.startsWith(SUBAGENT_SYSTEM_PROMPT)).toBe(true); // base 全文（组装产物前缀）
        expect(p.profileSnapshot.systemPrompt).toContain("可用工具：");
        // 三级链：profile 槽位（未声明）?? spawn 会话快照（anthropic/claude-sonnet-4-5）?? 全局兜底
        expect(p.profileSnapshot.model).toBe("anthropic/claude-sonnet-4-5");
        // 同源判据：与该实例 agent.spawned 透传 model 同值
        const spawned = subEvents.events.find(
          (e) => e.type === "agent.spawned" && (e.payload as { agentId: string }).agentId === p.instanceId,
        )!;
        expect((spawned.payload as { model?: string }).model).toBe("anthropic/claude-sonnet-4-5");
      }

      // ── model.changed（model.set 发布点；from/to 正确）──
      const changes = await client.traceQuery({ sessionId, types: ["agent.model.changed"] });
      expect(changes.events.length).toBe(1);
      expect(changes.events[0]!.payload).toEqual({
        instanceId: "main",
        from: "anthropic/claude-sonnet-4-5", // 切换前引擎观测值
        to: "anthropic/claude-haiku-4-5",
      });
    } finally {
      await rig.client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("快照观测漂移修复（M6 T3）：instantiated/spawned 快照改读组装缓存——toggle 后快照跟随生效集与槽位", async () => {
    const home = tmpHome();
    const rig = await makeRig(home, { replies: [{ text: "回复。" }] });
    try {
      // 转正（首个用户条目）/spawn 前变更配置：main 禁 grep、subagent 禁 read、
      // subagent 槽位设 haiku（三级链第一级 UI 化）
      await rig.daemon.resource.toggle("main-session", "tool", "grep", false);
      await rig.daemon.resource.toggle("subagent-worker", "tool", "read", false);
      await rig.daemon.resource.setModel("subagent-worker", "anthropic/claude-haiku-4-5");
      await seedMixedSession(rig);
      const { client, sessionId } = rig;

      // 主实例 instantiated：快照 = 组装缓存现值（10 工具不含 grep；提示无 grep 行）
      const mainInst = await client.traceQuery({ sessionId, types: ["agent.instantiated"], instanceIds: ["main"] });
      expect(mainInst.events.length).toBe(1);
      const mainSnap = mainInst.events[0]!.payload as {
        profileSnapshot: { systemPrompt: string; tools: string[] };
      };
      expect(mainSnap.profileSnapshot.tools).toHaveLength(10);
      expect(mainSnap.profileSnapshot.tools).not.toContain("grep");
      expect(mainSnap.profileSnapshot.systemPrompt).not.toContain("- grep:");

      // Sub instantiated：快照 = 组装缓存（6 工具不含 read）+ 槽位模型（非 spawn 透传）
      const subInst = await client.traceQuery({ sessionId, types: ["agent.instantiated"], agentKind: "subagent" });
      expect(subInst.events.length).toBe(2);
      for (const row of subInst.events) {
        const p = row.payload as {
          profileSnapshot: { systemPrompt: string; tools: string[]; model: string };
        };
        expect(p.profileSnapshot.tools).toHaveLength(6);
        expect(p.profileSnapshot.tools).not.toContain("read");
        expect(p.profileSnapshot.model).toBe("anthropic/claude-haiku-4-5"); // 槽位第一级（uiModelSlot ?? spawn 快照 ?? 全局）
        expect(p.profileSnapshot.systemPrompt).not.toContain("- read:");
      }
    } finally {
      await rig.client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("④ 实例面板 fold：主 + 多 Sub 混合会话 → InstanceRecord 字段齐全", () => {
  test("主 running 带快照/时间线；agent-1 running 带 task；agent-2 killed 带 endedAt；面板不受过滤维影响", async () => {
    const home = tmpHome();
    const rig = await makeRig(home, { replies: [{ text: "回复。" }] });
    try {
      await seedMixedSession(rig);
      const r = await rig.client.traceQuery({ sessionId: rig.sessionId, types: ["agent.spawned"] });
      expect(r.instances.length).toBe(3);
      // 主实例优先，其余启动序
      expect(r.instances.map((i) => i.instanceId)).toEqual(["main", "agent-1", "agent-2"]);

      const main = r.instances[0]!;
      expect(main.agentKind).toBe("main");
      expect(main.profileKind).toBe("main-session");
      expect(main.status).toBe("running");
      expect(main.snapshotMissing).toBe(false);
      expect((main.snapshot as { systemPrompt: string }).systemPrompt.startsWith(MAIN_SESSION_SYSTEM_PROMPT)).toBe(true); // M6 T3：组装快照 = base 前缀 + 动态段
      expect(typeof main.startedAt).toBe("string");
      expect(main.endedAt).toBeUndefined();
      expect(typeof main.eventCount).toBe("number");
      expect(main.eventCount as number).toBeGreaterThan(0);
      expect((main.modelTimeline as { from: string; to: string }[]).map((c) => [c.from, c.to])).toEqual([
        ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
      ]);
      expect(main.currentModel).toBe("anthropic/claude-haiku-4-5");

      const sub1 = r.instances[1]!;
      expect(sub1.agentKind).toBe("subagent");
      expect(sub1.status).toBe("running"); // 占位 runner：无终态
      expect(sub1.task).toBe("任务一");
      expect(sub1.snapshotMissing).toBe(false);
      expect((sub1.snapshot as { model: string }).model).toBe("anthropic/claude-sonnet-4-5");
      expect(sub1.currentModel).toBe("anthropic/claude-sonnet-4-5");
      expect(sub1.modelTimeline).toBeUndefined(); // 单发 Sub 无变更

      const sub2 = r.instances[2]!;
      expect(sub2.status).toBe("killed");
      expect(typeof sub2.endedAt).toBe("string");
      expect(sub2.task).toBe("任务二");

      // eventCount 口径：全会话不过滤（与按实例过滤查询的 total 一致）
      const sub1All = await rig.client.traceQuery({ sessionId: rig.sessionId, instanceIds: ["agent-1"] });
      expect(sub1.eventCount).toBe(sub1All.page.total);
    } finally {
      await rig.client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("⑤ 重启回填（F5.8 / F5.7 锚 3）：恢复实例 model 非缺失 + instantiated/model.changed 可查", () => {
  test("spawn（带 model）+ model.set → shutdown → 重启同 home → 快照 instances[] model 非缺失；trace.query 读回快照与模型时间线", async () => {
    const home = tmpHome();
    const rig1 = await makeRig(home, { replies: [{ text: "重启前回复。" }] });
    const sid = rig1.sessionId;
    try {
      await seedMixedSession(rig1);
      await rig1.client.close();
      await rig1.daemon.shutdown(); // 优雅退出：drain 单写队列

      // 重启（同 --home；引擎初始模型不同——证明恢复 model 来自落盘快照而非现值）
      const rig2 = await makeRig(home, { initialModel: "anthropic/claude-haiku-4-5" });
      try {
        expect(rig2.sessionId).toBe(sid); // 最近活动会话热加载为当前
        // ① 恢复实例 model 字段非缺失（spawnModels 回填 → 快照 instances[] 透出）
        const view = rig2.daemon.registry.currentView();
        const restored = view.instances!.find((i) => i.instanceId === "agent-1");
        expect(restored).toBeDefined();
        expect(restored!.model).toBe("anthropic/claude-sonnet-4-5"); // spawn 时刻快照，非重启后引擎现值

        // ② 重启前实例的 instantiated / model.changed 经 trace.query 可读
        const inst = await rig2.client.traceQuery({ sessionId: sid, types: ["agent.instantiated", "agent.model.changed"] });
        const types = inst.events.map((e) => `${e.instanceId}:${e.type}`).sort();
        expect(types).toEqual([
          "agent-1:agent.instantiated",
          "agent-2:agent.instantiated",
          "main:agent.instantiated",
          "main:agent.model.changed",
        ]);
        // ③ 面板重启后可读历史快照与模型时间线
        const main = inst.instances.find((i) => i.instanceId === "main")!;
        expect(main.snapshotMissing).toBe(false);
        expect((main.snapshot as { systemPrompt: string }).systemPrompt.startsWith(MAIN_SESSION_SYSTEM_PROMPT)).toBe(true); // M6 T3：组装快照 = base 前缀 + 动态段
        expect((main.modelTimeline as { from: string; to: string }[]).map((c) => [c.from, c.to])).toEqual([
          ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
        ]);
        const sub1 = inst.instances.find((i) => i.instanceId === "agent-1")!;
        expect((sub1.snapshot as { model: string }).model).toBe("anthropic/claude-sonnet-4-5");
      } finally {
        await rig2.client.close();
        await rig2.daemon.shutdown();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
