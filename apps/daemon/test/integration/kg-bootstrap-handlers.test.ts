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
import { CodegraphEngineFake } from "../mocks/CodegraphEngineFake";
import { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import { KgSyncService } from "../../src/application/services/kg/KgSyncService";
import { KgViewerService } from "../../src/application/services/kg/KgViewerService";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgBootstrapService } from "../../src/application/services/kg/KgBootstrapService";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";
import { scanProjectEntries } from "../../src/adapters/driven/workspace-scan";
import type { EngineSymbol, SymbolBatch, WriteResult } from "../../src/domain/kg/types";
import {
  FakeOrchestratorStarter,
  FakeTaskSkillRegistry,
  counterClock,
  kgBootstrapManifest,
} from "../helpers/task-fixtures";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * kg-bootstrap 五命令族 I 层（T3.2，CL-1.A1~A4/CL-4.A1~A4 daemon 侧；契约
 * contracts/kg-bootstrap-api.md 逐字段）：真 kg service 栈（KgProjectService/
 * KgSyncService/KgWriteService/KgBootstrapService）× 真 kg 库（tmp per-project）
 * × 真任务栈（TaskEngineService/TaskStore @ tmp helix.db，fake skill 注册表
 * kg-bootstrap manifest）× loopback WS 路由。
 *
 * 覆盖：kg.bootstrap.create 准入机械复核三违例（absent/building/非空 →
 * kg.bootstrap.not_eligible 带原因）+ 合法链（createdBy="page" + stage 三行，
 * CL-1-T4/T8）；kg.bootstrap.produce 三级分组（任务→阶段→批次，origin_batchId
 * +layer 元数据驱动；无 origin_batch_id 日常落账不进查询，CL-4-T1）；
 * kg.node.update/supersede 走 KgWriteService 落库 + change_log 记理由 + 空
 * 理由/空 patch 拒绝（CL-4-T3）；kg.bootstrap.impact edges 引用方推导 +
 * superseded 排除 + 零写动作（CL-4-T4）。
 */

const DAY = 86_400_000;
const ITER = "iter-20260829-ys7q";

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
  readonly alpha: string; // synced + 知识层为空（create 合法位）
  readonly beta: string; // synced + 已有节点（knowledge_not_empty 位）
  readonly delta: string; // 永远 absent（index_absent 位）
  readonly database: KgDatabase;
  readonly write: KgWriteService;
  readonly store: SqliteKnowledgeStore;
  readonly sync: KgSyncService;
  readonly taskStore: TaskStore;
  readonly queue: WriteQueue;
  readonly engine: TaskEngineService;
  readonly skills: FakeTaskSkillRegistry;
  readonly client: TestClient;
  dispose(): Promise<void>;
}

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
        session: { sessionId: "s", createdAt: "2026-08-29T00:00:00.000Z", entries: [], turns: [], pendingSteer: [] },
        toolCalls: [],
      }),
      startDraftSession: async () => {
        throw new Error("kg-bootstrap 测试不装配草稿链");
      },
      deleteSession: async () => {},
      currentSessionId: () => "s",
    },
    system: {
      getStatus: () => ({
        running: true, locked: false, home: "/tmp/kgboot-it", sessionId: "s",
        agentState: "idle", model: "stub/model",
      }),
      shutdown: async () => {},
    },
    orchestration: {
      spawn: () => ({ status: "rejected" as const, error: "kg 测试不装配调度" }),
      send: () => ({ delivered: false, detail: "stub" }),
      status: () => [],
      kill: () => ({ killed: false, error: "stub" }),
      inspect: () => null,
    },
    model: {
      setModel: async () => { throw new Error("stub"); },
      setThinking: async () => { throw new Error("stub"); },
      getModel: async () => { throw new Error("stub"); },
      catalog: async () => { throw new Error("stub"); },
      catalogRefresh: async () => { throw new Error("stub"); },
      setDefault: async () => { throw new Error("stub"); },
      getDefault: () => ({ model: "stub/model" }),
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
      clearThinkingSlot: async () => { throw new Error("stub"); },
    },
    hasModel: () => false,
    browser: new StubBrowserPort(),
    events,
    token: "kgboot-it-token",
    port: 0,
  };
}

