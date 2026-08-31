import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { KgMaintenanceService } from "../../src/application/services/kg/KgMaintenanceService";
import { KgFsWatchService } from "../../src/application/services/kg/KgFsWatchService";
import type { FsWatchEvent, FsWatchPort } from "../../src/application/ports/outbound/FsWatchPort";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";
import { scanProjectEntries } from "../../src/adapters/driven/workspace-scan";
import type { EngineSymbol } from "../../src/domain/kg/types";
import {
  FakeOrchestratorStarter,
  FakeTaskSkillRegistry,
  counterClock,
  kgBootstrapManifest,
} from "../helpers/task-fixtures";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * kg 维护批两命令 I 层（C1：kg.graph.purge / kg.index.delete；契约 =
 * PROTOCOL.md §22）：真 kg service 栈（KgProjectService/KgSyncService/
 * KgWriteService/KgBootstrapService/KgMaintenanceService/KgFsWatchService）
 * × 真 kg 库（tmp per-project）× 真任务栈（TaskEngineService/TaskStore @
 * tmp helix.db，fake skill 注册表）× fake 引擎/监控端口 × loopback WS 路由。
 *
 * 覆盖（验收标准映射）：
 * - AC2/AC4：purge 全清（九表清零 + 索引态复位 absent）→ 下一次
 *   triggerManual sync 正常重建符号面（无破窗）→ bootstrap 准入自
 *   knowledge_not_empty 恢复 eligible；
 * - AC3：purge 门禁——running/pending kg-bootstrap 任务存在时拒绝
 *   （kg.graph.purge_blocked）；他项目任务不阻断本项目；终态后放行；
 * - AC5：index.delete——.codegraph 删除（引擎 deleteIndex 被调）+ 状态复位
 *   absent + stopWatching 被调（watcher 已停）+ 知识层保留 + 重建后
 *   watcher 经 onSynced 自动重挂；
 * - 协议面：未装配维护面 → command.unimplemented；缺 project → KG_E_PARAM。
 */

const DAY = 86_400_000;

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
    timeoutMs = 8000,
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

/** 生命周期记录的 fake 监控端口（纯内存，零真 fs；kg-fs-watch.test.ts 同形）。 */
class FakeWatchPort implements FsWatchPort {
  readonly watched: string[] = [];
  readonly closed: string[] = [];
  private readonly handlers = new Map<string, (e: FsWatchEvent) => void>();

  watch(root: string, onEvent: (e: FsWatchEvent) => void): { close(): void } {
    this.watched.push(root);
    this.handlers.set(root, onEvent);
    return {
      close: () => {
        this.closed.push(root);
        this.handlers.delete(root);
      },
    };
  }
}

// ── rig ───────────────────────────────────────────────────

