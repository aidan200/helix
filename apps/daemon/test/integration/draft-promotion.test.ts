import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Daemon } from "../../src/infrastructure/container";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * T4 集成：daemon 内存草稿「不可见 + 转正」全链（真组合根 × 真 SQLite × loopback WS）。
 *
 * ① 不可见两面：清单（session.list 不含零条目热草稿）+ domain_events
 *    （createFresh 不再写 agent.instantiated——trace 查询面无幻影）；
 * ② draft 链转正：零条目当前会话 + chat.send{draft:true} → 复用同 id
 *    （不裂变）；created 恰好一次且同步先于快照；instantiated 恰好一次；
 * ③ v0 兼容路由转正：chat.send 无 sessionId → 零条目当前会话获首个用户
 *    条目 → 恰好一次 instantiated（同 id 转正）；
 * ④ 握手 draft 标记：零条目当前会话 → welcome.draft===true 且不 attach
 *    不推快照；真实会话 → 现状回归（draft 缺省 + 立即快照）；
 * ⑤ chat.send draft + model：新会话模型 = 指定模型（首条消息前生效）；
 *    缺省 → 全局默认（回归）。
 */

interface Rig {
  home: string;
  daemon: Daemon;
  engines: Map<string, FakeAgentEngine>;
  engineOf(sessionId: string): FakeAgentEngine;
  token: string;
  dispose: () => Promise<void>;
}

