import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { CodegraphEngineFake } from "../mocks/CodegraphEngineFake";
import { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import { KgReportService } from "../../src/application/services/kg/KgReportService";
import { KgSyncService } from "../../src/application/services/kg/KgSyncService";
import { KgVerifyService } from "../../src/application/services/kg/KgVerifyService";
import { KgViewerService, type KgViewerServiceDeps } from "../../src/application/services/kg/KgViewerService";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { scanProjectEntries } from "../../src/adapters/driven/workspace-scan";
import type { EngineSymbol, SymbolBatch, WriteResult } from "../../src/domain/kg/types";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * kg 六命令族 I 层（T5.3，CL-5.A1~A5/A8~A10 daemon 侧；契约
 * contracts/kg-viewer-api.md 逐字段）：真 service 栈（KgViewerService/
 * KgProjectService/KgSyncService/KgWriteService/…）× tmp 真库（KgDatabase
 * per-project 懒开）× loopback WS 路由（WsServerAdapter.routeCommand →
 * handlers/kg.ts）。引擎边界 = CodegraphEngineFake（test-design §5 依赖
 * 策略：codegraph 引擎 fake / sqlite-kg 真库；delayMs 制造 building 窗口）。
 *
 * 覆盖：kg.projects 宽松口径扫描+排除清单+absent 不建库（A8）；
 * kg.list 三路过滤叠加+total/matched+跨项目不串（A1/A10）；
 * kg.node.detail 六段聚合（A2）；kg.change.report 四类条目（A3）；
 * kg.node.confirm 唯一写走 F2.3 API+change_log 追加+非 draft KG_E_STATE（A4）；
 * kg.index.status 四态透传+rebuild 零知识层写+absent 冷启动（A5/A9）；
 * project 两形态等价/无法解析 KG_E_PARAM（A10）；unimplemented 门控；
 * 容器接线（kgWorkspaceRoot 注入 + 真组合根 roundtrip）。
 */

const DAY = 86_400_000;
const ITER = "iter-20260825-11fo";

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

/** 收集帧的 loopback WS 测试客户端（ws-server-spy.test.ts 同构）。 */
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

  /** 发 kg 命令并等结果帧或 connection.error 回执（afterIndex 前的旧帧不算）。 */
  async kg(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; result: Record<string, unknown>; error: { code: string; message: string } | null }> {
    const at = this.frames.length;
    this.send({ v: PROTOCOL_VERSION, type, payload });
    await until(
      () =>
        this.frames.slice(at).some((f) => f.type === `${type}.result` || f.type === "connection.error"),
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

  /** 不等待（building 窗口观察用：发出后由调用方自行断言时序）。 */
  fireAndForget(type: string, payload: Record<string, unknown>): void {
    this.send({ v: PROTOCOL_VERSION, type, payload });
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

// ── rig：workspace + 真 service 栈 + WsServerAdapter ─────────────

interface Rig {
  readonly workspace: string;
  readonly alpha: string;
  readonly beta: string;
  readonly gamma: string;
  readonly delta: string;
  readonly database: KgDatabase;
  readonly write: KgWriteService;
  readonly store: SqliteKnowledgeStore;
  readonly sync: KgSyncService;
  readonly adapter: WsServerAdapter;
  readonly client: TestClient;
  readonly engine: CodegraphEngineFake;
  readonly dispose: () => void;
}

/** adapter 依赖面 stub（ws-server-spy.test.ts 先例：kg 面外全部 no-op）。 */
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
        session: {
          sessionId: "s",
          createdAt: "2026-08-25T00:00:00.000Z",
          entries: [],
          turns: [],
          pendingSteer: [],
        },
        toolCalls: [],
      }),
      startDraftSession: async () => {
        throw new Error("kg 测试不装配草稿链");
      },
      deleteSession: async () => {},
      currentSessionId: () => "s",
    },
    system: {
      getStatus: () => ({
        running: true,
        locked: false,
        home: "/tmp/kg-it",
        sessionId: "s",
        agentState: "idle",
        model: "stub/model",
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
      setModel: async () => {
        throw new Error("stub");
      },
      setThinking: async () => {
        throw new Error("stub");
      },
      getModel: async () => {
        throw new Error("stub");
      },
      catalog: async () => {
        throw new Error("stub");
      },
      catalogRefresh: async () => {
        throw new Error("stub");
      },
      setDefault: async () => {
        throw new Error("stub");
      },
      getDefault: () => ({ model: "stub/model" }),
      authList: async () => [],
      authSetKey: async () => {
        throw new Error("stub");
      },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail" as const, reason: "stub" }),
    },
    resource: {
      list: async () => {
        throw new Error("stub");
      },
      setEnabled: async () => {
        throw new Error("stub");
      },
      setModelSlot: async () => {
        throw new Error("stub");
      },
      clearModelSlot: async () => {
        throw new Error("stub");
      },
      setThinkingSlot: async () => {
        throw new Error("stub");
      },
      clearThinkingSlot: async () => {
        throw new Error("stub");
      },
    },
    hasModel: () => false,
      kgWriterPinnedTools: ["kg-update"],
    browser: new StubBrowserPort(),
    events,
    token: "kg-it-token",
    port: 0,
  };
}

function makeRig(): Rig {
  // workspace：alpha（多节点+锚/边/链）/ beta（单节点，跨项目隔离）/
  // gamma（degraded 基准）/ delta（永远 absent——读面不建库断言载体）；
  // 排除清单段 + 隐藏目录 + 文件项各一（kg.projects 过滤断言载体）。
  const workspace = mkdtempSync(path.join(tmpdir(), "helix-kg-ws-"));
  const mk = (name: string): string => {
    const dir = path.join(workspace, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const alpha = mk("alpha");
  const beta = mk("beta");
  const gamma = mk("gamma");
  const delta = mk("delta");
  mk("docs");
  mk(".helix");
  mk(".worktrees");
  mk("node_modules");
  mk(".hidden");
  writeFileSync(path.join(workspace, "README.md"), "文件项不入列\n");

  // 真 service 栈（buildKnowledgeStack 同构接线；引擎边界 = fake——
  // delayMs=150 制造 building 观察窗；符号面与种子 applySync 同源）
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const now = Date.now();
  const engine = new CodegraphEngineFake({
    delayMs: 150,
    symbols: [
      engineSymbol("fn:layerRule", "layerRule", "src/arch.ts", "function", 11, 40),
      engineSymbol("fn:saveSession", "saveSession", "src/hot.ts", "function", 1, 9),
    ],
    files: [
      { path: "src/arch.ts", contentHash: "a1", modifiedAt: now - 1 * DAY, indexedAt: now },
      { path: "src/hot.ts", contentHash: "h1", modifiedAt: now - 1 * DAY, indexedAt: now },
    ],
  });
  const sync = new KgSyncService({ store, graph, engine, debounceMs: 10, retryBackoffMs: 5 });
  const verify = new KgVerifyService({ graph });
  const report = new KgReportService({ graph, verify });
  const project = new KgProjectService({
    workspaceRoot: workspace,
    scan: () => scanProjectEntries(workspace),
    hasIndex: (root) => existsSync(kgDbPath(root)),
    indexStatus: (root) => sync.getStatus(root),
    countActiveNodes: (root) => graph.countActiveNodes(root),
  });
  const viewer = new KgViewerService({ project, graph, verify, report, write, sync });

  const events = new EventStream();
  const adapter = new WsServerAdapter({ ...stubAdapterDeps(events), kg: viewer });
  const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
  const dispose = (): void => {
    sync.dispose();
    database.closeAll();
    adapter.stop();
    rmSync(workspace, { recursive: true, force: true });
  };
  return { workspace, alpha, beta, gamma, delta, database, write, store, sync, adapter, client, engine, dispose };
}

function engineSymbol(id: string, name: string, file: string, kind = "function", start = 1, end = 9): EngineSymbol {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath: file,
    language: "typescript",
    signature: null,
    startLine: start,
    endLine: end,
    startColumn: 1,
    endColumn: 1,
  };
}

function batch(over: Partial<SymbolBatch> & { baseline: string }): SymbolBatch {
  return { files: [], symbols: [], containsEdges: [], materializedAnchors: [], degraded: false, ...over };
}

function expectOk(...results: WriteResult[]): void {
  for (const r of results) {
    if (!r.ok) throw new Error(`知识层写失败：${r.error.code} ${r.error.message}`);
  }
}

/** 知识层表行数（nodes/edges/change_log——rebuild 零知识层写断言载体）。 */
function knowledgeCounts(rig: Rig, projectRoot: string): { nodes: number; edges: number; log: number } {
  const db = rig.database.knowledgeConnection(projectRoot);
  const one = (sql: string): number =>
    Number((db.query(sql).get() as { c: number | bigint }).c);
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
  rig.client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kg-it-token", protocolVersion: PROTOCOL_VERSION } });
  await until(() => rig.client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  return rig;
}

afterAll(() => {
  for (const r of rigs) r.dispose();
  rigs.length = 0;
});

// ── 种子（真 sync 管道首拍 + applySync 补拍；详见各断言注释） ──────

async function seedAlpha(rig: Rig): Promise<void> {
  const w = rig.write;
  const now = Date.now();
  expectOk(
    w.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "分层依赖单向", digest: "import 只准外层指向内层\n违反即守护失败", scene: "测试场景", body: "依赖必须单向。\n- 外层可指向内层\n- 内层禁止反向依赖", status: "confirmed" } }), // TR-1
    w.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "写路径白名单", digest: "落盘写点收口清单", scene: "测试场景", status: "draft" } }), // TR-2
    w.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "会话实体", digest: "会话是聚根", scene: "测试场景", domain: "tech", status: "confirmed" } }), // E-1
    w.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "写路径守护乙", digest: "冲突对乙", scene: "测试场景", status: "confirmed" } }), // E-2
    w.write(rig.alpha, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "旧写路径规则", digest: "旧口径", scene: "测试场景", status: "confirmed" } }), // TR-3（被取代者）
  );
  // knowledge_change 载体：updateNode + declareAnchors + addEdge + supersede
  expectOk(
    w.write(rig.alpha, { kind: "updateNode", iterationId: ITER, nodeId: "TR-1", patch: { digest: "import 只准外层指向内层（修订版）" } }),
    w.write(rig.alpha, { kind: "declareAnchors", iterationId: ITER, nodeId: "TR-1", anchors: [{ scopeKind: "symbol", pattern: "src/arch.ts#layerRule" }] }),
    w.write(rig.alpha, { kind: "addEdge", iterationId: ITER, srcId: "TR-1", verb: "governs", dstId: "TR-2" }),
    w.write(rig.alpha, { kind: "supersede", iterationId: ITER, nodeId: "TR-3", reason: "写路径口径已演进", replacementNodeDraft: { kind: "rule", name: "新写路径规则", digest: "新口径" } }), // TR-4
  );
  // rule_conflict：E-1 ↔ E-2 双向 governs
  expectOk(
    w.write(rig.alpha, { kind: "addEdge", iterationId: ITER, srcId: "E-1", verb: "governs", dstId: "E-2" }),
    w.write(rig.alpha, { kind: "addEdge", iterationId: ITER, srcId: "E-2", verb: "governs", dstId: "E-1" }),
  );
  // 符号层首拍：真 sync 管道（triggerManual × fake 引擎）——TR-1 声明锚物化
  // （span 起点 11）+ lastSyncedAt 落位（syncedAt 面板字段数据源）
  await rig.sync.triggerManual(rig.alpha);
  // 补拍：TR-2 锚（src/write-path.ts，下拍后 dead）+ E-1 锚
  // （src/hot.ts 近期变更——回拨 updated_at 后 stale）
  rig.store.applySync(rig.alpha, batch({
    baseline: "2",
    files: [{ path: "src/write-path.ts", mtime: now - 1 * DAY, sha256: "w1" }],
    symbols: [
      { name: "allowWrite", kind: "function", spanStart: 1, spanEnd: 9, file: "src/write-path.ts" },
    ],
    materializedAnchors: [
      { nodeId: "TR-2", anchorPath: "src/write-path.ts", anchorSymbol: "allowWrite", anchorKind: "symbol" },
      { nodeId: "E-1", anchorPath: "src/hot.ts", anchorSymbol: "saveSession", anchorKind: "symbol" },
    ],
  }));
  // 符号层第二拍：write-path.ts 消亡 → TR-2 锚 orphan（dead）
  rig.store.applySync(rig.alpha, batch({
    baseline: "3",
    files: [{ path: "src/hot.ts", mtime: now - 1 * DAY, sha256: "h1" }],
    deletedFiles: ["src/write-path.ts"],
    orphanedAnchors: [{ nodeId: "TR-2", anchorPath: "src/write-path.ts", anchorSymbol: "allowWrite", anchorKind: "symbol" }],
  }));
  // E-1 知识滞后 10 天 × hot.ts 1 天前仍变更 → 活跃度启发命中（stale）
  rig.database
    .knowledgeConnection(rig.alpha)
    .prepare("UPDATE nodes SET updated_at = ? WHERE id = ?")
    .run(new Date(now - 10 * DAY).toISOString(), "E-1");
}

