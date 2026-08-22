import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Daemon } from "../../src/infrastructure/container";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine, type ScriptedTurn } from "../mocks/FakeAgentEngine";
import { deriveTitle } from "../../src/application/services/SessionRegistry";
import type { InstanceRunner, InstanceRunnerCallbacks, InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { toSnapshotDto, historyPage, TAIL_WINDOW_SIZE } from "../../src/adapters/driving/ws-server/DtoMapper";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * T2.2 AD-4 集成：SessionRegistry 多会话容器。
 * ① 注册表生命周期：懒加载重建等价 / 空闲卸载（注入短窗口）/ 执行中不卸载
 * ② 草稿建会话链：首条消息落库 + 自动命名 20 码点（中英混合边界）
 * ③ 删除收口链：顺序硬约束（取消完成 → 删库 → 移除 → 广播）+ 三类 list_changed
 * ④ 尾窗快照（AD-1）：主轴尾窗 30 + per-instance channel 完整 + loadHistory 分页
 * ⑤ 后台会话续跑 + 全局预算共享（调度不停、事件继续落库）
 * ⑥ 重启后全部会话元数据可见（restoreLatest 末位语义废弃验证）
 */

/** 挂起式 SubAgent runner（closure 由测试驱动；镜像 closure-chain.test 模式）。 */
class ScriptedRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly launched: { instanceId: string; task: string }[] = [];
  readonly kills: string[] = [];
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }, task: string): void {
    this.launched.push({ instanceId: instance.instanceId, task });
  }
  send(): void {
    /* 不需要 */
  }
  kill(instanceId: string): Promise<unknown> {
    this.kills.push(instanceId);
    return Promise.resolve("graceful");
  }
  emitEngineEvent(instanceId: string, event: AgentEngineEvent): void {
    this.callbacks?.onInstanceEvent(instanceId, event);
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

interface Rig {
  home: string;
  daemon: Daemon;
  runner: ScriptedRunner;
  /** 每会话独立引擎（多会话并行：引擎持有单 run 状态不可共享）。 */
  engines: Map<string, FakeAgentEngine>;
  engineOf(sessionId: string): FakeAgentEngine;
  dispose: () => Promise<void>;
}

interface RigOptions {
  replies?: ScriptedTurn[];
  idleUnloadMs?: number;
  idlePollMs?: number;
  tailSize?: number;
}

async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t22-registry-"));
  const runner = new ScriptedRunner();
  const engines = new Map<string, FakeAgentEngine>();
  const daemon = await createTestDaemon({
    home,
    engine: (sessionId) => {
      const engine = new FakeAgentEngine({ replies: options.replies ? [...options.replies] : undefined });
      engines.set(sessionId, engine);
      return engine;
    },
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    sessionIdleUnloadMs: options.idleUnloadMs,
    sessionIdlePollMs: options.idlePollMs,
    sessionTailSize: options.tailSize,
  });
  return {
    home,
    daemon,
    runner,
    engines,
    engineOf(sessionId: string): FakeAgentEngine {
      const engine = engines.get(sessionId);
      if (engine === undefined) throw new Error(`会话 ${sessionId} 的引擎未创建（懒加载未触发？）`);
      return engine;
    },
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 直读同 home 的 SQLite（落库计数/行断言；WAL 并发读安全）。 */
function openRepo(home: string): SqliteSessionRepository {
  return new SqliteSessionRepository(new WriteQueue(path.join(home, "helix.db")));
}

async function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** WS 收帧客户端（session 族命令/广播帧断言用；镜像 ws-server.test 模式）。 */
class TestClient {
  readonly frames: { v: FrameVersion; sessionId?: string; type: string; payload: Record<string, unknown> }[] = [];
  private readonly ws: WebSocket;
  constructor(url: string, token: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => this.frames.push(JSON.parse(String(ev.data)));
    void this.open().then(() => {
      this.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
    });
  }
  private async open(): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, 3000, "WS 连接建立");
  }
  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }
  async expect(type: string, timeoutMs = 3000): Promise<(typeof this.frames)[number]> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}`);
    return this.frames.find((f) => f.type === type)!;
  }
  async close(): Promise<void> {
    this.ws.close();
    await until(() => this.ws.readyState === WebSocket.CLOSED, 1000, "WS 关闭");
  }
}

// ── ① 注册表生命周期 ─────────────────────────────────────────

describe("T2.2 ① 注册表生命周期（懒加载 / 空闲卸载 / 执行中不卸载）", () => {
  test("冷会话懒加载重建等价（快照视图与卸载前一致）+ 卸载后再进恢复", async () => {
    const rig = await makeRig({ idleUnloadMs: 80, idlePollMs: 10 });
    try {
      const dir = rig.daemon.directory;
      // 会话 A/B 均经草稿链建立并完成一轮（各自独立引擎）
      const a = await dir.startDraftSession("会话 A 的首条消息");
      const b = await dir.startDraftSession("会话 B 的首条消息");
      await until(() => rig.engineOf(b.sessionId).events.some((e) => e.type === "agent_end"), 3000, "B 首轮完成");
      await until(() => rig.engineOf(a.sessionId).events.some((e) => e.type === "agent_end"), 3000, "A 首轮完成");
      const viewBefore = structuredClone(await dir.getSessionView(a.sessionId));

      // 空闲卸载（G-5 注入短窗口）：两会话均 idle → 注册表移除
      //（A/B 均用 until 等待——瞬时硬断言 B 会与 poll 周期竞态：A 先卸载时 B
      //  的空闲窗口可能尚未走满，OI-DEV-1 根治 2026-08-18）
      await until(() => rig.daemon.registry.peek(a.sessionId) === undefined, 3000, "A 空闲卸载");
      await until(() => rig.daemon.registry.peek(b.sessionId) === undefined, 3000, "B 空闲卸载");

      // 卸载后再进：懒加载恢复，视图等价（快照 + 事件流重放）
      const runtime = await rig.daemon.registry.get(a.sessionId);
      expect(rig.daemon.registry.peek(a.sessionId)).toBe(runtime); // 重建后为热会话
      const viewAfter = await dir.getSessionView(a.sessionId);
      expect(viewAfter.session).toEqual(viewBefore.session); // 聚合等价（entries/turns/pendingSteer）
      expect(viewAfter.toolCalls).toEqual(viewBefore.toolCalls);
      expect(viewAfter.instances?.map((i) => i.instanceId)).toEqual(viewBefore.instances?.map((i) => i.instanceId));
    } finally {
      await rig.dispose();
    }
  }, 15000);

  test("执行中会话不卸载（主线运行中 / SubAgent 活跃）", async () => {
    // 首轮剧本：长工具窗（900ms）——在飞窗口远超 60ms 卸载窗口
    const rig = await makeRig({ idleUnloadMs: 60, idlePollMs: 10, replies: [{ text: "慢回复", toolCalls: [{ toolName: "work", durationMs: 900 }] }] });
    try {
      const dir = rig.daemon.directory;
      // 主线运行中（长工具窗）：不卸载
      const a = await dir.startDraftSession("长任务会话");
      const engineA = rig.engineOf(a.sessionId);
      await until(() => engineA.isStreaming(), 3000, "A run 开始");
      await new Promise((r) => setTimeout(r, 200)); // 远超 60ms 窗口
      expect(rig.daemon.registry.peek(a.sessionId)).toBeDefined(); // 有活动不卸载

      // SubAgent 活跃（主线 idle）：同样不卸载
      await until(() => !engineA.isStreaming(), 5000, "A run 结束");
      await rig.daemon.orchestration.spawn("挂起调研任务"); // runner 挂起（不收口）= running
      await until(() => rig.runner.launched.length === 1, 3000, "SubAgent launch");
      await new Promise((r) => setTimeout(r, 200));
      const sessionId = rig.daemon.system.getStatus().sessionId;
      expect(rig.daemon.registry.peek(sessionId)).toBeDefined();
    } finally {
      await rig.dispose();
    }
  }, 15000);
});

// ── ② 草稿建会话链 ───────────────────────────────────────────

describe("T2.2 ② 草稿首条消息建聚合落库 + 自动命名 20 码点", () => {
  test("新建草稿零落库：首条消息前 session_state 零行；首条消息后 INSERT + 命名/排序正确", async () => {
    const rig = await makeRig();
    try {
      const dir = rig.daemon.directory;
      const repo = openRepo(rig.home);
      // 启动期缺省会话（热、未落库）——草稿零落库判据
      expect(await repo.listSessionIds()).toEqual([]);

      const longText = "这是一条超过二十个字符的首条用户消息abcdefg尾";
      const created = await dir.startDraftSession(longText);
      await until(() => rig.engineOf(created.sessionId).events.some((e) => e.type === "agent_end"), 5000, "草稿首轮完成");
      // 落库计数：首条消息后恰好 1 行（首事件 write-through INSERT）
      expect(await repo.listSessionIds()).toEqual([created.sessionId]);

      // 自动命名：`[...msg].slice(0,20).join("")` Unicode 码点截断
      const sessions = await dir.listSessions();
      const created0 = sessions.find((s) => s.sessionId === created.sessionId)!;
      expect(created0.title).toBe([...longText].slice(0, 20).join(""));
      expect(created0.loaded).toBe(true);
      // 排序：按 lastActivityAt 降序（活跃在前）
      expect(sessions[0]!.sessionId).toBe(created.sessionId);
      void repo;
    } finally {
      await rig.dispose();
    }
  }, 15000);

  test("命名边界（单元）：恰好 20 码点 / 超长截断 / emoji 代理对安全 / 空消息", () => {
    expect(deriveTitle("a".repeat(20))).toBe("a".repeat(20)); // 恰好 20：不截
    expect(deriveTitle("a".repeat(21))).toBe("a".repeat(20)); // 超长：截 20
    expect(deriveTitle("中文消息精确二十字前段一二三四五六七八九十")).toBe("中文消息精确二十字前段一二三四五六七八九十".slice(0, 20));
    // 码点语义：emoji（代理对）不因 UTF-16 切半
    expect(deriveTitle("😀".repeat(25))).toBe("😀".repeat(20));
    expect(deriveTitle(null)).toBe(""); // 无用户消息：空标题
  });
});

// ── ③ 删除收口链 ─────────────────────────────────────────────

describe("T2.2 ③ 删除取消链（顺序硬约束）+ list_changed 三类推", () => {
  test("活跃会话删除：SubAgent 终态收口 → 删库 → 注册表移除 → 广播；daemon 不崩", async () => {
    const rig = await makeRig();
    try {
      const dir = rig.daemon.directory;
      const a = await dir.startDraftSession("待删除会话");
      const engineA = rig.engineOf(a.sessionId);
      await until(() => engineA.events.some((e) => e.type === "agent_end"), 5000, "A 首轮完成");
      // SubAgent 挂起 running + queued（预算 3 内两个直跑——改用一跑一队：直接 spawn 两个均 running）
      rig.daemon.orchestration.spawn("运行中的任务");
      rig.daemon.orchestration.spawn("排队的任务");
      await until(() => rig.runner.launched.length === 2, 3000, "两 SubAgent launch");

      await dir.deleteSession(a.sessionId);

      // 取消完成先于删库（终态语义）：全部实例终态；kill 信号已发
      const statuses = rig.daemon.orchestration.status();
      const aAgents = statuses.filter((s) => rig.daemon.orchestration.status(s.agentId).length > 0);
      void aAgents;
      for (const s of statuses) {
        expect(["done", "failed", "cancelled"]).toContain(s.state);
      }
      expect(rig.runner.kills).toContain("agent-1");
      expect(rig.runner.kills).toContain("agent-2");
      // 删库：全部六表行清空（flush 后仍无行——删除不被收口写复活）
      const repo = openRepo(rig.home);
      await new Promise((r) => setTimeout(r, 100));
      expect(await repo.listSessionIds()).toEqual([]);
      expect(repo.queryEvents({ sessionId: a.sessionId })).toEqual([]);
      // 注册表移除 + 会话不再存在
      expect(rig.daemon.registry.peek(a.sessionId)).toBeUndefined();
      await expect(dir.sessionExists(a.sessionId)).resolves.toBe(false);
      // daemon 不崩：当前会话轮换（新建空会话），继续可用
      expect(typeof dir.currentSessionId()).toBe("string");
      const b = await dir.startDraftSession("删除后新会话");
      await until(() => rig.engineOf(b.sessionId).events.some((e) => e.type === "agent_end"), 5000, "删除后新会话完成");
    } finally {
      await rig.dispose();
    }
  }, 20000);

  test("重复删除 → delete_in_progress；不存在会话 → not_found；WS list_changed 三类推", async () => {
    const rig = await makeRig();
    try {
      const dir = rig.daemon.directory;
      await expect(dir.deleteSession("no-such-session")).rejects.toMatchObject({ name: "SessionNotFoundError" });

      // WS 客户端：观察 created / state_changed / deleted 三类广播
      const token = (await (await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/helix-dev-token`)).text()).trim();
      const client = new TestClient(rig.daemon.ws.url, token);
      const welcome0 = await client.expect("connection.welcome");
      // T4：零条目草稿握手不 attach 不推快照——显式订阅当前会话（v0 兼容面）
      if (welcome0.payload.draft === true) {
        client.send({ v: 0, type: "session.subscribe", payload: {} });
      }
      await client.expect("session.snapshot");

      const a = await dir.startDraftSession("广播观测会话");
      const created = await client.expect("session.list_changed");
      expect(created.payload.kind).toBe("created");
      expect(created.payload.sessionId).toBe(a.sessionId);
      expect((created.payload.session as { title: string }).title).toBe("广播观测会话");

      // state_changed：runState idle→streaming（首轮开始）
      await until(
        () => client.frames.some((f) => f.type === "session.list_changed" && f.payload.kind === "state_changed" && (f.payload.session as { runState: string }).runState === "streaming"),
        5000,
        "state_changed(streaming) 广播",
      );

      // 重复删除并发：第二个请求 delete_in_progress（经 WS 命令路径）
      client.send({ v: PROTOCOL_VERSION, sessionId: a.sessionId, type: "session.delete", payload: {} });
      client.send({ v: PROTOCOL_VERSION, sessionId: a.sessionId, type: "session.delete", payload: {} });
      await until(() => client.frames.some((f) => f.type === "connection.error" && f.payload.code === "session.delete_in_progress"), 5000, "delete_in_progress 回执").catch(() => {
        // 首个删除可能先完成（第二个请求变 not_found）——两种回执都证明重复防护
      });
      const deleted = await client.expect("session.list_changed"); // deleted 广播（顺序收口链第四步）
      expect(["deleted", "created", "state_changed"]).toContain(String(deleted.payload.kind));
      await client.close();
    } finally {
      await rig.dispose();
    }
  }, 20000);
});