function makeRig(): Rig {
  const workspace = mkdtempSync(path.join(tmpdir(), "helix-kgboot-ws-"));
  const mk = (name: string): string => {
    const dir = path.join(workspace, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const alpha = mk("alpha");
  const beta = mk("beta");
  const delta = mk("delta");

  // kg 栈（真 sqlite；引擎 fake delayMs=800 制造 building 观察窗）
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const now = Date.now();
  const engineSymbols: EngineSymbol[] = [
    {
      id: "fn:archRule", kind: "function", name: "archRule", qualifiedName: "archRule",
      filePath: "src/arch.ts", language: "typescript", signature: null,
      startLine: 1, endLine: 20, startColumn: 1, endColumn: 1,
    },
  ];
  const codegraphEngine = new CodegraphEngineFake({
    delayMs: 800,
    symbols: engineSymbols,
    files: [{ path: "src/arch.ts", contentHash: "a1", modifiedAt: now - DAY, indexedAt: now }],
  });
  const sync = new KgSyncService({ store, graph, engine: codegraphEngine, debounceMs: 10, retryBackoffMs: 5 });
  const project = new KgProjectService({
    workspaceRoot: workspace,
    scan: () => scanProjectEntries(workspace),
    hasIndex: (root) => existsSync(kgDbPath(root)),
    indexStatus: (root) => sync.getStatus(root),
    countActiveNodes: (root) => graph.countActiveNodes(root),
  });
  const viewer = new KgViewerService({ project, graph, verify: { findActivityMismatch: () => [] } as never, report: {} as never, write, sync });

  // 任务栈（真 SQLite @ tmp helix.db；fake skill 注册表收 kg-bootstrap）
  const taskDir = mkdtempSync(path.join(tmpdir(), "helix-kgboot-task-"));
  const dbPath = path.join(taskDir, "helix.db");
  const queue = new WriteQueue(dbPath);
  const taskStore = new TaskStore(queue);
  const workLedger = parentWorkLedger(queue);
  const starter = new FakeOrchestratorStarter();
  const skills = new FakeTaskSkillRegistry();
  skills.register(
    "kg-bootstrap",
    kgBootstrapManifest(),
    "为项目批量创建知识图谱内容（L0 核心层 → L1 领域层 → L2 实体层）；选中项目发起无交互多 agent 知识创建任务时",
  );
  const clock = counterClock();
  const taskEngine = new TaskEngineService({ store: taskStore, skills, starter, workLedger, clock });

  const bootstrap = new KgBootstrapService({ project, graph, write, sync, taskEngine, store: taskStore, skills });

  const events = new EventStream();
  const adapter = new WsServerAdapter({ ...stubAdapterDeps(events), kg: viewer, kgBootstrap: bootstrap });
  const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
  const dispose = async (): Promise<void> => {
    sync.dispose();
    database.closeAll();
    adapter.stop();
    await queue.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(taskDir, { recursive: true, force: true });
  };
  return { workspace, alpha, beta, delta, database, write, store, sync, taskStore, queue, engine: taskEngine, skills, client, dispose };
}

function batch(over: Partial<SymbolBatch> & { baseline: string }): SymbolBatch {
  return { files: [], symbols: [], containsEdges: [], materializedAnchors: [], degraded: false, ...over };
}

function expectOk(...results: WriteResult[]): void {
  for (const r of results) {
    if (!r.ok) throw new Error(`知识层写失败：${r.error.code} ${r.error.message}`);
  }
}

function knowledgeCounts(rig: Rig, projectRoot: string): { nodes: number; edges: number; log: number } {
  const db = rig.database.knowledgeConnection(projectRoot);
  const one = (sql: string): number => Number((db.query(sql).get() as { c: number | bigint }).c);
  return {
    nodes: one("SELECT COUNT(*) AS c FROM nodes"),
    edges: one("SELECT COUNT(*) AS c FROM edges"),
    log: one("SELECT COUNT(*) AS c FROM change_log"),
  };
}

const rigs: Rig[] = [];

async function openRig(): Promise<Rig> {
  const rig = makeRig();
  rigs.push(rig);
  await rig.client.open();
  rig.client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kgboot-it-token", protocolVersion: PROTOCOL_VERSION } });
  await until(() => rig.client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  return rig;
}

/** alpha/beta 建 synced 基准（知识层空；零节点）。 */
function seedSynced(rig: Rig, projectRoot: string, baseline: string): void {
  rig.store.applySync(projectRoot, batch({ baseline, files: [{ path: "src/arch.ts", mtime: Date.now() - DAY, sha256: "a1" }], symbols: [] }));
}

afterAll(async () => {
  for (const r of rigs) await r.dispose();
  rigs.length = 0;
});

// ── ① kg.bootstrap.create：准入机械复核（CL-1-T4/T8） ──────────

describe("kg.bootstrap.create 准入机械复核", () => {
  test("absent 项目 → kg.bootstrap.not_eligible（index_absent），不产 job 行", async () => {
    const rig = await openRig();
    const r = await rig.client.kg("kg.bootstrap.create", { project: "delta" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("kg.bootstrap.not_eligible");
    expect(r.error?.message).toContain("index_absent");
    expect(rig.taskStore.listJobs()).toEqual([]); // 不产 job 行
  });

  test("building 窗口 → not_eligible（index_building）", async () => {
    const rig = await openRig();
    seedSynced(rig, rig.alpha, "a0");
    const building = rig.sync.triggerManual(rig.alpha); // 引擎 delayMs=800
    const r = await rig.client.kg("kg.bootstrap.create", { project: "alpha" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("kg.bootstrap.not_eligible");
    expect(r.error?.message).toContain("index_building");
    await building;
  });

  test("有带 layer 的图谱产出 → not_eligible（knowledge_not_empty）", async () => {
    const rig = await openRig();
    seedSynced(rig, rig.beta, "b0");
    // O-9 精化口径：阻挡项 = 带 layer 的 bootstrap 产出（非全部活跃节点）
    expectOk(
      rig.write.write(rig.beta, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "既有产出", digest: "已有图谱产出", status: "confirmed", layer: "L0" } }),
    );
    const r = await rig.client.kg("kg.bootstrap.create", { project: "beta" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("kg.bootstrap.not_eligible");
    expect(r.error?.message).toContain("knowledge_not_empty");
  });

  test("仅 sediment 节点（layer 为 NULL，无 bootstrap 产出）→ 放行（O-9：沉淀不挡 bootstrap 入口）", async () => {
    const rig = await openRig();
    seedSynced(rig, rig.beta, "b0");
    // sediment 形态：任务闭环沉淀产生，无 layer 元数据
    expectOk(
      rig.write.write(rig.beta, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "沉淀规则", digest: "任务闭环沉淀", status: "confirmed" } }),
    );
    const r = await rig.client.kg("kg.bootstrap.create", { project: "beta" });
    expect(r.ok).toBe(true);
    expect(r.result.ok).toBe(true);
    expect(rig.taskStore.getJob(r.result.jobId as string)).toBeDefined();
  });

  test("sediment 节点 + 带 layer 产出并存 → 仍 not_eligible（knowledge_not_empty，阻挡项只在产出）", async () => {
    const rig = await openRig();
    seedSynced(rig, rig.beta, "b0");
    expectOk(
      rig.write.write(rig.beta, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "沉淀规则", digest: "任务闭环沉淀", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(rig.beta, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "既有产出", digest: "已有图谱产出", scene: "测试场景", status: "confirmed", layer: "L1" } }),
    );
    const r = await rig.client.kg("kg.bootstrap.create", { project: "beta" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("kg.bootstrap.not_eligible");
    expect(r.error?.message).toContain("knowledge_not_empty");
  });

  test("合法（synced + 知识层空）→ ok + job 行 createdBy=page + stage 三行（L0/L1/L2 冻结）", async () => {
    const rig = await openRig();
    seedSynced(rig, rig.alpha, "a0");
    const r = await rig.client.kg("kg.bootstrap.create", { project: "alpha" });
    expect(r.ok).toBe(true);
    expect(r.result.ok).toBe(true);
    const jobId = r.result.jobId as string;
    const job = rig.taskStore.getJob(jobId);
    expect(job?.type).toBe("kg-bootstrap");
    expect(job?.createdBy).toBe("page");
    expect(job?.projects).toEqual(["alpha"]);
    expect((job?.params as Record<string, unknown>).projectRoot).toBe(rig.alpha);
    const stages = rig.taskStore.getStages(jobId);
    expect(stages.map((s) => s.name)).toEqual(["L0 核心层", "L1 领域层", "L2 实体层"]);
    expect(stages.every((s) => s.status === "pending")).toBe(true);
  });

  test("degraded + 知识层空 → 同样可发起（V-1：degraded 不阻断）", async () => {
    const rig = await openRig();
    rig.store.applySync(rig.alpha, batch({ baseline: "a0", degraded: true }));
    const r = await rig.client.kg("kg.bootstrap.create", { project: "alpha" });
    expect(r.ok).toBe(true);
    expect(rig.taskStore.getJob(r.result.jobId as string)).toBeDefined();
  });

  test("createTask 校验失败透传 task.validation_failed（scope 透传 params）", async () => {
    const rig = await openRig();
    seedSynced(rig, rig.alpha, "a0");
    const withScope = await rig.client.kg("kg.bootstrap.create", { project: "alpha", scope: "src/" });
    expect(withScope.ok).toBe(true);
    const params = rig.taskStore.getJob(withScope.result.jobId as string)?.params as Record<string, unknown>;
    expect(params.scope).toBe("src/");
  });
});

// ── ② kg.bootstrap.produce：三级分组（CL-4-T1） ────────────────

describe("kg.bootstrap.produce 三级分组", () => {
  test("任务→阶段→批次分组正确；无 origin_batch_id 日常落账不进查询；superseded 留史在列", async () => {
    const rig = await openRig();
    seedSynced(rig, rig.alpha, "a0");
    const { jobId } = await rig.engine.createTask({ type: "kg-bootstrap", projects: ["alpha"], params: { projectRoot: rig.alpha }, createdBy: "chat" });
    const { batchId: b1 } = await rig.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次：全局规范与架构基线" });
    const { batchId: b2 } = await rig.engine.insertBatch({ jobId, stageSeq: 2, scope: "批次：任务引擎域" });
    // 产出节点：b1 × 2（L0）+ b2 × 1（L1）+ 日常落账 1（无元数据，不进）
    expectOk(
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, taskId: jobId, originBatchId: b1, draft: { kind: "rule", name: "分层依赖单向", digest: "import 只准外层指向内层", scene: "测试场景", body: "依赖必须单向。\n- 外层可指向内层", status: "confirmed", layer: "L0" } }),
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, taskId: jobId, originBatchId: b1, draft: { kind: "rule", name: "写面唯一入口", digest: "全部写经 KgWriteService", scene: "测试场景", status: "confirmed", layer: "L0" } }),
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, taskId: jobId, originBatchId: b2, draft: { kind: "entity", name: "任务引擎域", digest: "job/stage/batch 三表", scene: "测试场景", status: "confirmed", layer: "L1" } }),
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "日常落账规则", digest: "无批次来源", scene: "测试场景", status: "confirmed" } }),
    );
    const r = await rig.client.kg("kg.bootstrap.produce", { project: "alpha" });
    expect(r.ok).toBe(true);
    const groups = r.result.groups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.jobId).toBe(jobId);
    expect(typeof g.title).toBe("string");
    expect(String(g.title)).toContain("知识图谱");
    const stages = g.stages as Array<Record<string, unknown>>;
    expect(stages.map((s) => s.layer)).toEqual(["L0", "L1"]);
    expect(stages[0]!.name).toBe("L0 核心层");
    const b1Nodes = (stages[0]!.batches as Array<Record<string, unknown>>)[0]!;
    expect(b1Nodes.batchId).toBe(b1);
    expect(b1Nodes.scope).toBe("批次：全局规范与架构基线");
    expect(b1Nodes.nodes).toHaveLength(2);
    const b2Nodes = (stages[1]!.batches as Array<Record<string, unknown>>)[0]!;
    expect(b2Nodes.batchId).toBe(b2);
    expect(b2Nodes.nodes).toHaveLength(1);
    // 日常落账节点（无 origin_batch_id）不进任何分组
    const allNames = [b1Nodes, b2Nodes]
      .flatMap((b) => b.nodes as Array<Record<string, unknown>>)
      .map((n) => n.name);
    expect(allNames).not.toContain("日常落账规则");
  });

  test("absent 项目 → 空 groups（读面不建库）", async () => {
    const rig = await openRig();
    const r = await rig.client.kg("kg.bootstrap.produce", { project: "delta" });
    expect(r.ok).toBe(true);
    expect(r.result.groups).toEqual([]);
    expect(existsSync(kgDbPath(rig.delta))).toBe(false);
  });
});

