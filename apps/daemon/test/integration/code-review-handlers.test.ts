import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import { KgViewerService } from "../../src/application/services/kg/KgViewerService";
import { hasActiveJob } from "../../src/application/services/kg/job-activity";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { CodeReviewService } from "../../src/application/services/kg/CodeReviewService";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";
import { scanProjectEntries } from "../../src/adapters/driven/workspace-scan";
import { FakeOrchestratorStarter, FakeTaskSkillRegistry, counterClock } from "../helpers/task-fixtures";
import type { TaskManifest } from "../../src/domain/task/types";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * code.review.create 发起链路 I 层（code-review v1.5 体检区双入口之代码
 * 评审；契约 PROTOCOL.md §15.9/§16.9 code.review.create 批）：
 * 真 CodeReviewService × 真任务栈（TaskEngineService/TaskStore @ tmp
 * helix.db，fake skill 注册表 code-review manifest）× loopback WS 路由。
 * kg-review-handlers.test.ts 同构。
 *
 * 覆盖：合法链（job 创建 type/params/projects/createdBy + fixed 三阶段行 +
 * 终态后可再发）；**无准入门槛**（absent 项目同样可发起——与 kg.review.create
 * 唯一语义差）；P0① 仅禁并发（非终态 code-review job 存在 → task.task_running）；
 * project 无法解析 KG_E_PARAM；kg.projects 行 codeReviewRunning 标志
 * （与 reviewRunning 互不串扰）；unimplemented 门控。
 */

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

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** 发命令并等待点对点回执（*.result）或 connection.error。 */
  async cmd(type: string, payload: Record<string, unknown>, timeoutMs = 5000): Promise<{ ok: boolean; result: Record<string, unknown>; error?: { code: string; message: string } }> {
    const before = this.frames.length;
    this.send({ v: PROTOCOL_VERSION, type, payload });
    const resultType = `${type}.result`;
    await until(
      () => this.frames.slice(before).some((f) => f.type === resultType || (f.type === "connection.error" && String(f.payload.message ?? "").includes(type))),
      timeoutMs,
      `回执 ${resultType}`,
    );
    const frames = this.frames.slice(before);
    const errFrame = frames.find((f) => f.type === "connection.error");
    if (errFrame !== undefined) {
      return { ok: false, result: {}, error: errFrame.payload as { code: string; message: string } };
    }
    const res = frames.find((f) => f.type === resultType)!;
    return { ok: true, result: res.payload };
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
  readonly alpha: string; // 索引存在（对照位）
  readonly delta: string; // 永远 absent（无准入门槛验证位——照样可发起）
  readonly taskStore: TaskStore;
  readonly client: TestClient;
  dispose(): Promise<void>;
}

/** adapter 依赖面 stub（kg-review-handlers 同构：kg 面外全部 no-op）。 */
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
        throw new Error("code-review 测试不装配草稿链");
      },
      deleteSession: async () => {},
      currentSessionId: () => "s",
    },
    system: {
      getStatus: () => ({
        running: true, locked: false, home: "/tmp/codereview-it", sessionId: "s",
        agentState: "idle", model: "stub/model",
      }),
      shutdown: async () => {},
    },
    orchestration: {
      spawn: () => ({ status: "rejected" as const, error: "code-review 测试不装配调度" }),
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
      getEffectiveSkills: async () => [],
      setEnabled: async () => { throw new Error("stub"); },
      setModelSlot: async () => { throw new Error("stub"); },
      clearModelSlot: async () => { throw new Error("stub"); },
      setThinkingSlot: async () => { throw new Error("stub"); },
      modelSlot: () => undefined, thinkingSlot: () => undefined, clearThinkingSlot: async () => { throw new Error("stub"); },
    },
    hasModel: () => false,
    kgWriterPinnedTools: ["kg-update"],
    reviewerRemovedTools: ["write", "edit"],
    basePrompts: {},
    browser: new StubBrowserPort(),
    events,
    token: "codereview-it-token",
    port: 0,
  };
}