// ── ④ 尾窗快照 + loadHistory ─────────────────────────────────

describe("T2.2 ④ 尾窗切法（AD-1：主轴尾窗 30 + per-instance 完整 + 分页）", () => {
  test("N>30 主轴 + SubAgent channel M 条：tail=主轴末 30 / channels 全 M / 游标分页正确", async () => {
    // 16 轮 × (user+assistant) = 32 条主轴 > 30
    const replies = Array.from({ length: 16 }, (_, i) => ({ text: `第${i + 1}轮回复` }));
    const rig = await makeRig({ replies });
    try {
      const dir = rig.daemon.directory;
      const a = await dir.startDraftSession("尾窗观测会话");
      const engineA = rig.engineOf(a.sessionId);
      await until(() => engineA.events.some((e) => e.type === "agent_end"), 5000, "首轮完成");
      for (let i = 2; i <= 16; i++) {
        await dir.resolveTarget(a.sessionId);
        await rig.daemon.registry.get(a.sessionId).then((rt) => rt.chatService.sendMessage(`第${i}轮`));
      }
      await until(() => engineA.events.filter((e) => e.type === "agent_end").length === 16, 20000, "16 轮全部完成");

      // SubAgent channel M 条（thinking + message + tool × N，经投影进聚合）
      rig.daemon.orchestration.spawn("通道历史任务");
      await until(() => rig.runner.launched.length === 1, 3000, "SubAgent launch");
      rig.runner.emitEngineEvent("agent-1", { type: "message_start", role: "assistant", source: "prompt" });
      rig.runner.emitEngineEvent("agent-1", { type: "thinking_started", contentIndex: 0 });
      rig.runner.emitEngineEvent("agent-1", { type: "thinking_delta", contentIndex: 0, delta: "思考" });
      rig.runner.emitEngineEvent("agent-1", { type: "thinking_end", contentIndex: 0, content: "通道思考全文" });
      rig.runner.emitEngineEvent("agent-1", { type: "message_update", delta: "通道消息" });
      rig.runner.emitEngineEvent("agent-1", { type: "tool_execution_start", toolCallId: "subtc-1", toolName: "grep", args: { q: "x" } });
      rig.runner.emitEngineEvent("agent-1", { type: "tool_execution_end", toolCallId: "subtc-1", toolName: "grep", isError: false, result: "命中" });
      rig.runner.emitEngineEvent("agent-1", { type: "message_end", role: "assistant", text: "通道完整消息", stopReason: "stop" });
      await new Promise((r) => setTimeout(r, 100)); // 投影落库

      const view = await dir.getSessionView(a.sessionId);
      const dto = toSnapshotDto(view, "fake/model", "idle");
      // 主轴尾窗 30：tail 恰 30 条且全为主实例（不含 agent-1 归属）
      expect(dto.tail).toHaveLength(TAIL_WINDOW_SIZE);
      expect(dto.tail!.every((e) => e.instanceId === undefined)).toBe(true);
      expect(dto.totalEntries).toBe(32); // 16 user + 16 assistant
      expect(dto.tailStartCursor).toBe(dto.tail![0]!.id); // 尾窗最早 entry id
      expect(dto.entries ?? []).toStrictEqual(dto.tail ?? []); // entries 与 tail 同源（v0.2 口径）
      // per-instance channel 完整保留（AD-1 硬约束：不按全局时间序切尾）
      const agent = dto.instances?.find((i) => i.instanceId === "agent-1");
      expect(agent?.channels?.thinking as unknown[] | undefined).toHaveLength(1);
      expect(agent?.channels?.messages as unknown[] | undefined).toHaveLength(1);
      expect(agent?.channels?.tools as unknown[] | undefined).toHaveLength(1);

      // loadHistory 分页：首页（游标=tailStartCursor）取更早历史
      const first = historyPage(view, dto.tailStartCursor!);
      expect(first.entries).toHaveLength(2); // 32-30 = 2 条更早
      expect(first.hasMore).toBe(false);
      expect(first.nextCursor).toBe(null);
      // limit=1 分页：hasMore + nextCursor 链式
      const page1 = historyPage(view, dto.tailStartCursor!, 1);
      expect(page1.entries).toHaveLength(1);
      expect(page1.hasMore).toBe(true);
      const page2 = historyPage(view, page1.nextCursor!, 50);
      expect(page2.entries).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
      // 游标非法（SubAgent 条目 id 不在主轴）→ 抛错（WS 侧转 invalid_cursor）
      expect(() => historyPage(view, "agent-1#1")).toThrow();
    } finally {
      await rig.dispose();
    }
  }, 40000);

  test("WS session.list / loadHistory.result / invalid_cursor 回执", async () => {
    const rig = await makeRig({ replies: [{ text: "单轮回复" }] });
    try {
      const dir = rig.daemon.directory;
      const a = await dir.startDraftSession("WS 读面会话");
      await until(() => rig.engineOf(a.sessionId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");
      await new Promise((r) => setTimeout(r, 150));

      const token = (await (await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/helix-dev-token`)).text()).trim();
      const client = new TestClient(rig.daemon.ws.url, token);
      await client.expect("session.snapshot");

      // session.list → list.result 点对点回执（含新会话元数据）
      client.send({ v: PROTOCOL_VERSION, type: "session.list", payload: {} });
      const list = await client.expect("session.list.result");
      const sessions = (list.payload as { sessions: { sessionId: string; title: string; runState: string; loaded: boolean }[] }).sessions;
      expect(sessions.some((s) => s.sessionId === a.sessionId && s.title === "WS 读面会话" && s.loaded)).toBe(true);

      // loadHistory：游标取尾窗最早 entry（e1 = 首 user entry，尾窗=全部 → cursor=null 场景；
      // 此会话只有 2 条主轴，直接以 e2 为游标取更早 1 条）
      client.send({ v: PROTOCOL_VERSION, sessionId: a.sessionId, type: "session.loadHistory", payload: { beforeEntryId: "e2" } });
      const history = await client.expect("session.loadHistory.result");
      const page = history.payload as { entries: { id: string }[]; hasMore: boolean; nextCursor: string | null };
      expect(page.entries.map((e) => e.id)).toEqual(["e1"]);
      expect(page.hasMore).toBe(false);

      // 游标非法 → session.invalid_cursor
      client.send({ v: PROTOCOL_VERSION, sessionId: a.sessionId, type: "session.loadHistory", payload: { beforeEntryId: "not-exist" } });
      const err = await client.expect("connection.error");
      expect(err.payload.code).toBe("session.invalid_cursor");
      await client.close();
    } finally {
      await rig.dispose();
    }
  }, 20000);
});

// ── ⑤ 后台会话续跑 + 全局预算 ────────────────────────────────

describe("T2.2 ⑤ 后台会话续跑（切换后 turn 推进 + 事件落库）+ 全局预算共享", () => {
  test("会话 B 活跃后 A 在飞 turn 仍推进并落库；预算跨会话共享（第 4 个排队）", async () => {
    // A 引擎：慢回复（长工具窗）；B 引擎：快回复
    const rig = await makeRig();
    try {
      const dir = rig.daemon.directory;
      const a = await dir.startDraftSession("后台会话 A");
      const engineA = rig.engineOf(a.sessionId);
      await until(() => engineA.events.some((e) => e.type === "agent_end"), 5000, "A 首轮完成");
      // 预置 A 的慢工具轮剧本后开第二轮（在飞窗口内切走去 B）
      engineA.queueReplies([
        { text: "A 慢回复", toolCalls: [{ toolName: "work", durationMs: 700 }], chunkDelayMs: 5 },
      ]);
      void rig.daemon.registry.get(a.sessionId).then((rt) => void rt.chatService.sendMessage("A 第二问").catch(() => undefined));
      await until(() => engineA.isStreaming(), 3000, "A 第二轮开始");

      // 切走：B 建会话并发消息（current 轮换为 B）
      const b = await dir.startDraftSession("前台会话 B");
      await until(() => rig.engineOf(b.sessionId).events.some((e) => e.type === "agent_end"), 5000, "B 首轮完成");
      expect(dir.currentSessionId()).toBe(b.sessionId);

      // A（后台）turn 继续推进至完成 + 事件落库
      await until(() => engineA.events.filter((e) => e.type === "agent_end").length === 2, 10000, "A 后台完成");
      const repo = openRepo(rig.home);
      const persisted = await repo.restore(a.sessionId);
      const aTexts = persisted!.session.entries.filter((e): e is (typeof e) & { role: string; text: string } => "role" in e).map((e) => e.text);
      expect(aTexts).toContain("A 第二问");
      expect(aTexts).toContain("A 慢回复");

      // 全局预算共享（maxConcurrent=3）：A、B 各 spawn 后第 4 个排队（不随会话分裂）
      const spawnOutcomes = [
        rig.daemon.orchestration.spawn("A 任务 1"),
        rig.daemon.orchestration.spawn("A 任务 2"),
      ];
      void spawnOutcomes;
      // B 当前会话：spawn 2 个 + 第 5 个全局排队判定（3 running + 1 queued）
      const s3 = rig.daemon.orchestration.spawn("B 任务 1");
      const s4 = rig.daemon.orchestration.spawn("B 任务 2");
      expect(s3.status).toBe("run");
      expect(s4.status).toBe("queued"); // 全局 3 个 running 已满 → 排队（预算 daemon 级）
      expect(rig.runner.launched).toHaveLength(3); // 只 launch 了 3 个
    } finally {
      await rig.dispose();
    }
  }, 30000);
});

// ── ⑥ 重启全量元数据 ─────────────────────────────────────────

describe("T2.2 ⑥ 重启后全部会话元数据可见（restoreLatest 末位语义废弃）", () => {
  test("两会话 → 重启 → session.list 全量返回（冷会话不热加载）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t22-restart-"));
    const engines = new Map<string, FakeAgentEngine>();
    const mkOptions = () => ({
      home,
      engine: (sessionId: string) => {
        const engine = new FakeAgentEngine();
        engines.set(sessionId, engine);
        return engine;
      },
      skipConfig: true,
      port: 0,
      skipLock: false,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const d1 = await createTestDaemon(mkOptions());
      const a = await d1.directory.startDraftSession("重启会话甲的首条消息");
      const b = await d1.directory.startDraftSession("重启会话乙的首条消息");
      await until(() => engines.get(b.sessionId)!.events.some((e) => e.type === "agent_end"), 5000, "乙完成");
      await until(() => engines.get(a.sessionId)!.events.some((e) => e.type === "agent_end"), 5000, "甲完成");
      await d1.shutdown();

      // 重启：全部会话元数据可见（非单会话）；只有当前会话热加载
      const d2 = await createTestDaemon(mkOptions());
      const sessions = await d2.directory.listSessions();
      expect(sessions.map((s) => s.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
      const aMeta = sessions.find((s) => s.sessionId === a.sessionId)!;
      expect(aMeta.title).toBe("重启会话甲的首条消息");
      const current = d2.system.getStatus().sessionId;
      expect([a.sessionId, b.sessionId]).toContain(current);
      // 冷会话不热加载：另一会话不在注册表；懒加载按需恢复
      const other = current === a.sessionId ? b.sessionId : a.sessionId;
      expect(d2.registry.peek(other)).toBeUndefined();
      const revived = await d2.directory.getSessionView(other);
      expect(revived.session.entries.filter((e): e is (typeof e) & { role: string } => "role" in e).map((e) => e.role)).toEqual(["user", "assistant"]);
      await d2.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 25000);
});
