import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KgSyncService } from "../../src/application/services/kg/KgSyncService";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { EngineSymbol, WriteResult } from "../../src/domain/kg/types";
import { CodegraphEngineFake } from "../mocks/CodegraphEngineFake";

/**
 * KgSyncService 集成管道（tmp 真库 + T2.1 引擎 fake）：四步单事务全链路。
 * 覆盖 CL-2.A1（冷启动首建）/A2（degraded docs-only）/A3（物化）/
 * A4+A6（增量跳过+基准戳）/A7（符号消亡 orphan）/A8（contains 入库）。
 * applySync 中途故障原子性由 kg-atomicity.test.ts ③ 直接覆盖（同事务面）。
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

interface Stack {
  root: string;
  store: SqliteKnowledgeStore;
  graph: SqliteKnowledgeGraph;
  engine: CodegraphEngineFake;
  service: KgSyncService;
  write: KgWriteService;
  dispose: () => void;
}

function makeStack(engineOpts: { unavailable?: boolean; delayMs?: number } = {}): Stack {
  const root = mkdtempSync(path.join(tmpdir(), "kg-sync-it-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const engine = new CodegraphEngineFake(engineOpts);
  const service = new KgSyncService({ store, graph, engine, debounceMs: 10, retryBackoffMs: 5 });
  const write = new KgWriteService({ store });
  return {
    root,
    store,
    graph,
    engine,
    service,
    write,
    dispose: () => {
      service.dispose();
      database.closeAll();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const stacks: Stack[] = [];
afterAll(() => {
  for (const s of stacks) s.dispose();
  stacks.length = 0;
});

function expectOk(r: WriteResult): string {
  if (!r.ok) throw new Error(`知识层写失败：${r.error.code} ${r.error.message}`);
  if (r.nodeId === undefined) throw new Error("ok 结果缺 nodeId（意外形态）");
  return r.nodeId;
}

function healthyFixture(): { symbols: EngineSymbol[]; containsEdges: { containerId: string; symbolId: string }[]; files: { path: string; contentHash: string; modifiedAt: number; indexedAt: number }[] } {
  return {
    symbols: [
      engineSymbol("file:src/app.ts", "src/app.ts", "src/app.ts", "file", 1, 40),
      engineSymbol("fn:1", "main", "src/app.ts", "function", 1, 20),
      engineSymbol("cls:1", "Handler", "src/app.ts", "class", 22, 38),
      engineSymbol("m:1", "handle", "src/app.ts", "method", 24, 36),
    ],
    containsEdges: [
      { containerId: "file:src/app.ts", symbolId: "fn:1" },
      { containerId: "cls:1", symbolId: "m:1" },
    ],
    files: [{ path: "src/app.ts", contentHash: "hash-v1", modifiedAt: 1000, indexedAt: 1000 }],
  };
}

describe("KgSyncService 集成管道（tmp 真库）", () => {
  test("① 冷启动首建（CL-2.A1）：.helix-kg 缺失 → onStartup 全量导入，知识层空=纯符号层合法，状态 synced", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const result = await s.service.onStartup(s.root);
    expect(existsSync(kgDbPath(s.root))).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.importedFiles).toBe(1);
    // 知识层空合法：nodes 零行、符号层已就位
    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(0);
      expect((db.query("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n).toBe(3); // file 伪行被过滤
      expect((db.query("SELECT value FROM meta WHERE key='sync:baseline'").get() as { value: string }).value).toBe(result.baseline);
    } finally {
      db.close();
    }
    expect(s.service.getStatus(s.root)).toMatchObject({ phase: "synced", symbolCount: 3, degraded: false });
  });

  test("② 三级作用域物化（CL-2.A3）+ contains 边入库可查（CL-2.A8）", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    // 知识层：global（不物化）/ path / symbol 三类声明
    const node = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "rule", name: "r1", digest: "d1", scene: "测试场景" },
    }));
    const symNode = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "e1", digest: "d1", scene: "测试场景" },
    }));
    expectOk(s.write.write(s.root, {
      kind: "declareAnchors",
      iterationId: "it",
      nodeId: node,
      anchors: [
        { scopeKind: "global" },
        { scopeKind: "path", pattern: "src/**" },
      ],
    }));
    expectOk(s.write.write(s.root, {
      kind: "declareAnchors",
      iterationId: "it",
      nodeId: symNode,
      anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#Handler" }],
    }));
    await s.service.onStartup(s.root);
    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      const anchors = db.query("SELECT node_id, anchor_kind, anchor_path, anchor_symbol, orphan FROM materialized_anchors ORDER BY anchor_path").all() as Record<string, unknown>[];
      expect(anchors).toEqual([
        { node_id: symNode, anchor_kind: "symbol", anchor_path: "src/app.ts", anchor_symbol: "Handler", orphan: 0 },
        { node_id: node, anchor_kind: "path", anchor_path: "src/app.ts", anchor_symbol: "", orphan: 0 },
      ]);
      const contains = db.query("SELECT file, outer_symbol, inner_symbol FROM contains_edges ORDER BY outer_symbol").all() as Record<string, string>[];
      expect(contains).toEqual([
        { file: "src/app.ts", outer_symbol: "Handler", inner_symbol: "handle" }, // 类含方法
        { file: "src/app.ts", outer_symbol: "src/app.ts", inner_symbol: "main" }, // 文件容器：outer=路径
      ]);
    } finally {
      db.close();
    }
  });

  test("③ 引擎不可用 → degraded + docs-only 锚；恢复后下次 sync 正常（CL-2.A2）", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const node = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "rule", name: "r1", digest: "d1", scene: "测试场景" },
    }));
    const symNode = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "e1", digest: "d1", scene: "测试场景" },
    }));
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: node, anchors: [{ scopeKind: "path", pattern: "src/**" }] }));
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: symNode, anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#Handler" }] }));
    await s.service.onStartup(s.root); // 健康首建：path+symbol 锚均在册

    s.engine.setUnavailable(true);
    const degradedResult = await s.service.triggerManual(s.root);
    expect(degradedResult.degraded).toBe(true);
    expect(s.service.getStatus(s.root).phase).toBe("degraded");
    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      // docs-only：degraded sync 不清符号层、不做 orphan diff（滞后合法）
      expect((db.query("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n).toBe(3);
      expect((db.query("SELECT COUNT(*) AS n FROM materialized_anchors WHERE orphan=0 AND anchor_kind='symbol'").get() as { n: number }).n).toBe(1);
      expect((db.query("SELECT value FROM meta WHERE key='sync:degraded'").get() as { value: string }).value).toBe("1");
    } finally {
      db.close();
    }
    // 附着不依赖新鲜度：degraded 态下附着快照照常可读（滞后合法，不报错）
    const snapshot = s.graph.getAttachmentSnapshot(s.root);
    expect(snapshot.symbolAnchors.length).toBe(1);

    // 恢复：下次 sync 正常，degraded 清除
    s.engine.setUnavailable(false);
    const recovered = await s.service.triggerManual(s.root);
    expect(recovered.degraded).toBe(false);
    expect(s.service.getStatus(s.root).phase).toBe("synced");
  });

  test("④ 增量：mtime/hash 未变跳过；变更文件导入；基准戳单调推进（CL-2.A4/A6）", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const r1 = await s.service.onStartup(s.root);
    // 再次 sync：引擎面未变 → 全部跳过（mtime/hash 同上一基准）
    const r2 = await s.service.triggerManual(s.root);
    expect(r2.importedFiles).toBe(0);
    expect(Number(r2.baseline)).toBeGreaterThan(Number(r1.baseline));
    // 文件变更（hash/mtime 演进）→ 窗口 sync 导入
    const changed = healthyFixture();
    changed.files = [{ path: "src/app.ts", contentHash: "hash-v2", modifiedAt: 2000, indexedAt: 2000 }];
    s.engine.setSymbols(changed);
    s.service.notifyWrite(s.root, path.join(s.root, "src/app.ts"), "hash-v2");
    await sleep(80);
    const status = s.service.getStatus(s.root);
    expect(Number(status.baseline!)).toBeGreaterThan(Number(r2.baseline));
    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      expect((db.query("SELECT sha256 FROM files WHERE path='src/app.ts'").get() as { sha256: string }).sha256).toBe("hash-v2");
    } finally {
      db.close();
    }
  });

  test("⑤ 符号消亡 → 物化锚转 orphan（保留行可查，非物理删）+ 失效信号入 SyncResult（CL-2.A7）", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const symNode = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "e1", digest: "d1", scene: "测试场景" },
    }));
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: symNode, anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#Handler" }] }));
    await s.service.onStartup(s.root);

    // Handler 改名/删除：引擎面不再有该符号 + 文件事件触发窗口 sync
    const shrunk = healthyFixture();
    shrunk.symbols = shrunk.symbols.filter((x) => x.name !== "Handler" && x.name !== "handle");
    shrunk.containsEdges = [{ containerId: "file:src/app.ts", symbolId: "fn:1" }];
    shrunk.files = [{ path: "src/app.ts", contentHash: "hash-v3", modifiedAt: 3000, indexedAt: 3000 }];
    s.engine.setSymbols(shrunk);
    s.service.notifyWrite(s.root, path.join(s.root, "src/app.ts"), "hash-v3");
    await sleep(80);

    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      const anchor = db.query("SELECT node_id, anchor_kind, anchor_symbol, orphan FROM materialized_anchors").get() as Record<string, unknown>;
      expect(anchor).toMatchObject({ node_id: symNode, anchor_kind: "symbol", anchor_symbol: "Handler", orphan: 1 });
      // 符号行已随文件域导入清除（消亡符号从 symbols 表消失）
      expect((db.query("SELECT COUNT(*) AS n FROM symbols WHERE name='Handler'").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
    // 失效锚不再进附着快照
    expect(s.graph.getAttachmentSnapshot(s.root).symbolAnchors.length).toBe(0);
  });

  test("⑥ building 态上报：running 中 getStatus.phase=building（O-6 轮询面）；快照滞后读不报错", async () => {
    const s = makeStack({ delayMs: 60 });
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const running = s.service.triggerManual(s.root);
    await sleep(15); // 引擎延迟窗口内
    expect(s.service.getStatus(s.root).phase).toBe("building");
    // 附着不依赖新鲜度（AD-15）：sync 进行中附着快照直读（空快照）不报错
    expect(s.graph.getAttachmentSnapshot(s.root).nodes.length).toBe(0);
    await running;
    expect(s.service.getStatus(s.root).phase).toBe("synced");
  });

  test("⑦ 文件删除事件（remove）：符号行/contains/文件基准整文件清除", async () => {
    const s = makeStack();
    stacks.push(s);
    const fixture = healthyFixture();
    fixture.files.push({ path: "src/gone.ts", contentHash: "g1", modifiedAt: 1000, indexedAt: 1000 });
    fixture.symbols.push(engineSymbol("fn:2", "goneFn", "src/gone.ts", "function", 1, 5));
    s.engine.setSymbols(fixture);
    await s.service.onStartup(s.root);
    let db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM files WHERE path='src/gone.ts'").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
    // 引擎面移除该文件 + watch remove 事件
    const shrunk = healthyFixture();
    s.engine.setSymbols(shrunk);
    s.service.onFsEvent(s.root, path.join(s.root, "src/gone.ts"), "remove");
    await sleep(80);
    db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM files WHERE path='src/gone.ts'").get() as { n: number }).n).toBe(0);
      expect((db.query("SELECT COUNT(*) AS n FROM symbols WHERE file='src/gone.ts'").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("⑧ 孤儿锚复活复位：符号消亡标 orphan → 符号复活（文件 mtime/hash 不变）→ 增量窗口 sync 后须复位——生产 8 行假孤儿复现", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const node = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "rule", name: "r-orphan", digest: "d", scene: "测试场景" },
    }));
    expectOk(s.write.write(s.root, {
      kind: "declareAnchors",
      iterationId: "it",
      nodeId: node,
      anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#handle" }],
    }));
    await s.service.onStartup(s.root);
    const orphanOf = (): number => {
      const db = new Database(kgDbPath(s.root), { readonly: true });
      try {
        return (db.query("SELECT orphan FROM materialized_anchors WHERE node_id = ? AND anchor_symbol = 'handle'").get(s.root ? node : node) as { orphan: number }).orphan;
      } finally {
        db.close();
      }
    };
    expect(orphanOf()).toBe(0); // 物化在位

    // 阶段一：符号消亡 → 差集标记 orphan=1
    const shrunk = healthyFixture();
    shrunk.symbols = shrunk.symbols.filter((x) => x.name !== "handle");
    shrunk.containsEdges = shrunk.containsEdges.filter((x) => x.symbolId !== "m:1");
    s.engine.setSymbols(shrunk);
    s.service.notifyWrite(s.root, "src/app.ts", "h2");
    await sleep(120);
    expect(orphanOf()).toBe(1);

    // 阶段二：符号复活且文件指纹不变（healthyFixture 原样）——增量窗口 sync，
    // 物化每次全量重算 → 应产出该锚 → upsert DO UPDATE SET orphan=0 复位。
    // 生产观察：该复位未发生（8 行假孤儿卡死）——本步复现。
    s.engine.setSymbols(healthyFixture());
    s.service.notifyWrite(s.root, "src/app.ts", "h3");
    await sleep(120);
    expect(orphanOf()).toBe(0);
  });

  // ── L0 机械重定位（P0，kg-auto-adjudication-design.md §4）── 两轮时序：断链轮仅落快照
  // （稳定期门）；消化轮高置信重写声明 + 新锚当轮复活 + tombstone 物理清理 + change_log 审计。

  function renameFixture(): { symbols: EngineSymbol[]; containsEdges: { containerId: string; symbolId: string }[]; files: { path: string; contentHash: string; modifiedAt: number; indexedAt: number }[] } {
    // Handler 同文件改名 HandlerV2（同 kind 同 span——R2 高置信形态）
    return {
      symbols: [
        engineSymbol("file:src/app.ts", "src/app.ts", "src/app.ts", "file", 1, 40),
        engineSymbol("fn:1", "main", "src/app.ts", "function", 1, 20),
        engineSymbol("cls:1", "HandlerV2", "src/app.ts", "class", 22, 38),
        engineSymbol("m:1", "handle", "src/app.ts", "method", 24, 36),
      ],
      containsEdges: [
        { containerId: "file:src/app.ts", symbolId: "fn:1" },
        { containerId: "cls:1", symbolId: "m:1" },
      ],
      files: [{ path: "src/app.ts", contentHash: "hash-v2", modifiedAt: 2000, indexedAt: 2000 }],
    };
  }

  function anchorRows(s: Stack): Record<string, unknown>[] {
    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      return db.query("SELECT node_id, anchor_kind, anchor_path, anchor_symbol, orphan, evidence FROM materialized_anchors ORDER BY anchor_path, anchor_symbol").all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  }

  test("⑪ L0-R2 同文件符号改名：断链轮落快照（稳定期门）→ 消化轮重写声明 + 新锚当轮复活 + 审计行", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const symNode = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "handler", digest: "d", scene: "测试" },
    }));
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: symNode, anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#Handler" }] }));
    await s.service.onStartup(s.root);

    // 断链轮：Handler 消失 → tombstone + evidence 快照；声明不动（稳定期门）
    s.engine.setSymbols(renameFixture());
    await s.service.triggerManual(s.root);
    expect(anchorRows(s)).toEqual([
      { node_id: symNode, anchor_kind: "symbol", anchor_path: "src/app.ts", anchor_symbol: "Handler", orphan: 1, evidence: JSON.stringify({ kind: "class", spanStart: 22, spanEnd: 38 }) },
    ]);
    const declAfterBreak = (() => {
      const db = new Database(kgDbPath(s.root), { readonly: true });
      try {
        return db.query("SELECT pattern FROM anchor_decl").all() as { pattern: string }[];
      } finally {
        db.close();
      }
    })();
    expect(declAfterBreak).toEqual([{ pattern: "src/app.ts#Handler" }]);

    // 消化轮：tombstone 已过稳定期 → 声明重写 + 新锚当轮复活 + 旧行物理删
    await s.service.triggerManual(s.root);
    expect(anchorRows(s)).toEqual([
      { node_id: symNode, anchor_kind: "symbol", anchor_path: "src/app.ts", anchor_symbol: "HandlerV2", orphan: 0, evidence: "" },
    ]);
    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      expect(db.query("SELECT pattern FROM anchor_decl").all()).toEqual([{ pattern: "src/app.ts#HandlerV2" }]);
      const logs = db.query("SELECT op, node_id, reason FROM change_log WHERE op IN ('anchorRelocate','prune') ORDER BY seq").all() as Record<string, string>[];
      expect(logs.length).toBe(2); // 重写审计 + prune 审计（同一节点）
      expect(logs[0]!.op).toBe("anchorRelocate");
      expect(logs[0]!.reason).toContain("auto: "); // P2：机器裁决溯源前缀（kg.auto.audit 聚合面）
      expect(logs[0]!.reason).toContain("src/app.ts#Handler → src/app.ts#HandlerV2");
    } finally {
      db.close();
    }
  });

  test("⑫ L0-R1b 跨文件迁移（E-9 形态2 主形态）：旧文件消失 + 唯一同名同 kind 宿主 → 声明指向新文件", async () => {
    const s = makeStack();
    stacks.push(s);
    const moved = {
      symbols: [
        engineSymbol("file:src/new.ts", "src/new.ts", "src/new.ts", "file", 1, 60),
        engineSymbol("fn:9", "sweepBatches", "src/new.ts", "function", 5, 55),
      ],
      containsEdges: [{ containerId: "file:src/new.ts", symbolId: "fn:9" }],
      files: [{ path: "src/new.ts", contentHash: "hash-m", modifiedAt: 3000, indexedAt: 3000 }],
    };
    const initial = {
      symbols: [
        engineSymbol("file:src/old.ts", "src/old.ts", "src/old.ts", "file", 1, 60),
        engineSymbol("fn:9", "sweepBatches", "src/old.ts", "function", 5, 55),
      ],
      containsEdges: [{ containerId: "file:src/old.ts", symbolId: "fn:9" }],
      files: [{ path: "src/old.ts", contentHash: "hash-o", modifiedAt: 1000, indexedAt: 1000 }],
    };
    s.engine.setSymbols(initial);
    const node = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "sweep", digest: "d", scene: "测试" },
    }));
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: node, anchors: [{ scopeKind: "symbol", pattern: "src/old.ts#sweepBatches" }] }));
    await s.service.onStartup(s.root);

    s.engine.setSymbols(moved);
    await s.service.triggerManual(s.root); // 断链轮（快照 + tombstone）
    await s.service.triggerManual(s.root); // 消化轮：R1b 重写
    expect(anchorRows(s)).toEqual([
      { node_id: node, anchor_kind: "symbol", anchor_path: "src/new.ts", anchor_symbol: "sweepBatches", orphan: 0, evidence: "" },
    ]);
    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      expect(db.query("SELECT pattern FROM anchor_decl").all()).toEqual([{ pattern: "src/new.ts#sweepBatches" }]);
    } finally {
        db.close();
      }
  });

  test("⑬ L0-R3 无声明旧键（声明撤销）：节点附着面健康 → 机械 prune；形态1 符号消亡（声明仍在）→ 保留信号", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const node = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "e", digest: "d", scene: "测试" },
    }));
    const keepNode = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "k", digest: "d", scene: "测试" },
    }));
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: node, anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#Handler" }] }));
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: keepNode, anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#Handler" }] }));
    await s.service.onStartup(s.root);

    // node 声明全集替换为只留 main（Handler 撤销 + main 活锚 = 附着面健康）→ 形态3 无声明旧键；
    // keepNode 声明保留 → 形态1 符号消亡（声明仍在，真信号）
    const shrunk = healthyFixture();
    shrunk.symbols = shrunk.symbols.filter((x) => x.name !== "Handler" && x.name !== "handle");
    shrunk.containsEdges = shrunk.containsEdges.filter((x) => x.symbolId !== "m:1");
    shrunk.files = [{ path: "src/app.ts", contentHash: "hash-v3", modifiedAt: 3000, indexedAt: 3000 }];
    s.engine.setSymbols(shrunk);
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: node, anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#main" }] }));
    await s.service.triggerManual(s.root); // 断链轮：两锚均 tombstone + 快照
    await s.service.triggerManual(s.root); // 消化轮：node 的 Handler 旧行 R3 prune（main 活锚健康）；keepNode 的保留（声明仍在 = 真信号）
    const rows = anchorRows(s);
    expect(rows.length).toBe(2); // node 的 main 活锚 + keepNode 的 Handler tombstone
    expect(rows.find((r) => r["anchor_symbol"] === "main")).toMatchObject({ node_id: node, orphan: 0 });
    expect(rows.find((r) => r["anchor_symbol"] === "Handler")).toMatchObject({ node_id: keepNode, orphan: 1 });
    const db = new Database(kgDbPath(s.root), { readonly: true });
    try {
      const pruneLog = db.query("SELECT op, node_id FROM change_log WHERE op = 'prune'").all() as Record<string, string>[];
      expect(pruneLog.length).toBe(1);
      expect(pruneLog[0]!.node_id).toBe(node);
    } finally {
      db.close();
    }
  });

  test("⑭ L0 degraded 门：引擎不可用轮零锚处置（tombstone 原样保留，恢复后消化）", async () => {
    const s = makeStack();
    stacks.push(s);
    s.engine.setSymbols(healthyFixture());
    const symNode = expectOk(s.write.write(s.root, {
      kind: "createNode",
      iterationId: "it",
      draft: { kind: "entity", name: "h", digest: "d", scene: "测试" },
    }));
    expectOk(s.write.write(s.root, { kind: "declareAnchors", iterationId: "it", nodeId: symNode, anchors: [{ scopeKind: "symbol", pattern: "src/app.ts#Handler" }] }));
    await s.service.onStartup(s.root);

    s.engine.setSymbols(renameFixture());
    await s.service.triggerManual(s.root); // 断链轮：tombstone + 快照

    s.engine.setUnavailable(true);
    await s.service.triggerManual(s.root); // degraded 轮：零重写零 prune
    expect(anchorRows(s)).toEqual([
      { node_id: symNode, anchor_kind: "symbol", anchor_path: "src/app.ts", anchor_symbol: "Handler", orphan: 1, evidence: JSON.stringify({ kind: "class", spanStart: 22, spanEnd: 38 }) },
    ]);

    s.engine.setUnavailable(false);
    await s.service.triggerManual(s.root); // 恢复轮：正常消化
    expect(anchorRows(s)).toEqual([
      { node_id: symNode, anchor_kind: "symbol", anchor_path: "src/app.ts", anchor_symbol: "HandlerV2", orphan: 0, evidence: "" },
    ]);
  });
});