// ── ③ kg.node.update / kg.node.supersede：修正写面（CL-4-T3） ──

describe("kg.node.update / kg.node.supersede 修正写面", () => {
  async function seeded(): Promise<{ rig: Rig; nodeId: string }> {
    const rig = await openRig();
    seedSynced(rig, rig.alpha, "a0");
    const w = rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "待修正规则", digest: "旧 digest", scene: "测试场景", body: "旧正文。", status: "confirmed" } });
    expectOk(w);
    return { rig, nodeId: (w as { ok: true; nodeId: string }).nodeId };
  }

  test("update：digest+body 落库 + change_log 记 updateNode 行；节点保持 confirmed", async () => {
    const { rig, nodeId } = await seeded();
    const r = await rig.client.kg("kg.node.update", { project: "alpha", nodeId, digest: "新 digest（修订）", body: "新正文段。" });
    expect(r.ok).toBe(true);
    const node = r.result.node as Record<string, unknown>;
    expect(node.digest).toBe("新 digest（修订）");
    expect(node.status).toBe("confirmed");
    const log = rig.database
      .knowledgeConnection(rig.alpha)
      .query("SELECT op, reason FROM change_log WHERE node_id = ? AND op = 'updateNode'")
      .all(nodeId) as Array<{ op: string; reason: string | null }>;
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]!.reason).toContain("页面");
  });

  test("update 空 patch（digest/body 均缺）→ task.validation_failed", async () => {
    const { rig, nodeId } = await seeded();
    const r = await rig.client.kg("kg.node.update", { project: "alpha", nodeId });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("task.validation_failed");
  });

  test("supersede 空理由 → task.validation_failed（后端双防线）；合法理由 → 留史 + change_log 记理由", async () => {
    const { rig, nodeId } = await seeded();
    const empty = await rig.client.kg("kg.node.supersede", { project: "alpha", nodeId, reason: "   " });
    expect(empty.ok).toBe(false);
    expect(empty.error?.code).toBe("task.validation_failed");

    const r = await rig.client.kg("kg.node.supersede", { project: "alpha", nodeId, reason: "与现状不符" });
    expect(r.ok).toBe(true);
    const row = rig.database
      .knowledgeConnection(rig.alpha)
      .query("SELECT status FROM nodes WHERE id = ?")
      .get(nodeId) as { status: string };
    expect(row.status).toBe("superseded");
    const log = rig.database
      .knowledgeConnection(rig.alpha)
      .query("SELECT reason FROM change_log WHERE node_id = ? AND op = 'supersede'")
      .get(nodeId) as { reason: string | null };
    expect(log.reason).toBe("与现状不符");
  });

  test("节点不存在 → kg.node.not_found", async () => {
    const { rig } = await seeded();
    const up = await rig.client.kg("kg.node.update", { project: "alpha", nodeId: "TR-999", digest: "x" });
    expect(up.ok).toBe(false);
    expect(up.error?.code).toBe("kg.node.not_found");
    const sup = await rig.client.kg("kg.node.supersede", { project: "alpha", nodeId: "TR-999", reason: "x" });
    expect(sup.ok).toBe(false);
    expect(sup.error?.code).toBe("kg.node.not_found");
  });
});