async function makeRig(opts: { initialModel?: string } = {}): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t4-draft-"));
  const engines = new Map<string, FakeAgentEngine>();
  const daemon = await createTestDaemon({
    home,
    engine: (sessionId) => {
      const engine = new FakeAgentEngine({ initialModel: opts.initialModel });
      engines.set(sessionId, engine);
      return engine;
    },
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  const token = (await (await fetch(`http://127.0.0.1:${daemon.ws.port}/helix-dev-token`)).text()).trim();
  return {
    home,
    daemon,
    engines,
    engineOf(sessionId: string): FakeAgentEngine {
      const engine = engines.get(sessionId);
      if (engine === undefined) throw new Error(`会话 ${sessionId} 的引擎未创建`);
      return engine;
    },
    token,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 直读同 home 的 SQLite（domain_events 断言；WAL 并发读安全）。 */
function openRepo(home: string): SqliteSessionRepository {
  return new SqliteSessionRepository(new WriteQueue(path.join(home, "helix.db")));
}

/** 某会话的 agent.instantiated 事件行数（恰好一次判据）。 */
function instantiatedCount(home: string, sessionId: string): number {
  return openRepo(home)
    .queryEvents({ sessionId })
    .filter((e) => e.type === "agent.instantiated").length;
}

async function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

// ── ① 不可见两面 ─────────────────────────────────────────────

describe("T4 ① 内存草稿不可见：清单 + domain_events 两面零泄漏", () => {
  test("空库启动：内存草稿恒有但 session.list 为空、domain_events 无 instantiated 幻影", async () => {
    const rig = await makeRig();
    try {
      const draftId = rig.daemon.registry.currentSessionId();
      expect(rig.daemon.registry.peek(draftId)).toBeDefined(); // 恒有会话不变（热草稿客观存在）

      // 面一：清单不含零条目热草稿（bug1 幻影封堵）
      expect(await rig.daemon.directory.listSessions()).toEqual([]);

      // 面二：domain_events 零行（createFresh 不再写 agent.instantiated——trace 查询面无幻影）
      await new Promise((r) => setTimeout(r, 100)); // 落盘屏障（防御：旧实现此处有 instantiated 行）
      expect(openRepo(rig.home).queryEvents({ sessionId: draftId })).toEqual([]);
    } finally {
      await rig.dispose();
    }
  }, 10000);
});

// ── ② draft 链转正（WS 全链） ────────────────────────────────

describe("T4 ② chat.send{draft:true} 复用当前零条目草稿：同 id 转正 + created/instantiated 恰好一次", () => {
  test("握手 draft → draft 建会话同 id；created 恰好一次且先于快照；instantiated 恰好一次；清单可见", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.daemon.ws.url, rig.token);
    try {
      const welcome = await client.expect("connection.welcome");
      const draftId = welcome.payload.sessionId as string;
      expect(draftId).toBe(rig.daemon.registry.currentSessionId());

      // 首条消息（draft 链）：复用当前内存草稿（同 id，不裂变新会话）
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", payload: { draft: true, text: "草稿转正首条消息" } });
      const snap = await client.expect("session.snapshot");
      expect(snap.sessionId).toBe(draftId); // 同 id 转正
      expect(rig.daemon.registry.currentSessionId()).toBe(draftId); // current 停留
      expect(rig.engines.size).toBe(1); // 零裂变（没有为下一个草稿提前建运行时）

      // created 恰好一次（显式即知广播 + 转正补广播去重）且同步先于快照
      const created = client.frames.filter(
        (f) => f.type === "session.list_changed" && f.payload.kind === "created" && f.payload.sessionId === draftId,
      );
      expect(created).toHaveLength(1);
      const typeSeq = client.frames.map((f) => f.type);
      expect(typeSeq.indexOf("session.list_changed")).toBeLessThan(typeSeq.indexOf("session.snapshot"));

      // 首轮完成 → instantiated 恰好一次（转正单点）+ 落库 + 清单可见
      await until(() => rig.engineOf(draftId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");
      await until(() => instantiatedCount(rig.home, draftId) === 1, 3000, "instantiated 恰好一次落盘");
      expect(instantiatedCount(rig.home, draftId)).toBe(1);
      const list = await rig.daemon.directory.listSessions();
      expect(list.map((s) => s.sessionId)).toEqual([draftId]);
      expect(list[0]!.title).toBe("草稿转正首条消息");
      await client.close();
    } finally {
      await rig.dispose();
    }
  }, 15000);
});

// ── ③ v0 兼容路由转正 ────────────────────────────────────────

describe("T4 ③ v0 路由：chat.send 无 sessionId → 零条目当前会话转正（恰好一次 instantiated）", () => {
  test("daemon.chat.sendMessage（无 sessionId）→ 当前草稿同 id 转正；instantiated ×1；二次发送不重发", async () => {
    const rig = await makeRig();
    try {
      const draftId = rig.daemon.registry.currentSessionId();
      expect(instantiatedCount(rig.home, draftId)).toBe(0); // 首条消息前零 instantiated

      await rig.daemon.chat.sendMessage("v0 首条消息"); // 无 sessionId → 路由当前草稿
      await until(() => rig.engineOf(draftId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");
      expect(rig.daemon.registry.currentSessionId()).toBe(draftId); // 同 id 转正（恒有会话不变）
      await until(() => instantiatedCount(rig.home, draftId) === 1, 3000, "instantiated 落盘");
      expect(instantiatedCount(rig.home, draftId)).toBe(1);

      // 第二条消息：不再重发 instantiated（恰好一次）
      await rig.daemon.chat.sendMessage("v0 第二条消息");
      await until(() => rig.engineOf(draftId).events.filter((e) => e.type === "agent_end").length === 2, 5000, "次轮完成");
      await new Promise((r) => setTimeout(r, 100)); // 落盘屏障
      expect(instantiatedCount(rig.home, draftId)).toBe(1);
    } finally {
      await rig.dispose();
    }
  }, 15000);
});

// ── ④ 握手 draft 标记 ────────────────────────────────────────

describe("T4 ④ 握手 draft 标记：零条目当前会话 → welcome.draft + 不 attach 不推快照；真实会话回归", () => {
  test("空库启动握手：welcome.draft===true；窗口内无 session.snapshot；draft 链仍可建会话（连接已注册）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.daemon.ws.url, rig.token);
    try {
      const welcome = await client.expect("connection.welcome");
      expect(welcome.payload.draft).toBe(true); // 草稿标记

      // 不推快照（不 attach 当前草稿会话）：观察窗内零 session.snapshot
      await new Promise((r) => setTimeout(r, 300));
      expect(client.frames.some((f) => f.type === "session.snapshot")).toBe(false);

      // 连接已注册（attach 无会话绑定）：draft 链建会话后照常订阅 + 推快照
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", payload: { draft: true, text: "握手后建会话" } });
      const snap = await client.expect("session.snapshot");
      expect(snap.sessionId).toBe(welcome.payload.sessionId as string); // 复用同 id
      await client.close();
    } finally {
      await rig.dispose();
    }
  }, 10000);

  test("真实会话握手回归：welcome.draft 缺省 + 立即推快照（现状不变）", async () => {
    const rig = await makeRig();
    try {
      // 先建真实会话（有内容、已落库）作为当前会话
      const { sessionId } = await rig.daemon.directory.startDraftSession("真实会话首条消息");
      await until(() => rig.engineOf(sessionId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");

      const client = new TestClient(rig.daemon.ws.url, rig.token);
      const welcome = await client.expect("connection.welcome");
      expect(welcome.payload.sessionId).toBe(sessionId);
      expect(welcome.payload.draft).toBeUndefined(); // 旧客户端兼容：可选字段缺省
      const snap = await client.expect("session.snapshot"); // 握手即推快照（现状）
      expect(snap.sessionId).toBe(sessionId);
      await client.close();
    } finally {
      await rig.dispose();
    }
  }, 15000);
});

// ── ⑤ chat.send draft + model ────────────────────────────────

describe("T4 ⑤ chat.send draft + model：首条消息前生效；缺省 = 全局默认", () => {
  test("model 指定 → 新会话模型为指定模型；缺省 → 引擎初始（全局默认链）不換", async () => {
    const rig = await makeRig({ initialModel: "test/default-model" });
    const client = new TestClient(rig.daemon.ws.url, rig.token);
    try {
      await client.expect("connection.welcome");
      // 指定模型：建会话/复用后、sendMessage 前 setModel
      client.send({
        v: PROTOCOL_VERSION,
        type: "chat.send",
        payload: { draft: true, text: "指定模型建会话", model: "test/picked-model" },
      });
      const snap = await client.expect("session.snapshot");
      const sid = snap.sessionId!;
      await until(() => rig.engineOf(sid).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");
      expect(rig.engineOf(sid).currentModel()).toBe("test/picked-model"); // 会话模型 = 指定
      const view = await rig.daemon.directory.getSessionView(sid);
      expect(view.model).toBe("test/picked-model"); // 快照读面同源

      // 缺省回归：第二个 draft 不带 model → 不换模（引擎初始值 = 全局默认链产物）
      const baseline = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", payload: { draft: true, text: "缺省模型建会话" } });
      await until(
        () => client.frames.slice(baseline).some((f) => f.type === "session.snapshot" && f.sessionId !== sid),
        5000,
        "次会话快照",
      );
      const snap2 = client.frames.slice(baseline).find((f) => f.type === "session.snapshot" && f.sessionId !== sid)!;
      const sid2 = snap2.sessionId!;
      expect(sid2).not.toBe(sid);
      await until(() => rig.engineOf(sid2).events.some((e) => e.type === "agent_end"), 5000, "次会话首轮完成");
      expect(rig.engineOf(sid2).currentModel()).toBe("test/default-model");
      await client.close();
    } finally {
      await rig.dispose();
    }
  }, 15000);
});

// ── ⑥ T4b：draft 链 setModel 同模型短路 + instantiated 次序 ────────────

describe("T4b ⑥ draft 链模型事件：同模型零 model.changed；异模型 instantiated 先于 model.changed", () => {
  test("model === 引擎当前模型 → domain_events 零 model.changed；会话首事件（id 升序）= agent.instantiated", async () => {
    const rig = await makeRig({ initialModel: "test/default-model" });
    try {
      const draftId = rig.daemon.registry.currentSessionId();
      await rig.daemon.directory.startDraftSession("同模型首条消息", "test/default-model");
      await until(() => rig.engineOf(draftId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");
      await until(
        () => openRepo(rig.home).queryEvents({ sessionId: draftId }).some((e) => e.type === "agent.instantiated"),
        3000,
        "instantiated 落盘",
      );
      await new Promise((r) => setTimeout(r, 100)); // 落盘屏障
      const events = openRepo(rig.home).queryEvents({ sessionId: draftId });
      // 同模型短路：零 agent.model.changed（修复「已切换 2 次」回归根因）
      expect(events.filter((e) => e.type === "agent.model.changed")).toEqual([]);
      // 会话首事件（id 升序首行）= agent.instantiated（修复分页末行断言回归）
      expect(events[0]!.type).toBe("agent.instantiated");
      expect(rig.engineOf(draftId).currentModel()).toBe("test/default-model"); // 模型不变
    } finally {
      await rig.dispose();
    }
  }, 15000);

  test("model ≠ 引擎当前模型 → 事件次序 instantiated → model.changed（恰好一条）；首条消息用选定模型", async () => {
    const rig = await makeRig({ initialModel: "test/default-model" });
    try {
      const draftId = rig.daemon.registry.currentSessionId();
      await rig.daemon.directory.startDraftSession("异模型首条消息", "test/picked-model");
      await until(() => rig.engineOf(draftId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");
      await until(
        () => openRepo(rig.home).queryEvents({ sessionId: draftId }).some((e) => e.type === "agent.model.changed"),
        3000,
        "model.changed 落盘",
      );
      await new Promise((r) => setTimeout(r, 100)); // 落盘屏障
      const events = openRepo(rig.home).queryEvents({ sessionId: draftId });
      const types = events.map((e) => e.type);
      // 事件次序硬约束：instantiated 先于 model.changed（先转正再换模）
      expect(types[0]).toBe("agent.instantiated");
      const modelChanged = events.filter((e) => e.type === "agent.model.changed");
      expect(modelChanged).toHaveLength(1); // 恰好一条
      expect(types.indexOf("agent.instantiated")).toBeLessThan(types.indexOf("agent.model.changed"));
      expect(modelChanged[0]!.payload).toMatchObject({ from: "test/default-model", to: "test/picked-model" });
      // 首条消息用选定模型（setModel 先于 sendMessage 不变）
      expect(rig.engineOf(draftId).currentModel()).toBe("test/picked-model");
    } finally {
      await rig.dispose();
    }
  }, 15000);
});