interface Rig {
  readonly workspace: string;
  readonly alpha: string; // synced + 知识非空（purge 位）→ index.delete 联动位复用
  readonly beta: string; // synced + 知识层空（bootstrap eligible → 门禁任务宿主）
  readonly delta: string; // 永远 absent
  readonly database: KgDatabase;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
  readonly sync: KgSyncService;
  readonly codegraphEngine: CodegraphEngineFake;
  readonly watchPort: FakeWatchPort;
  readonly fsWatch: KgFsWatchService;
  readonly bootstrap: KgBootstrapService;
  readonly taskStore: TaskStore;
  readonly taskEngine: TaskEngineService;
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
        throw new Error("kg 维护测试不装配草稿链");
      },
      deleteSession: async () => {},
      currentSessionId: () => "s",
    },
    system: {
      getStatus: () => ({
        running: true, locked: false, home: "/tmp/kgmaint-it", sessionId: "s",
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
      park: () => ({ parked: false as const, error: "测试桩不挂起" }),
      resume: () => ({ resumed: false as const, error: "测试桩不恢复" }),
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
      kgWriterPinnedTools: ["kg-update"],
    browser: new StubBrowserPort(),
    events,
    token: "kgmaint-it-token",
    port: 0,
  };
}

function makeRig(): Rig {
  const workspace = mkdtempSync(path.join(tmpdir(), "helix-kgmaint-ws-"));
  const mk = (name: string): string => {
    const dir = path.join(workspace, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const alpha = mk("alpha");
  const beta = mk("beta");
  const delta = mk("delta");

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
    symbols: engineSymbols,
    files: [{ path: "src/arch.ts", contentHash: "a1", modifiedAt: now - DAY, indexedAt: now }],
  });
  const watchPort = new FakeWatchPort();
  // 生产同款晚绑闭合：sync.onSynced → fsWatch.watchProject（buildKnowledgeStack 同构）
  let fsWatchRef: KgFsWatchService | undefined;
  const sync = new KgSyncService({
    store,
    graph,
    engine: codegraphEngine,
    debounceMs: 10,
    retryBackoffMs: 5,
    onSynced: (root) => fsWatchRef?.watchProject(root),
  });
  const fsWatch = new KgFsWatchService({ sync, watcher: watchPort });
  fsWatchRef = fsWatch;
  const project = new KgProjectService({
    workspaceRoot: workspace,
    scan: () => scanProjectEntries(workspace),
    hasIndex: (root) => existsSync(kgDbPath(root)),
    indexStatus: (root) => sync.getStatus(root),
    countActiveNodes: (root) => graph.countActiveNodes(root),
  });
  const viewer = new KgViewerService({ project, graph, verify: { findActivityMismatch: () => [], findOrphans: () => [] } as never, /* W2-D R14：rebuild 路径消费 findOrphans——本测试不触，空清单兜底 */ report: {} as never, write, sync });

  const taskDir = mkdtempSync(path.join(tmpdir(), "helix-kgmaint-task-"));
  const queue = new WriteQueue(path.join(taskDir, "helix.db"));
  const taskStore = new TaskStore(queue);
  const workLedger = parentWorkLedger(queue);
  const starter = new FakeOrchestratorStarter();
  const skills = new FakeTaskSkillRegistry();
  skills.register(
    "kg-bootstrap",
    kgBootstrapManifest(),
    "为项目批量创建知识图谱内容（L0 核心层 → L1 领域层 → L2 实体层）；选中项目发起无交互多 agent 知识创建任务时",
  );
  const taskEngine = new TaskEngineService({ store: taskStore, skills, starter, workLedger, clock: counterClock() });

  const bootstrap = new KgBootstrapService({ project, graph, write, sync, taskEngine, store: taskStore, skills });
  const maintenance = new KgMaintenanceService({
    project,
    store,
    sync,
    fsWatch,
    codegraph: codegraphEngine,
    taskStore,
  });

  const events = new EventStream();
  const adapter = new WsServerAdapter({
    ...stubAdapterDeps(events),
    kg: viewer,
    kgBootstrap: bootstrap,
    kgMaintenance: maintenance,
  });
  const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
  const dispose = async (): Promise<void> => {
    fsWatch.dispose();
    sync.dispose();
    database.closeAll();
    adapter.stop();
    await queue.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(taskDir, { recursive: true, force: true });
  };
  return {
    workspace, alpha, beta, delta, database, graph, write, sync, codegraphEngine,
    watchPort, fsWatch, bootstrap, taskStore, taskEngine, client, dispose,
  };
}

/** 假 .codegraph 目录（index.delete 删除目标；内含标记文件断言递归删除）。 */
function plantCodegraph(projectRoot: string): string {
  const dir = path.join(projectRoot, ".codegraph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "codegraph.db"), "fake-index");
  return dir;
}

// ── 测试 ─────────────────────────────────────────────────

const rig = makeRig();

afterAll(async () => {
  await rig.client.close();
  await rig.dispose();
});

describe("kg 维护批（C1）：kg.graph.purge / kg.index.delete I 层", () => {
  test("① purge 全清 + 索引态复位 + 重建后准入恢复 eligible（AC2/AC4）", async () => {
    await rig.client.open();
    rig.client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kgmaint-it-token", protocolVersion: PROTOCOL_VERSION } });
    // 索引建成（alpha/beta）：triggerManual → synced + watcher 挂接
    const idxA = await rig.client.kg("kg.index.status", { project: "alpha", rebuild: true });
    expect(idxA.ok).toBe(true);
    expect(idxA.result.state).toBe("synced");
    const idxB = await rig.client.kg("kg.index.status", { project: "beta", rebuild: true });
    expect(idxB.result.state).toBe("synced");
    expect(rig.fsWatch.isWatching(rig.alpha)).toBe(true); // onSynced 挂接

    // 知识层写入一带 layer 产出节点 → 准入 knowledge_not_empty（O-9 精化口径：阻挡项 = 带 layer 产出）
    const created = rig.write.write(rig.alpha, {
      kind: "createNode",
      iterationId: "iter-c1",
      draft: { kind: "rule", name: "待清规则", digest: "purge 目标节点", scene: "测试场景", layer: "L0" },
    });
    expect(created.ok).toBe(true);
    const before = rig.bootstrap.eligibility(rig.alpha);
    expect(before).toEqual({ eligible: false, reason: "knowledge_not_empty" });

    // purge → 全清回执
    const purged = await rig.client.kg("kg.graph.purge", { project: "alpha" });
    expect(purged.ok).toBe(true);
    expect(purged.result.purged).toBe(true);
    expect(purged.result.nodesRemoved).toBe(1);
    expect(Number(purged.result.symbolsRemoved)).toBeGreaterThanOrEqual(1);
    expect(Number(purged.result.filesRemoved)).toBeGreaterThanOrEqual(1);

    // 状态机自洽：九表清零 + 索引态 absent（baseline 复位）
    expect(rig.graph.countNodes(rig.alpha)).toBe(0);
    expect(rig.graph.getIndexStatus(rig.alpha).baseline).toBeNull();
    expect(rig.graph.getSyncBaseline(rig.alpha).files).toEqual([]);
    expect(rig.sync.getStatus(rig.alpha).phase).toBe("absent");
    // 复位态下准入 = index_absent（索引态已复位，需先重建）
    expect(rig.bootstrap.eligibility(rig.alpha)).toEqual({ eligible: false, reason: "index_absent" });

    // 下一次 triggerManual：符号面正常重建（无破窗——清 symbols 且清 meta 基线）
    const rebuilt = await rig.client.kg("kg.index.status", { project: "alpha", rebuild: true });
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.result.state).toBe("synced");
    expect(rig.graph.getSyncBaseline(rig.alpha).files.length).toBeGreaterThanOrEqual(1);
    expect(rig.graph.getIndexStatus(rig.alpha).symbolCount).toBeGreaterThanOrEqual(1);

    // 准入恢复：knowledge_not_empty → eligible
    expect(rig.bootstrap.eligibility(rig.alpha)).toEqual({ eligible: true });
  });

  test("② purge 门禁：running/pending kg-bootstrap 任务拒绝（AC3）；他项目不阻断；终态放行", async () => {
    // beta 发起 bootstrap 任务（eligible：synced + 空知识层；fake starter 不推进 → pending）
    const created = await rig.bootstrap.create("beta");
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.value.jobId : "";

    // pending 任务存在 → 拒绝
    const blockedPending = await rig.client.kg("kg.graph.purge", { project: "beta" });
    expect(blockedPending.ok).toBe(false);
    expect(blockedPending.error?.code).toBe("kg.graph.purge_blocked");

    // running 态同样拒绝
    await rig.taskStore.updateJobStatus(jobId, "running");
    const blockedRunning = await rig.client.kg("kg.graph.purge", { project: "beta" });
    expect(blockedRunning.ok).toBe(false);
    expect(blockedRunning.error?.code).toBe("kg.graph.purge_blocked");

    // 他项目任务不阻断本项目 purge（项目作用域隔离）
    const other = await rig.client.kg("kg.graph.purge", { project: "alpha" });
    expect(other.ok).toBe(true);

    // 终态（cancelled）后放行
    await rig.taskEngine.cancel(jobId);
    const allowed = await rig.client.kg("kg.graph.purge", { project: "beta" });
    expect(allowed.ok).toBe(true);
    expect(allowed.result.purged).toBe(true);
  });

  test("③ index.delete：.codegraph 删除 + 状态 absent + watcher 停 + 重建自动重挂（AC5）", async () => {
    // alpha 当前 synced + watched（①② 后重建过）；先补一个知识节点验证知识层保留
    rig.write.write(rig.alpha, {
      kind: "createNode",
      iterationId: "iter-c1",
      draft: { kind: "entity", name: "保留实体", digest: "index-delete 不动知识层", scene: "测试场景" },
    });
    expect(rig.fsWatch.isWatching(rig.alpha)).toBe(true);
    const cgDir = plantCodegraph(rig.alpha);
    expect(existsSync(cgDir)).toBe(true);

    const del = await rig.client.kg("kg.index.delete", { project: "alpha" });
    expect(del.ok).toBe(true);
    expect(del.result).toEqual({ deleted: true, state: "absent", watcherStopped: true });

    // .codegraph 已删（引擎 deleteIndex 被调）+ 状态复位 absent + watcher 已停
    expect(existsSync(cgDir)).toBe(false);
    expect(rig.codegraphEngine.calls.some((c) => c.method === "deleteIndex" && c.projectRoot === rig.alpha)).toBe(true);
    expect(rig.sync.getStatus(rig.alpha).phase).toBe("absent");
    expect(rig.fsWatch.isWatching(rig.alpha)).toBe(false);
    expect(rig.watchPort.closed).toContain(rig.alpha);
    const status = await rig.client.kg("kg.index.status", { project: "alpha" });
    expect(status.result.state).toBe("absent");

    // 知识层保留（index-delete 不动 .helix-kg 知识面）
    expect(rig.graph.countNodes(rig.alpha)).toBe(1);

    // 重建索引 → synced + watcher 经 onSynced 自动重挂
    const rebuilt = await rig.client.kg("kg.index.status", { project: "alpha", rebuild: true });
    expect(rebuilt.result.state).toBe("synced");
    expect(rig.fsWatch.isWatching(rig.alpha)).toBe(true);
  });

  test("④ 协议面：缺 project → KG_E_PARAM；未装配维护面 → command.unimplemented", async () => {
    const noProject = await rig.client.kg("kg.graph.purge", {});
    expect(noProject.ok).toBe(false);
    expect(noProject.error?.code).toBe("KG_E_PARAM");

    const events = new EventStream();
    const bare = new WsServerAdapter({ ...stubAdapterDeps(events) }); // 无 kgMaintenance
    const client = new TestClient(`ws://127.0.0.1:${bare.port}`);
    await client.open();
    client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kgmaint-it-token", protocolVersion: PROTOCOL_VERSION } });
    const un = await client.kg("kg.index.delete", { project: "alpha" });
    expect(un.ok).toBe(false);
    expect(un.error?.code).toBe("command.unimplemented");
    await client.close();
    bare.stop();
  });
});
