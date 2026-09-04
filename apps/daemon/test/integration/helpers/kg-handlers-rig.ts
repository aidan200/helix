import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { WsServerAdapter } from "../../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../../src/adapters/driving/ws-server/EventStream";
import { StubBrowserPort } from "../../mocks/StubBrowserPort";
import { KgDatabase, kgDbPath } from "../../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { CodegraphEngineFake } from "../../mocks/CodegraphEngineFake";
import { KgProjectService } from "../../../src/application/services/kg/KgProjectService";
import { KgReportService } from "../../../src/application/services/kg/KgReportService";
import { KgSyncService } from "../../../src/application/services/kg/KgSyncService";
import { KgVerifyService } from "../../../src/application/services/kg/KgVerifyService";
import { KgViewerService, type KgViewerServiceDeps } from "../../../src/application/services/kg/KgViewerService";
import { KgWriteService } from "../../../src/application/services/kg/KgWriteService";
import { scanProjectEntries } from "../../../src/adapters/driven/workspace-scan";
import type { EngineSymbol, SymbolBatch, WriteResult } from "../../../src/domain/kg/types";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * kg-handlers I 层共享 rig（kg-handlers.test.ts / kg-handlers-health.test.ts
 * 双文件共用；拆分动因 = TR-AD-25 ④ 单文件 >1000 行 fail 档越线）。
 *
 * 装配语义见 kg-handlers.test.ts 头注——本文件只做装配与导出，零断言。
 * createRigScope 工厂化（每测试文件独立 scope + 自注册 afterAll），
 * 避免模块级 rigs 数组跨文件串扰。
 */

export const DAY = 86_400_000;
export const ITER = "iter-20260825-11fo";

export interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

/** 收集帧的 loopback WS 测试客户端（ws-server-spy.test.ts 同构）。 */
export class TestClient {
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

export async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── rig：workspace + 真 service 栈 + WsServerAdapter ─────────────

export interface Rig {
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
export function stubAdapterDeps(events: EventStream) {
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
      setThinkingDefault: async () => ({ previous: null }), setDefault: async () => {
        throw new Error("stub");
      },
      getDefault: () => ({ model: "stub/model", thinkingDefault: null }),
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
      modelSlot: () => undefined, thinkingSlot: () => undefined, clearThinkingSlot: async () => {
        throw new Error("stub");
      },
    },
    hasModel: () => false,
      kgWriterPinnedTools: ["kg-update"],
      reviewerRemovedTools: ["write", "edit"], // D5 第五 kind 派生面（WsServerAdapter 必填注入）
      basePrompts: {},
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

export function expectOk(...results: WriteResult[]): void {
  for (const r of results) {
    if (!r.ok) throw new Error(`知识层写失败：${r.error.code} ${r.error.message}`);
  }
}

/** 知识层表行数（nodes/edges/change_log——rebuild 零知识层写断言载体）。 */
export function knowledgeCounts(rig: Rig, projectRoot: string): { nodes: number; edges: number; log: number } {
  const db = rig.database.knowledgeConnection(projectRoot);
  const one = (sql: string): number =>
    Number((db.query(sql).get() as { c: number | bigint }).c);
  return {
    nodes: one("SELECT COUNT(*) AS c FROM nodes"),
    edges: one("SELECT COUNT(*) AS c FROM edges"),
    log: one("SELECT COUNT(*) AS c FROM change_log"),
  };
}

export interface RigScope {
  readonly openRig: () => Promise<Rig>;
  readonly disposeAll: () => void;
  /** 已建 rig 台账（顺序敏感测试共享首 rig：rigs[0]，原单文件模块级语义平移）。 */
  readonly rigs: Rig[];
}

/** 每测试文件一个 scope：openRig 建 rig 并登记，disposeAll 由文件自注册 afterAll 调。 */
export function createRigScope(): RigScope {
  const rigs: Rig[] = [];
  const openRig = async (): Promise<Rig> => {
    const rig = makeRig();
    rigs.push(rig);
    await rig.client.open();
    rig.client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kg-it-token", protocolVersion: PROTOCOL_VERSION } });
    await until(() => rig.client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
    return rig;
  };
  const disposeAll = (): void => {
    for (const r of rigs) r.dispose();
    rigs.length = 0;
  };
  return { openRig, disposeAll, rigs };
}

// ── 种子（真 sync 管道首拍 + applySync 补拍；详见各断言注释） ──────

export async function seedAlpha(rig: Rig): Promise<void> {
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

export function seedBeta(rig: Rig): void {
  expectOk(
    rig.write.write(rig.beta, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "beta 专属实体", digest: "beta 域", scene: "测试场景", status: "confirmed" } }),
  );
}

export function seedGamma(rig: Rig): void {
  // degraded 基准（engine unavailable docs-only 同构：degraded=true 落库）
  rig.store.applySync(rig.gamma, batch({ baseline: "g1", degraded: true }));
}
