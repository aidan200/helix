import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgReviewService } from "../../src/application/services/kg/KgReviewService";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";
import { scanProjectEntries } from "../../src/adapters/driven/workspace-scan";
import { FakeOrchestratorStarter, FakeTaskSkillRegistry, counterClock, kgReviewManifest } from "../helpers/task-fixtures";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * kg.review.create 发起链路 I 层（W2-F 轨二语义体检任务，R21/R23；契约
 * PROTOCOL.md §23）：真 KgReviewService × 真 kg 库（tmp per-project）×
 * 真任务栈（TaskEngineService/TaskStore @ tmp helix.db，fake skill 注册表
 * kg-review manifest）× loopback WS 路由。kg-bootstrap-handlers.test.ts 同构。
 *
 * 覆盖：合法链（job 创建 type/params/projects/createdBy + fixed 三阶段行 +
 * **终态后可再发**——知识层非空恰是评审对象，与 bootstrap 一次性语义不同；
 * P0① 仅禁并发：非终态 kg-review job 存在 → 拒绝 task_running）；准入（absent
 * → kg.review.not_eligible 带 index_absent）；project 无法解析
 * KG_E_PARAM；unimplemented 门控。
 */

const ITER = "iter-20260830-w2f";

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async kg(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; result: Record<string, unknown>; error: { code: string; message: string } | null }> {
    const at = this.frames.length;
    this.send({ v: PROTOCOL_VERSION, type, payload });
    await until(
      () => this.frames.slice(at).some((f) => f.type === `${type}.result` || f.type === "connection.error"),
      timeoutMs,
      `等待 ${type}.result / connection.error`,
    );
    const err = this.frames.slice(at).find((f) => f.type === "connection.error");
    if (err !== undefined) {
      return { ok: false, result: {}, error: err.payload as { code: string; message: string } };
    }
    const res = this.frames.slice(at).find((f) => f.type === `${type}.result`)!;
    return { ok: true, result: res.payload, error: null };
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

// ── rig ───────────────────────────────────────────────────

interface Rig {
  readonly workspace: string;
  readonly alpha: string; // 索引存在 + 知识层非空（合法位 + 反复发起位）
  readonly delta: string; // 永远 absent（index_absent 位）
  readonly taskStore: TaskStore;
  readonly client: TestClient;
  dispose(): Promise<void>;
}

/** adapter 依赖面 stub（kg-bootstrap-handlers 同构：kg 面外全部 no-op）。 */
function stubAdapterDeps(events: EventStream) {
  return {
    chat: {
      sendMessage: async () => ({ mode: "turn" as const, turnId: "t", entryId: "e" }),
      steer: async () => ({ entryId: "e" }),
      abort: () => {},
    },
    directory: {
      listSessions: async () => [],
      sessionExists: async () => false,
      resolveTarget: async () => "s",
      getSessionView: async () => ({
        session: { sessionId: "s", createdAt: "2026-08-30T00:00:00.000Z", entries: [], turns: [], pendingSteer: [] },
        toolCalls: [],
      }),
      startDraftSession: async () => {
        throw new Error("kg-review 测试不装配草稿链");
      },
      deleteSession: async () => {},
      currentSessionId: () => "s",
    },
    system: {
      getStatus: () => ({
        running: true, locked: false, home: "/tmp/kgreview-it", sessionId: "s",
        agentState: "idle", model: "stub/model",
      }),
      shutdown: async () => {},
    },
    orchestration: {
      spawn: () => ({ status: "rejected" as const, error: "kg-review 测试不装配调度" }),
      send: () => ({ delivered: false, detail: "stub" }),
      status: () => [],
      kill: () => ({ killed: false, error: "stub" }),
      inspect: () => null,
      park: () => ({ parked: false as const, error: "测试桩不挂起" }),
      resume: () => ({ resumed: false as const, error: "测试桩不恢复" }),
    },
    model: {
      setModel: async () => { throw new Error("stub"); },
      setThinking: async () => { throw new Error("stub"); },
      getModel: async () => { throw new Error("stub"); },
      catalog: async () => { throw new Error("stub"); },
      catalogRefresh: async () => { throw new Error("stub"); },
      setThinkingDefault: async () => ({ previous: null }), setDefault: async () => { throw new Error("stub"); },
      getDefault: () => ({ model: "stub/model", thinkingDefault: null }),
      authList: async () => [],
      authSetKey: async () => { throw new Error("stub"); },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail" as const, reason: "stub" }),
    },
    resource: {
      list: async () => { throw new Error("stub"); },
      setEnabled: async () => { throw new Error("stub"); },
      setModelSlot: async () => { throw new Error("stub"); },
      clearModelSlot: async () => { throw new Error("stub"); },
      setThinkingSlot: async () => { throw new Error("stub"); },
      modelSlot: () => undefined, thinkingSlot: () => undefined, clearThinkingSlot: async () => { throw new Error("stub"); },
    },
    hasModel: () => false,
      kgWriterPinnedTools: ["kg-update"],
    browser: new StubBrowserPort(),
    events,
    token: "kgreview-it-token",
    port: 0,
  };
}

function makeRig(): Rig {
  const workspace = mkdtempSync(path.join(tmpdir(), "helix-kgreview-ws-"));
  const mk = (name: string): string => {
    const dir = path.join(workspace, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const alpha = mk("alpha");
  const delta = mk("delta");

  // kg 栈（真 sqlite）：alpha 落一节点——知识层非空 + 索引存在（kg.db 落盘）
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const seeded = write.write(alpha, {
    kind: "createNode",
    iterationId: ITER,
    draft: { kind: "rule", name: "评审对象规则", digest: "d", scene: "测试场景", status: "confirmed" },
  });
  if (!seeded.ok) throw new Error(`种子写失败：${seeded.error.code}`);
  const project = new KgProjectService({
    workspaceRoot: workspace,
    scan: () => scanProjectEntries(workspace),
    hasIndex: (root) => existsSync(kgDbPath(root)),
    indexStatus: () => ({ phase: "synced", baseline: "b", symbolCount: 0, syncedAt: null, degraded: false }),
    countActiveNodes: (root) => graph.countActiveNodes(root),
  });

  // 任务栈（真 SQLite @ tmp helix.db；fake skill 注册表收 kg-review）
  const taskDir = mkdtempSync(path.join(tmpdir(), "helix-kgreview-task-"));
  const queue = new WriteQueue(path.join(taskDir, "helix.db"));
  const taskStore = new TaskStore(queue);
  const workLedger = parentWorkLedger(queue);
  const starter = new FakeOrchestratorStarter();
  const skills = new FakeTaskSkillRegistry();
  skills.register(
    "kg-review",
    kgReviewManifest(),
    "对项目知识图谱做语义体检（L0 结构面预检 → L1 规则册逐节点评审 → L2 实体册逐节点评审）",
  );
  const taskEngine = new TaskEngineService({ store: taskStore, skills, starter, workLedger, clock: counterClock() });

  const review = new KgReviewService({ project, taskEngine, store: taskStore });

  const events = new EventStream();
  const adapter = new WsServerAdapter({ ...stubAdapterDeps(events), kgReview: review });
  const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
  const dispose = async (): Promise<void> => {
    database.closeAll();
    adapter.stop();
    await queue.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(taskDir, { recursive: true, force: true });
  };
  return { workspace, alpha, delta, taskStore, client, dispose };
}

const rigs: Rig[] = [];

async function openRig(): Promise<Rig> {
  const rig = makeRig();
  rigs.push(rig);
  await rig.client.open();
  rig.client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kgreview-it-token", protocolVersion: PROTOCOL_VERSION } });
  await until(() => rig.client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  return rig;
}

afterAll(() => {
  for (const r of rigs) void r.dispose();
  rigs.length = 0;
});

// ── 测试 ─────────────────────────────────────────────────

describe("kg.review.create 发起链路（W2-F 轨二，R21）", () => {
  test("合法链：job 创建（type/params/projects/createdBy）+ fixed 三阶段行；并发禁入 task_running、终态后可再发（P0①）", async () => {
    const rig = await openRig();

    const res = await rig.client.kg("kg.review.create", { project: "alpha" });
    expect(res.ok).toBe(true);
    expect(res.result.ok).toBe(true);
    const jobId = res.result.jobId as string;
    expect(typeof jobId).toBe("string");

    // 真库查证：job 行四要素（与 kg.bootstrap.create / chat task_create 同源）
    const job = rig.taskStore.getJob(jobId)!;
    expect(job.type).toBe("kg-review");
    expect(job.params).toEqual({ projectRoot: rig.alpha });
    expect(job.projects).toEqual(["alpha"]);
    expect(job.createdBy).toBe("page");
    // fixed 三阶段行由 manifest 生成（L0 结构面预检 / L1 规则册逐节点评审 / L2 实体册逐节点评审）
    expect(rig.taskStore.getStages(jobId).map((s) => s.name)).toEqual([
      "L0 结构面预检",
      "L1 规则册逐节点评审",
      "L2 实体册逐节点评审",
    ]);

    // 并发禁入（P0① 仅禁并发，不绑一次性）：首个 job 非终态（pending）→
    // 再发拒绝 kg.review.not_eligible（message 带 task_running），不产新 job 行
    const concurrent = await rig.client.kg("kg.review.create", { project: "alpha" });
    expect(concurrent.ok).toBe(false);
    expect(concurrent.error!.code).toBe("kg.review.not_eligible");
    expect(concurrent.error!.message).toContain("task_running");
    expect(rig.taskStore.listJobs()).toHaveLength(1);

    // 终态后可再发（保留反复发起语义：知识层非空恰是评审对象——alpha 已有
    // 节点照样过检；终态后新发起各得一个新 job）
    await rig.taskStore.updateJobStatus(jobId, "running");
    await rig.taskStore.updateJobStatus(jobId, "done");
    const again = await rig.client.kg("kg.review.create", { project: "alpha" });
    expect(again.ok).toBe(true);
    expect(again.result.jobId).not.toBe(jobId);
  }, 15000);

  test("准入：absent 项目 → kg.review.not_eligible（message 带 index_absent）", async () => {
    const rig = await openRig();
    const res = await rig.client.kg("kg.review.create", { project: "delta" });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("kg.review.not_eligible");
    expect(res.error!.message).toContain("index_absent");
    // 拒绝不产 job 行
    expect(rig.taskStore.listJobs()).toEqual([]);
  }, 15000);

  test("project 无法解析 → KG_E_PARAM；project 缺失 → KG_E_PARAM", async () => {
    const rig = await openRig();
    const bad = await rig.client.kg("kg.review.create", { project: "no-such-project" });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("KG_E_PARAM");
    const missing = await rig.client.kg("kg.review.create", {});
    expect(missing.error!.code).toBe("KG_E_PARAM");
  }, 15000);

  test("unimplemented 门控：kg 栈未装配 kg.review.create 回 command.unimplemented（不崩溃）", async () => {
    const events = new EventStream();
    const adapter = new WsServerAdapter({ ...stubAdapterDeps(events) }); // 无 kg 面
    const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kgreview-it-token", protocolVersion: PROTOCOL_VERSION } });
      await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
      const res = await client.kg("kg.review.create", { project: "x" });
      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("command.unimplemented");
    } finally {
      adapter.stop();
      await client.close();
    }
  }, 15000);
});