/** code-review manifest（fixed 三阶段：盘点分批 / 分批评审 / 汇总报告）。 */
function codeReviewManifest(): TaskManifest {
  return {
    paramsSchema: {
      projectRoot: { type: "string", required: true },
    },
    stages: { strategy: "fixed", list: ["盘点分批", "分批评审", "汇总报告"] },
    confirm: "required",
    plan: "enforced",
    projects: { min: 1, max: 1 },
  };
}

function makeRig(): Rig {
  const workspace = mkdtempSync(path.join(tmpdir(), "helix-codereview-ws-"));
  const mk = (name: string): string => {
    const dir = path.join(workspace, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const alpha = mk("alpha");
  const delta = mk("delta");

  // kg 栈（真 sqlite）：仅 alpha 建库（索引存在对照位；delta 恒 absent）
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const seeded = write.write(alpha, {
    kind: "createNode",
    iterationId: "iter-20260902-crv15",
    draft: { kind: "rule", name: "对照节点", digest: "d", scene: "测试场景", status: "confirmed" },
  });
  if (!seeded.ok) throw new Error(`种子写失败：${seeded.error.code}`);
  const project = new KgProjectService({
    workspaceRoot: workspace,
    scan: () => scanProjectEntries(workspace),
    hasIndex: (root) => existsSync(kgDbPath(root)),
    indexStatus: () => ({ phase: "synced", baseline: "b", symbolCount: 0, syncedAt: null, degraded: false }),
    countActiveNodes: (root) => graph.countActiveNodes(root),
    // codeReviewRunning 数据源（container.ts 同口径；闭包引用后声明的 taskStore）
    hasRunningCodeReviewJob: (name) => hasActiveJob(taskStore.listJobs(), "code-review", name),
  });

  // 任务栈（真 SQLite @ tmp helix.db；fake skill 注册表收 code-review）
  const taskDir = mkdtempSync(path.join(tmpdir(), "helix-codereview-task-"));
  const queue = new WriteQueue(path.join(taskDir, "helix.db"));
  const taskStore = new TaskStore(queue);
  const workLedger = parentWorkLedger(queue);
  const starter = new FakeOrchestratorStarter();
  const skills = new FakeTaskSkillRegistry();
  skills.register("code-review", codeReviewManifest(), "对项目代码做质量评审（盘点分批 → 分批评审 → 汇总报告）");
  const taskEngine = new TaskEngineService({ store: taskStore, skills, starter, workLedger, clock: counterClock() });

  const codeReview = new CodeReviewService({ project, taskEngine, store: taskStore });

  // kg.projects 可达面（kg-review rig 同构：viewer 包 project 挂 adapter kg 位）
  const viewer = new KgViewerService({
    project,
    graph,
    verify: { findActivityMismatch: () => [], findOrphans: () => [] } as never,
    report: {} as never,
    write,
    sync: {} as never,
  });

  const events = new EventStream();
  const adapter = new WsServerAdapter({ ...stubAdapterDeps(events), kg: viewer, codeReview });
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
  rig.client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "codereview-it-token", protocolVersion: PROTOCOL_VERSION } });
  await until(() => rig.client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  return rig;
}

afterAll(() => {
  for (const r of rigs) void r.dispose();
  rigs.length = 0;
});

// ── 测试 ─────────────────────────────────────────────────