function seedBeta(rig: Rig): void {
  expectOk(
    rig.write.write(rig.beta, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "beta 专属实体", digest: "beta 域", scene: "测试场景", status: "confirmed" } }),
  );
}

function seedGamma(rig: Rig): void {
  // degraded 基准（engine unavailable docs-only 同构：degraded=true 落库）
  rig.store.applySync(rig.gamma, batch({ baseline: "g1", degraded: true }));
}

// ── 测试（顺序敏感：projects/list/detail/report 先于 confirm/rebuild 变异现场）──

describe("kg 六命令族 I 层（真 service 栈 + tmp 库 + ws 路由）", () => {
  test("kg.projects：宽松口径一层扫描 + 排除清单 + 四态行 + absent 不建库（A8）", async () => {
    const rig = await openRig();
    await seedAlpha(rig);
    seedBeta(rig);
    seedGamma(rig);
    // delta 保持 absent（无种子）

    const res = await rig.client.kg("kg.projects", {});
    expect(res.ok).toBe(true);
    const projects = res.result.projects as Record<string, unknown>[];
    // 排除清单生效：docs/.helix/.worktrees/node_modules/.hidden/文件项不入列；
    // 宽松口径：alpha/beta/gamma/delta 全入列（无工程标记要求）
    expect(projects.map((p) => p.name)).toEqual(["alpha", "beta", "delta", "gamma"]);
    const alpha = projects.find((p) => p.name === "alpha")!;
    expect(alpha.path).toBe(rig.alpha);
    expect(alpha.status).toBe("synced");
    expect(typeof alpha.symbolCount).toBe("number");
    expect(typeof alpha.nodeCount).toBe("number");
    expect(typeof alpha.syncedAt).toBe("string");
    expect(projects.find((p) => p.name === "gamma")!.status).toBe("degraded");
    expect(typeof projects.find((p) => p.name === "gamma")!.degradedNote).toBe("string");
    for (const absent of ["beta", "delta"]) {
      const row = projects.find((p) => p.name === absent)!;
      expect(row.status).toBe("absent");
      expect(row.symbolCount).toBeUndefined();
      expect(row.nodeCount).toBeUndefined();
    }
    // 只读（A8）：absent 项目不建库（读面绝不触发 KgDatabase 连接副作用；
    // beta 写路径已建库属正常——只对零触达的 delta 断言）
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(false);
  }, 15000);

  test("kg.list：三路过滤叠加 + total/matched + 跨项目不串（A1/A10 数据面）", async () => {
    const rig = rigs[0]!;
    const all = await rig.client.kg("kg.list", { project: "alpha" });
    expect(all.ok).toBe(true);
    // total=过滤前全集（6 节点：TR-1..4 + E-1/E-2）
    expect(all.result.total).toBe(6);
    expect(all.result.matched).toBe(6);
    const nodes = all.result.nodes as Record<string, unknown>[];
    const tr1 = nodes.find((n) => n.name === "分层依赖单向")!;
    // NodeListRow 逐字段（契约 §1）：id/name/kind/domain/status/digest
    expect(tr1.kind).toBe("rule");
    expect(tr1.status).toBe("confirmed");
    expect(tr1.domain).toBeNull();
    expect(tr1.digest).toBe("import 只准外层指向内层（修订版）");
    expect(typeof tr1.id).toBe("string");

    // 单路：q 命中 name/digest 子串（仅 TR-1 名含「依赖」）
    const q = await rig.client.kg("kg.list", { project: "alpha", q: "依赖" });
    expect(q.result.total).toBe(6);
    expect(q.result.matched).toBe(1);
    const qNames = (q.result.nodes as Record<string, unknown>[]).map((n) => n.name);
    expect(qNames).toEqual(["分层依赖单向"]);

    // 单路：kind=entity（E-1/E-2）
    const byKind = await rig.client.kg("kg.list", { project: "alpha", kind: "entity" });
    expect(byKind.result.matched).toBe(2);
    expect((byKind.result.nodes as Record<string, unknown>[]).every((n) => n.kind === "entity")).toBe(true);

    // 单路：status=draft（TR-2 + supersede 替换稿 TR-4——替换稿缺省 draft）
    const byStatus = await rig.client.kg("kg.list", { project: "alpha", status: "draft" });
    expect(byStatus.result.matched).toBe(2);
    expect((byStatus.result.nodes as Record<string, unknown>[]).map((n) => n.name)).toEqual(["写路径白名单", "新写路径规则"]);

    // 三路叠加：q=白名单 × kind=rule × status=draft → TR-2 唯一
    const combined = await rig.client.kg("kg.list", { project: "alpha", q: "白名单", kind: "rule", status: "draft" });
    expect(combined.result.total).toBe(6);
    expect(combined.result.matched).toBe(1);
    expect((combined.result.nodes as Record<string, unknown>[])[0]!.name).toBe("写路径白名单");

    // project 作用域（A10）：beta 只见自身节点，alpha 节点不串入
    //（beta 写路径已建库——baseline 未落 → 四态仍 absent；隔离断言取正向行集）
    const beta = await rig.client.kg("kg.list", { project: "beta" });
    expect(beta.ok).toBe(true);
    expect(beta.result.matched).toBe(1);
    expect((beta.result.nodes as Record<string, unknown>[]).map((n) => n.name)).toEqual(["beta 专属实体"]);
    // absent 项目读命令短路：delta 无库 → KG_E_NOT_FOUND（读面绝不新建库文件）
    const absentRead = await rig.client.kg("kg.list", { project: "delta" });
    expect(absentRead.ok).toBe(false);
    expect(absentRead.error!.code).toBe("KG_E_NOT_FOUND");
  }, 15000);

  test("kg.node.detail：聚合（body 原文单段/anchors dead-stale-ok/relations/supersede 链/log 最新在上）（A2）", async () => {
    const rig = rigs[0]!;
    const res = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-1" });
    expect(res.ok).toBe(true);
    const d = res.result;
    // 头部段
    expect(d.name).toBe("分层依赖单向");
    expect(d.kind).toBe("rule");
    expect(d.status).toBe("confirmed");
    // body 单段：原文直返不拆分（拆分逻辑已删除）
    expect(d.body).toBe("依赖必须单向。\n- 外层可指向内层\n- 内层禁止反向依赖");
    expect("desc" in d).toBe(false);
    expect("rules" in d).toBe(false);
    // 锚点段：TR-1 唯一符号锚（声明物化，span 起点 11）
    const anchors = d.anchors as Record<string, unknown>[];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.symbol).toBe("layerRule");
    expect(anchors[0]!.path).toBe("src/arch.ts");
    expect(anchors[0]!.line).toBe(11);
    expect(anchors[0]!.state).toBe("ok");
    // 关系段：TR-1 governs TR-2（对方节点引用可跳转）
    const relations = d.relations as { verb: string; peer: Record<string, unknown> }[];
    expect(relations).toHaveLength(1);
    expect(relations[0]!.verb).toBe("governs");
    expect(relations[0]!.peer.name).toBe("写路径白名单");
    expect(relations[0]!.peer.id).toBe("TR-2");
    expect(typeof relations[0]!.peer.digestFirstLine).toBe("string");

    // 锚态谱：TR-2 detail → dead；E-1 detail → stale（活跃度启发命中）
    const dead = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-2" });
    expect(((dead.result.anchors as Record<string, unknown>[])[0] as { state: string }).state).toBe("dead");
    const stale = await rig.client.kg("kg.node.detail", { project: "alpha", id: "E-1" });
    expect(((stale.result.anchors as Record<string, unknown>[])[0] as { state: string }).state).toBe("stale");

    // supersede 链：被取代者 TR-3 → current=新规则 TR-4，history=[TR-3]
    const old = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-3" });
    const chain = old.result.supersede as { history: Record<string, unknown>[]; current: Record<string, unknown> };
    expect(chain.current.name).toBe("新写路径规则");
    expect(chain.history.map((n) => n.name)).toEqual(["旧写路径规则"]);

    // 变更日志段：TR-3 两条（createNode → supersede），最新在上
    const log = old.result.log as { date: string; iterationId: string; eventText: string }[];
    expect(log).toHaveLength(2);
    expect(log[0]!.eventText).toBe("推翻：写路径口径已演进");
    expect(log[1]!.eventText).toBe("创建节点（新知识入库）");
    expect(log[0]!.iterationId).toBe(ITER);
    expect(log[0]!.date >= log[1]!.date).toBe(true);
    // AD-16：eventText 无 TR-/E- 裸 id
    for (const entry of log) expect(entry.eventText).not.toMatch(/TR-\d+|E-\d+/);

    // 不存在 id → KG_E_NOT_FOUND
    const missing = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-999" });
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("KG_E_NOT_FOUND");
  }, 15000);

  test("kg.change.report：四类条目结构（A3 数据面）", async () => {
    const rig = rigs[0]!;
    const res = await rig.client.kg("kg.change.report", { project: "alpha" });
    expect(res.ok).toBe(true);
    expect(res.result.iterationId as string).toBe(ITER); // 缺省 = 当前迭代（库内最近变更所属）
    const entries = res.result.entries as Record<string, unknown>[];
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds.has("dead_anchor")).toBe(true); // TR-2 write-path.ts 消亡
    expect(kinds.has("rule_conflict")).toBe(true); // E-1 ↔ E-2 双向 governs
    expect(kinds.has("suspect_stale")).toBe(true); // E-1 滞后 10 天 × 近期变更
    expect(kinds.has("knowledge_change")).toBe(true); // 五 op 全谱
    for (const e of entries) {
      expect(["warn", "info", "ok"]).toContain(e.sev as string);
      expect(typeof e.label).toBe("string");
      expect(typeof e.body).toBe("string");
      expect("options" in e).toBe(false); // 报告=通知面非审核面：无行动项字段
      const refs = e.refs as { nodes: Record<string, unknown>[]; symbols: Record<string, unknown>[] };
      for (const n of refs.nodes) {
        expect(typeof n.name).toBe("string");
        expect(typeof n.digestFirstLine).toBe("string");
      }
      for (const s of refs.symbols) expect(typeof s.path).toBe("string");
      expect(String(e.body)).not.toMatch(/TR-\d+|E-\d+/); // AD-16 无裸 id
    }
    // 显式 iterationId 形态
    const explicit = await rig.client.kg("kg.change.report", { project: "alpha", iterationId: ITER });
    expect(explicit.result.iterationId).toBe(ITER);
  }, 15000);

  test("kg.node.detail 变更日志行主锚切 task_id（P0 ④）：task 章在场下发；无迭代归属行 iterationId 下发 null", async () => {
    const rig = rigs[0]!;
    // 无迭代归属（NULL）+ 带 task 章的写入（去 v1 化后的常态形态）——置于
    // report 默认迭代断言之后（顺序敏感现场，不扰动其 latestIteration 取值）
    expectOk(
      rig.write.write(rig.alpha, {
        kind: "createNode",
        iterationId: null,
        taskId: "task-anchor-primary",
        draft: { kind: "rule", name: "无迭代归属规则", digest: "无锚摘要", scene: "测试场景", status: "confirmed" },
      }),
    );
    const res = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-5" });
    expect(res.ok).toBe(true);
    const log = res.result.log as { date: string; iterationId: string | null; taskId?: string | null; eventText: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]!.iterationId).toBe(null); // 空不展示（前端条件渲染）；非空照旧（历史行兼容）
    expect(log[0]!.taskId).toBe("task-anchor-primary"); // 主锚切 task_id
    // 历史行（有迭代无任务）照旧：iterationId 字符串 + taskId 空缺省
    const old = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-1" });
    const oldLog = old.result.log as { iterationId: string | null; taskId?: string | null }[];
    expect(oldLog[0]!.iterationId).toBe(ITER);
    expect(oldLog[0]!.taskId == null).toBe(true);
  }, 15000);

  test("kg.node.confirm：唯一写命令走 F2.3 API + change_log 追加 + 非 draft KG_E_STATE（A4）", async () => {
    const rig = rigs[0]!;
    const before = knowledgeCounts(rig, rig.alpha);
    const logBefore = rig.database
      .knowledgeConnection(rig.alpha)
      .prepare("SELECT reason FROM change_log WHERE node_id = ? ORDER BY seq")
      .all("TR-2") as { reason: string | null }[];

    const res = await rig.client.kg("kg.node.confirm", { project: "alpha", id: "TR-2" });
    expect(res.ok).toBe(true);
    expect(res.result.applied).toBe(true);
    expect((res.result.node as Record<string, unknown>).status).toBe("confirmed");

    // 唯一写路径（A4）：nodes +1 零（改状态不改行数）、edges 零变化、
    // change_log 恰 +1（审计行——F2.3 API 面的库内痕迹）
    const after = knowledgeCounts(rig, rig.alpha);
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.log).toBe(before.log + 1);
    const logAfter = rig.database
      .knowledgeConnection(rig.alpha)
      .prepare("SELECT reason FROM change_log WHERE node_id = ? ORDER BY seq")
      .all("TR-2") as { reason: string | null }[];
    expect(logAfter).toHaveLength(logBefore.length + 1);
    expect(logAfter[logAfter.length - 1]!.reason).toContain("草稿转正（页面人工确认）");

    // detail log 可见同一审计行（eventText 叙述）
    const detail = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-2" });
    const top = (detail.result.log as { eventText: string }[])[0]!;
    expect(top.eventText).toBe("更新节点内容：草稿转正（页面人工确认）");

    // 非 draft → KG_E_STATE（confirmed 复转）
    const again = await rig.client.kg("kg.node.confirm", { project: "alpha", id: "TR-2" });
    expect(again.ok).toBe(false);
    expect(again.error!.code).toBe("KG_E_STATE");
    // superseded → 同 KG_E_STATE
    const superseded = await rig.client.kg("kg.node.confirm", { project: "alpha", id: "TR-3" });
    expect(superseded.ok).toBe(false);
    expect(superseded.error!.code).toBe("KG_E_STATE");
    // 不存在 → KG_E_NOT_FOUND
    const missing = await rig.client.kg("kg.node.confirm", { project: "alpha", id: "TR-999" });
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("KG_E_NOT_FOUND");
  }, 15000);

  test("kg.index.status：四态透传 + rebuild building + 知识层零写 + absent 冷启动（A5/A9）", async () => {
    const rig = rigs[0]!;

    // 四态之 synced/degraded（absent 见 delta；building 见下）
    const synced = await rig.client.kg("kg.index.status", { project: "alpha" });
    expect(synced.ok).toBe(true);
    expect(synced.result.state).toBe("synced");
    expect(typeof synced.result.symbolCount).toBe("number");
    expect(typeof synced.result.syncedAt).toBe("string");
    const degraded = await rig.client.kg("kg.index.status", { project: "gamma" });
    expect(degraded.result.state).toBe("degraded");
    expect(typeof degraded.result.degradedNote).toBe("string");

    // absent：delta 无库 → absent 且不建库（读面短路）
    const absent = await rig.client.kg("kg.index.status", { project: "delta" });
    expect(absent.result.state).toBe("absent");
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(false);

    // rebuild=true：触发即 building（引擎 delayMs=150×2 制造窗口；O-6 同通道
    // 并发轮询观察——rebuild 请求自身在完成后才回 synced 帧）
    const before = knowledgeCounts(rig, rig.alpha);
    const at = rig.client.frames.length;
    rig.client.fireAndForget("kg.index.status", { project: "alpha", rebuild: true });
    let sawBuilding = false;
    const t0 = Date.now();
    while (!sawBuilding && Date.now() - t0 < 3000) {
      rig.client.send({ v: PROTOCOL_VERSION, type: "kg.index.status", payload: { project: "alpha" } });
      await new Promise((r) => setTimeout(r, 30));
      sawBuilding = rig.client.frames
        .slice(at)
        .some((f) => f.type === "kg.index.status.result" && (f.payload as { state?: string }).state === "building");
    }
    expect(sawBuilding).toBe(true);
    await until(
      () =>
        rig.client.frames
          .slice(at)
          .some((f) => f.type === "kg.index.status.result" && (f.payload as { state?: string }).state === "synced"),
      5000,
      "rebuild 完成后状态回落 synced",
    );
    // 知识层零写（A5：纯 codegraph 动作——nodes/edges/change_log 全零变化）
    const after = knowledgeCounts(rig, rig.alpha);
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.log).toBe(before.log);

    // absent 冷启动（A9/B1）：delta 零触达无库 rebuild → 同一入口首次构建。
    // 构建期间无 rebuild 轮询必须回 building（修复前轮询只会回 absent）——
    // fireAndForget + 并发轮询同 alpha 段写法。（注：不断言观察时库不存在——
    // sync 管道起点 getSyncBaseline 开连接即建库，building 可观察时 kg.db 已
    // 落盘；A8 不建库面由 rebuild 前 absent 断言守护）
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(false);
    const coldAt = rig.client.frames.length;
    rig.client.fireAndForget("kg.index.status", { project: "delta", rebuild: true });
    let sawColdBuilding = false;
    const coldT0 = Date.now();
    while (!sawColdBuilding && Date.now() - coldT0 < 3000) {
      rig.client.send({ v: PROTOCOL_VERSION, type: "kg.index.status", payload: { project: "delta" } });
      await new Promise((r) => setTimeout(r, 30));
      sawColdBuilding = rig.client.frames
        .slice(coldAt)
        .some((f) => f.type === "kg.index.status.result" && (f.payload as { state?: string }).state === "building");
    }
    expect(sawColdBuilding).toBe(true);
    // 冷启动完成：rebuild 回执 synced + 库出现（不依赖 CLI 预建——引擎面即全部前置）
    await until(
      () =>
        rig.client.frames
          .slice(coldAt)
          .some((f) => f.type === "kg.index.status.result" && (f.payload as { state?: string }).state === "synced"),
      5000,
      "delta 冷启动 rebuild 完成后回执 synced",
    );
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(true);
  }, 20000);

  test("kg.index.status：building 判定先于 absent 短路（冷启动库未创建窗口）+ 纯内存不触读库", async () => {
    // 服务层直测：真栈 sync 起点 getSyncBaseline 开连接即建库（与 running
    // 同步窗口），集成面造不出「building 且 hasIndex=false」——该竞态域用
    // stub 钉死。修复前此路径回 absent（hasIndex 短路先于 building 判定）
    let getStatusCalls = 0;
    let building = true;
    const syncStub = {
      isBuilding: () => building,
      getStatus: () => {
        getStatusCalls += 1;
        throw new Error("building/absent 短路不得触 getStatus（触库连接即建库，A8）");
      },
      triggerManual: () => Promise.reject(new Error("非 rebuild 面不得触发 sync")),
    };
    const viewer = new KgViewerService({
      project: {
        resolve: () => "/proj",
        hasIndex: () => false, // 库文件尚未创建（冷启动首建窗口）
      } as unknown as KgProjectService,
      sync: syncStub,
    } as unknown as KgViewerServiceDeps);

    // 构建进行中 + 无库 → building（先于 absent 短路），且不触 getStatus
    const during = await viewer.indexStatus("proj", false);
    expect(during).toEqual({ ok: true, value: { state: "building" } });
    expect(getStatusCalls).toBe(0);

    // 无构建进行 + 无库 → absent 且不触 getStatus（A8 读面不建库不回归）
    building = false;
    const idle = await viewer.indexStatus("proj", false);
    expect(idle).toEqual({ ok: true, value: { state: "absent" } });
    expect(getStatusCalls).toBe(0);
  });

  test("project 参数两形态等价 + 无法解析 KG_E_PARAM + 错误回执结构化（A10）", async () => {
    const rig = rigs[0]!;
    // 名称形态 ≡ 绝对路径形态
    const byName = await rig.client.kg("kg.list", { project: "alpha", kind: "entity" });
    const byPath = await rig.client.kg("kg.list", { project: rig.alpha, kind: "entity" });
    expect(byPath.ok).toBe(true);
    expect(byPath.result.matched).toBe(byName.result.matched);

    // 无法解析（不在项目列表）→ KG_E_PARAM + 字段路径（结构化回执）
    const bad = await rig.client.kg("kg.list", { project: "no-such-project" });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("KG_E_PARAM");
    expect(bad.error!.message).toContain("payload.project");
    expect(bad.error!.message).toContain("no-such-project");

    // project 缺失 → KG_E_PARAM（形状校验在 handler 入口）
    const missing = await rig.client.kg("kg.list", { kind: "rule" });
    expect(missing.error!.code).toBe("KG_E_PARAM");

    // 过滤值越界 → KG_E_PARAM（service 枚举校验 + path）
    const badKind = await rig.client.kg("kg.list", { project: "alpha", kind: "dragon" });
    expect(badKind.error!.code).toBe("KG_E_PARAM");
    expect(badKind.error!.message).toContain("payload.kind");

    // rebuild 非法类型 → KG_E_PARAM
    const badRebuild = await rig.client.kg("kg.index.status", { project: "alpha", rebuild: "yes" });
    expect(badRebuild.error!.code).toBe("KG_E_PARAM");
  }, 15000);

  test("unimplemented 门控：kg 栈未装配六命令回 command.unimplemented（不崩溃）", async () => {
    const events = new EventStream();
    const adapter = new WsServerAdapter({ ...stubAdapterDeps(events) }); // 无 kg 面
    const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kg-it-token", protocolVersion: PROTOCOL_VERSION } });
      await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
      for (const type of [
        "kg.projects",
        "kg.list",
        "kg.node.detail",
        "kg.change.report",
        "kg.node.confirm",
        "kg.index.status",
      ]) {
        const res = await client.kg(type, { project: "x", id: "TR-1" });
        expect(res.ok).toBe(false);
        expect(res.error!.code).toBe("command.unimplemented");
        expect(res.error!.message).toContain(type); // 回执文案含命令名（commandError 通则）
      }
    } finally {
      adapter.stop();
      await client.close();
    }
  }, 15000);

  test("容器接线：kgWorkspaceRoot 注入 + 真组合根 kg.projects roundtrip", async () => {
    // 独立 workspace：若 kgWorkspaceRoot 接线失效（回落 process.cwd()），
    // kg.projects 会列出 daemon 测试 cwd 的真实目录而非 [kappa]——注入面断言。
    const workspace = mkdtempSync(path.join(tmpdir(), "helix-kg-container-"));
    mkdirSync(path.join(workspace, "kappa"), { recursive: true });
    mkdirSync(path.join(workspace, "docs"), { recursive: true });
    const home = mkdtempSync(path.join(tmpdir(), "helix-kg-container-home-"));
    const daemon = await createTestDaemon({
      home,
      engine: new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5", replies: [] }),
      skipConfig: true,
      skipLock: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      kgWorkspaceRoot: workspace,
    });
    const client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
    try {
      await client.open();
      const token = readFileSync(path.join(home, "dev-token"), "utf8");
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
      await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
      const res = await client.kg("kg.projects", {});
      expect(res.ok).toBe(true);
      expect((res.result.projects as Record<string, unknown>[]).map((p) => p.name)).toEqual(["kappa"]);
      expect((res.result.projects as Record<string, unknown>[])[0]!.status).toBe("absent");
    } finally {
      await client.close();
      await daemon.shutdown();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

// ── kg.health（W2-E 轨一结构体检看板；设计 D5 + R15；五项读面只读聚合） ──

describe("kg.health I 层（真 service 栈 + tmp 库 + ws 路由）", () => {
  test("有问题径：conflicts/orphans/orphanCount/index/candidates 五面聚合 + summary 人读无裸 id", async () => {
    const rig = await openRig();
    await seedAlpha(rig);
    // candidates 台账种子：3 提案 → 1 deferred + 1 applied（计数来自 candidates 表）
    expectOk(
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选甲" }),
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选乙" }),
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选丙" }),
    );
    expectOk(
      rig.write.write(rig.alpha, { kind: "decideCandidate", iterationId: ITER, candidateId: "CAND-2", decision: "deferred" }),
      rig.write.write(rig.alpha, { kind: "decideCandidate", iterationId: ITER, candidateId: "CAND-3", decision: "applied", formalId: "TR-88", appliedNodeId: "TR-1" }),
    );

    const res = await rig.client.kg("kg.health", { project: "alpha" });
    expect(res.ok).toBe(true);
    // ① conflicts：E-1 ↔ E-2 双向 governs（种子唯一冲突对）
    const conflicts = res.result.conflicts as { kind: string; summary: string }[];
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("mutual_governs");
    expect(conflicts[0]!.summary).toContain("会话实体");
    expect(conflicts[0]!.summary).toContain("写路径守护乙");
    // ② orphans：TR-2 死锚（write-path.ts 消亡）+ TR-3 orphan_node（superseded
    // 留史节点无锚无边——orphan_node 口径不排除 superseded）；orphanCount = 清单长度
    const orphans = res.result.orphans as { kind: string; summary: string }[];
    expect(orphans).toHaveLength(2);
    expect(orphans[0]!.kind).toBe("dead_anchor");
    expect(orphans[0]!.summary).toContain("写路径白名单");
    expect(orphans[1]!.kind).toBe("orphan_node");
    expect(orphans[1]!.summary).toContain("旧写路径规则");
    expect(res.result.orphanCount).toBe(2);
    // AD-16：summary 人读叙述无裸 id
    for (const c of conflicts) expect(c.summary).not.toMatch(/TR-\d+|E-\d+/);
    for (const o of orphans) expect(o.summary).not.toMatch(/TR-\d+|E-\d+/);
    // ③ index：kg.index.status 数据复用（alpha 已同步）
    const index = res.result.index as Record<string, unknown>;
    expect(index.state).toBe("synced");
    expect(typeof index.symbolCount).toBe("number");
    // ④ candidates：四态计数来自 candidates 表（pending 1 / deferred 1 / applied 1）
    expect(res.result.candidates).toEqual({ pending: 1, deferred: 1, applied: 1, discarded: 0 });
  }, 15000);

  test("无问题径：结构健康空态 + absent 短路空态不建库 + project 无法解析 KG_E_PARAM", async () => {
    const rig = await openRig();
    // epsilon：两节点 + 一条边（双方有边非孤儿、无冲突、无候选——健康空态载体）
    const epsilon = path.join(rig.workspace, "epsilon");
    mkdirSync(epsilon, { recursive: true });
    expectOk(
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "甲规则", digest: "d1", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "乙实体", digest: "d2", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "addEdge", iterationId: ITER, srcId: "TR-1", verb: "governs", dstId: "E-1" }),
    );
    const healthy = await rig.client.kg("kg.health", { project: "epsilon" });
    expect(healthy.ok).toBe(true);
    expect(healthy.result.conflicts).toEqual([]);
    expect(healthy.result.orphans).toEqual([]);
    expect(healthy.result.orphanCount).toBe(0);
    expect(healthy.result.candidates).toEqual({ pending: 0, deferred: 0, applied: 0, discarded: 0 });
    expect(typeof (healthy.result.index as Record<string, unknown>).state).toBe("string");

    // absent 短路：delta 零触达 → 空态（非报错）+ index.state=absent + 不建库
    const absent = await rig.client.kg("kg.health", { project: "delta" });
    expect(absent.ok).toBe(true);
    expect(absent.result.conflicts).toEqual([]);
    expect(absent.result.orphans).toEqual([]);
    expect(absent.result.orphanCount).toBe(0);
    expect((absent.result.index as Record<string, unknown>).state).toBe("absent");
    expect(absent.result.candidates).toEqual({ pending: 0, deferred: 0, applied: 0, discarded: 0 });
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(false);

    // project 无法解析 → KG_E_PARAM（service 单点解析错误模型同族）
    const bad = await rig.client.kg("kg.health", { project: "no-such-project" });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("KG_E_PARAM");
    // project 缺失 → KG_E_PARAM（handler 形状校验）
    const missing = await rig.client.kg("kg.health", {});
    expect(missing.error!.code).toBe("KG_E_PARAM");
  }, 15000);

  test("unimplemented 门控：kg 栈未装配 kg.health 回 command.unimplemented（不崩溃）", async () => {
    const events = new EventStream();
    const adapter = new WsServerAdapter({ ...stubAdapterDeps(events) }); // 无 kg 面
    const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kg-it-token", protocolVersion: PROTOCOL_VERSION } });
      await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
      const res = await client.kg("kg.health", { project: "x" });
      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("command.unimplemented");
    } finally {
      adapter.stop();
      await client.close();
    }
  }, 15000);
});