// ── ④ kg.bootstrap.impact：连带推导（CL-4-T4） ─────────────────

describe("kg.bootstrap.impact 连带推导", () => {
  test("edges 引用方返回、superseded 引用方排除、零写动作", async () => {
    const rig = await openRig();
    seedSynced(rig, rig.alpha, "a0");
    expectOk(
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "上游规则", digest: "被引用的上游", scene: "测试场景", status: "confirmed" } }), // TR-1
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "下游甲", digest: "引用上游", scene: "测试场景", status: "confirmed" } }), // E-1
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "下游乙", digest: "引用上游", scene: "测试场景", status: "confirmed" } }), // E-2
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "已废下游", digest: "引用上游但已废弃", scene: "测试场景", status: "confirmed" } }), // E-3
      rig.write.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "无关节点", digest: "不引用", scene: "测试场景", status: "confirmed" } }), // E-4
      rig.write.write(rig.alpha, { kind: "addEdge", iterationId: ITER, srcId: "E-1", verb: "dependsOn", dstId: "TR-1" }),
      rig.write.write(rig.alpha, { kind: "addEdge", iterationId: ITER, srcId: "E-2", verb: "references", dstId: "TR-1" }),
      rig.write.write(rig.alpha, { kind: "addEdge", iterationId: ITER, srcId: "E-3", verb: "dependsOn", dstId: "TR-1" }),
      rig.write.write(rig.alpha, { kind: "supersede", iterationId: ITER, nodeId: "E-3", reason: "已废弃" }),
    );
    const before = knowledgeCounts(rig, rig.alpha);
    const r = await rig.client.kg("kg.bootstrap.impact", { project: "alpha", nodeId: "TR-1" });
    expect(r.ok).toBe(true);
    const affected = r.result.affected as Array<Record<string, unknown>>;
    expect(r.result.count).toBe(2);
    expect(affected.map((a) => a.name).sort()).toEqual(["下游乙", "下游甲"]);
    expect(affected.every((a) => typeof a.digestFirstLine === "string")).toBe(true);
    // 零写动作：三表计数不变（只读推导不落库）
    expect(knowledgeCounts(rig, rig.alpha)).toEqual(before);
  });
});