describe("code.review.create 发起链路（code-review v1.5 体检区代码评审入口）", () => {
  test("合法链：job 创建（type/params/projects/createdBy）+ fixed 三阶段行；并发禁入 task.task_running、终态后可再发（P0①）", async () => {
    const rig = await openRig();

    const res = await rig.client.cmd("code.review.create", { project: "alpha" });
    expect(res.ok).toBe(true);
    expect(res.result.ok).toBe(true);
    const jobId = res.result.jobId as string;
    expect(typeof jobId).toBe("string");

    // 真库查证：job 行四要素（与 kg.review.create / chat task_create 同源）
    const job = rig.taskStore.getJob(jobId)!;
    expect(job.type).toBe("code-review");
    expect(job.params).toEqual({ projectRoot: rig.alpha });
    expect(job.projects).toEqual(["alpha"]);
    expect(job.createdBy).toBe("page");
    // fixed 三阶段行由 manifest 生成（盘点分批 / 分批评审 / 汇总报告）
    expect(rig.taskStore.getStages(jobId).map((s) => s.name)).toEqual(["盘点分批", "分批评审", "汇总报告"]);

    // 并发禁入（P0① 仅禁并发，不绑一次性）：首个 job 非终态（pending）→
    // 再发拒绝 task.task_running，不产新 job 行
    const concurrent = await rig.client.cmd("code.review.create", { project: "alpha" });
    expect(concurrent.ok).toBe(false);
    expect(concurrent.error!.code).toBe("task.task_running");
    expect(rig.taskStore.listJobs()).toHaveLength(1);

    // 终态后可再发（允许反复发起）
    await rig.taskStore.updateJobStatus(jobId, "running");
    await rig.taskStore.updateJobStatus(jobId, "done");
    const again = await rig.client.cmd("code.review.create", { project: "alpha" });
    expect(again.ok).toBe(true);
    expect(again.result.jobId).not.toBe(jobId);
  }, 15000);

  test("无准入门槛：absent 项目（未建 .helix-kg 索引）同样可发起——与 kg.review.create 唯一语义差", async () => {
    const rig = await openRig();
    const res = await rig.client.cmd("code.review.create", { project: "delta" });
    expect(res.ok).toBe(true);
    const job = rig.taskStore.getJob(res.result.jobId as string)!;
    expect(job.type).toBe("code-review");
    expect(job.params).toEqual({ projectRoot: rig.delta });
  }, 15000);

  test("project 无法解析 → KG_E_PARAM；project 缺失 → KG_E_PARAM", async () => {
    const rig = await openRig();
    const bad = await rig.client.cmd("code.review.create", { project: "no-such-project" });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("KG_E_PARAM");
    const missing = await rig.client.cmd("code.review.create", {});
    expect(missing.error!.code).toBe("KG_E_PARAM");
  }, 15000);

  test("unimplemented 门控：codeReview 面未装配 code.review.create 回 command.unimplemented（不崩溃）", async () => {
    const events = new EventStream();
    const adapter = new WsServerAdapter({ ...stubAdapterDeps(events) }); // 无 codeReview 面
    const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
    await client.open();
    client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "codereview-it-token", protocolVersion: PROTOCOL_VERSION } });
    await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
    const res = await client.cmd("code.review.create", { project: "alpha" });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("command.unimplemented");
    adapter.stop();
  }, 15000);
});

describe("kg.projects 行 codeReviewRunning 标志", () => {
  test("非终态 code-review job 覆盖项目 → true；无任务项目缺省；终态后回落（仅禁并发不绑一次性）", async () => {
    const rig = await openRig();
    const listProjects = async (): Promise<Record<string, unknown>[]> => {
      const res = await rig.client.cmd("kg.projects", {});
      expect(res.ok).toBe(true);
      return res.result.projects as Record<string, unknown>[];
    };

    // 无任务：全行缺省（false 不携带）
    const before = await listProjects();
    expect(before.every((r) => r.codeReviewRunning === undefined)).toBe(true);

    const res = await rig.client.cmd("code.review.create", { project: "alpha" });
    const jobId = res.result.jobId as string;
    const during = await listProjects();
    const alphaRow = during.find((r) => r.name === "alpha")!;
    const deltaRow = during.find((r) => r.name === "delta")!;
    expect(alphaRow.codeReviewRunning).toBe(true);
    expect(deltaRow.codeReviewRunning).toBeUndefined();

    // 终态后回落
    await rig.taskStore.updateJobStatus(jobId, "running");
    await rig.taskStore.updateJobStatus(jobId, "done");
    const after = await listProjects();
    expect(after.find((r) => r.name === "alpha")!.codeReviewRunning).toBeUndefined();
  }, 15000);

  test("与 reviewRunning 互不串扰：非终态 code-review job 不点亮 reviewRunning", async () => {
    const rig = await openRig();
    await rig.client.cmd("code.review.create", { project: "alpha" });
    const res = await rig.client.cmd("kg.projects", {});
    const alphaRow = (res.result.projects as Record<string, unknown>[]).find((r) => r.name === "alpha")!;
    expect(alphaRow.codeReviewRunning).toBe(true);
    expect(alphaRow.reviewRunning).toBeUndefined();
  }, 15000);
});