// ── W2-D R14：手动 sync 后 orphan>0 随行体检提示行（只提示不处置） ──

describe("kg.index.status rebuild 随行 orphanNote（W2-D R14）", () => {
  test("orphan>0 项目 rebuild 回执附体检行；非 rebuild 读面不带；健康项目 rebuild 不带", async () => {
    const rig = await openRig();
    await seedAlpha(rig);

    // alpha：TR-2 死锚（write-path.ts 消亡）——rebuild 回执带 orphanNote
    const res = await rig.client.kg("kg.index.status", { project: "alpha", rebuild: true }, 15000);
    expect(res.ok).toBe(true);
    expect(res.result.state).toBe("synced");
    expect(typeof res.result.orphanNote).toBe("string");
    expect(res.result.orphanNote as string).toContain("体检提示");
    // rebuild 后机械口径 3 处：TR-2 死锚 + E-1 锚随全量重建转 dead + TR-3 orphan_node
    expect(res.result.orphanNote as string).toContain("3 处");

    // 非 rebuild 读面不带 orphanNote（R14 只挂手动 sync 面）
    const plain = await rig.client.kg("kg.index.status", { project: "alpha" });
    expect(plain.result.state).toBe("synced");
    expect(plain.result.orphanNote).toBeUndefined();

    // 健康项目（epsilon：两节点 + 一条边——双方有边非孤儿）→ rebuild 不带 orphanNote
    const epsilon = path.join(rig.workspace, "epsilon");
    mkdirSync(epsilon, { recursive: true });
    expectOk(
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "甲规则", digest: "d1", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "乙实体", digest: "d2", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "addEdge", iterationId: ITER, srcId: "TR-1", verb: "governs", dstId: "E-1" }),
    );
    const healthy = await rig.client.kg("kg.index.status", { project: "epsilon", rebuild: true }, 15000);
    expect(healthy.result.state).toBe("synced");
    expect(healthy.result.orphanNote).toBeUndefined();
  }, 20000);
});
