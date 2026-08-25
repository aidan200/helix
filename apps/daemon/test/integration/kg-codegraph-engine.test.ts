import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  CodegraphEngineAdapter,
  EngineUnavailableError,
  CODEGRAPH_SCHEMA_MAX_VERSION,
} from "../../src/adapters/driven/codegraph-engine/CodegraphEngineAdapter";

/**
 * T2.1（AF-2 裁决，I 层）：codegraph 引擎被动封装。
 * - 被动模式契约：只出现一次性命令 status/init/index/sync（fake CLI 记录
 *   断言），无 serve/daemon/watch（禁用面，AF-2）；
 * - status 探测路由：未初始化→init（全量首建）；已初始化且新鲜→sync（增量）；
 *   reindexRecommended/index.state 异常→index（全量重建）；
 * - 降级三入口统一 EngineUnavailable：status 失败/坏 JSON、构建失败、超时、
 *   schema 版本超限、缺表、库缺失；
 * - 只读投影：tmp codegraph.db（真实 schema 子集）三表映射 + 库逐字节不变
 *   （含 WAL 干净退出态——无 -wal/-shm 时只读回退仍可投影）；
 * - exportSymbols 与 CLI 二进制解耦（直读 db，AF-2）。
 */

const disposers: Array<() => void> = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** fake CLI 脚本（node 可执行）：按文件标记驱动行为，子命令逐行记入 calls.log。 */
function makeFakeCli(dir: string): string {
  const script = path.join(dir, "codegraph");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const dir = __dirname;',
      'const sub = process.argv[2] || "";',
      'const has = (m) => fs.existsSync(path.join(dir, m));',
      'fs.appendFileSync(path.join(dir, "calls.log"), sub + "\\n");',
      'if (has("hang-" + sub)) { setTimeout(() => {}, 60000); return; }',
      "if (has('fail-' + sub)) process.exit(1);",
      'if (sub === "status") {',
      '  if (has("garbage")) { console.log("not json {"); process.exit(0); }',
      '  if (!has("initialized")) { console.log(JSON.stringify({ initialized: false })); process.exit(0); }',
      "  console.log(JSON.stringify({",
      "    initialized: true,",
      '    lastIndexed: "2026-08-25T10:00:00.000Z",',
      '    index: { state: has("partial") ? "partial" : "complete", reindexRecommended: has("stale") },',
      "  }));",
      "  process.exit(0);",
      "}",
      'if (sub === "init") { fs.writeFileSync(path.join(dir, "initialized"), "1"); process.exit(0); }',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return script;
}

/** 读 fake CLI 调用记录。 */
function callsOf(dir: string): string[] {
  const log = path.join(dir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter((l) => l !== "");
}

/** 构造 codegraph.db（真实 schema 投影所涉子集）并灌 fixture 行。 */
function makeCodegraphDb(projectRoot: string, opts: { schemaVersion?: number; omitNodes?: boolean } = {}): void {
  const cgDir = path.join(projectRoot, ".codegraph");
  mkdirSync(cgDir, { recursive: true });
  const db = new Database(path.join(cgDir, "codegraph.db"));
  db.exec(`
    CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL,
      kind TEXT NOT NULL, metadata TEXT, line INTEGER, col INTEGER, provenance TEXT DEFAULT NULL
    );
    CREATE TABLE files (
      path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, size INTEGER NOT NULL,
      modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0,
      errors TEXT, generated INTEGER NOT NULL DEFAULT 0
    );
  `);
  if (!opts.omitNodes) {
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, docstring TEXT, signature TEXT
      );
    `);
    db.run(
      "INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, signature) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ["file:src/app.ts", "file", "app.ts", "src/app.ts", "src/app.ts", "typescript", 0, 0, 0, 0, null],
    );
    db.run(
      "INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, signature) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ["class:aaa", "class", "Greeter", "Greeter", "src/app.ts", "typescript", 1, 20, 0, 1, "class Greeter"],
    );
    db.run(
      "INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, signature) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ["method:bbb", "method", "greet", "Greeter.greet", "src/app.ts", "typescript", 5, 7, 2, 3, null],
    );
  }
  const edgeRows: [string, string, string][] = [
    ["file:src/app.ts", "class:aaa", "contains"],
    ["class:aaa", "method:bbb", "contains"],
    ["class:aaa", "method:bbb", "calls"],
  ];
  for (const [source, target, kind] of edgeRows) {
    db.run("INSERT INTO edges (source, target, kind) VALUES (?,?,?)", [source, target, kind]);
  }
  db.run(
    "INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?,?,?,?,?,?)",
    ["src/app.ts", "deadbeef", "typescript", 431, 1786819913656, 1786819933558],
  );
  db.run("INSERT INTO schema_versions (version, applied_at) VALUES (?,?)", [opts.schemaVersion ?? 8, 0]);
  db.close();
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

describe("被动模式与构建路由（AF-2：一次性命令，禁 serve/daemon/watch）", () => {
  test("① status 未初始化 → init 全量首建（调用序列恰 [status, init]）", async () => {
    const dir = tmpDir("helix-cg-passive-");
    const cli = makeFakeCli(dir);
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    const root = path.join(dir, "proj");
    mkdirSync(root);

    const freshness = await adapter.ensureIndex(root);

    expect(freshness).toEqual({
      initialized: true,
      mode: "init",
      lastIndexed: null,
    });
    expect(callsOf(dir)).toEqual(["status", "init"]);
    // 被动契约：一次性命令白名单内，无长驻面
    for (const called of callsOf(dir)) {
      expect(["status", "init", "index", "sync"]).toContain(called);
    }
  });

  test("② status 已初始化且新鲜 → sync 增量", async () => {
    const dir = tmpDir("helix-cg-sync-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "initialized"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });

    const freshness = await adapter.ensureIndex(path.join(dir, "proj"));

    expect(freshness.mode).toBe("sync");
    expect(freshness.lastIndexed).toBe("2026-08-25T10:00:00.000Z");
    expect(callsOf(dir)).toEqual(["status", "sync"]);
  });

  test("③ 已初始化但 reindexRecommended → index 全量重建", async () => {
    const dir = tmpDir("helix-cg-stale-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "initialized"), "1");
    writeFileSync(path.join(dir, "stale"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });

    const freshness = await adapter.ensureIndex(path.join(dir, "proj"));

    expect(freshness.mode).toBe("index");
    expect(callsOf(dir)).toEqual(["status", "index"]);
  });

  test("④ index.state=partial（截断索引）→ index 全量重建", async () => {
    const dir = tmpDir("helix-cg-partial-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "initialized"), "1");
    writeFileSync(path.join(dir, "partial"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });

    const freshness = await adapter.ensureIndex(path.join(dir, "proj"));

    expect(freshness.mode).toBe("index");
    expect(callsOf(dir)).toEqual(["status", "index"]);
  });

  test("⑤ 全程零 serve/daemon/watch（序列级机械断言已覆盖；此条为显式负断言）", async () => {
    const dir = tmpDir("helix-cg-neg-");
    const cli = makeFakeCli(dir);
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    const root = path.join(dir, "proj");
    mkdirSync(root);
    await adapter.ensureIndex(root);
    const log = callsOf(dir).join(",");
    for (const banned of ["serve", "daemon", "watch", "uninstall", "telemetry"]) {
      expect(log.includes(banned)).toBe(false);
    }
  });
});

describe("degraded 三入口 → 统一 EngineUnavailable", () => {
  test("① 二进制不可达（resolve 全 miss）：ensureIndex 抛 EngineUnavailable，不崩溃", async () => {
    const adapter = new CodegraphEngineAdapter({ binaryPath: null });
    const root = tmpDir("helix-cg-nobin-");
    let err: unknown;
    try {
      await adapter.ensureIndex(root);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).kind).toBe("EngineUnavailable");
    expect(typeof (err as EngineUnavailableError).reason).toBe("string");
  });

  test("② status 非零退出 → EngineUnavailable", async () => {
    const dir = tmpDir("helix-cg-statusfail-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "fail-status"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    await expect(adapter.ensureIndex(path.join(dir, "proj"))).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  test("③ status 输出非 JSON → EngineUnavailable", async () => {
    const dir = tmpDir("helix-cg-badjson-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "garbage"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    await expect(adapter.ensureIndex(path.join(dir, "proj"))).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  test("④ 构建命令非零退出（fail-sync）→ EngineUnavailable", async () => {
    const dir = tmpDir("helix-cg-buildfail-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "initialized"), "1");
    writeFileSync(path.join(dir, "fail-sync"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    await expect(adapter.ensureIndex(path.join(dir, "proj"))).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  test("⑤ 子进程挂起 → 超时 EngineUnavailable（timeoutMs 可注入）", async () => {
    const dir = tmpDir("helix-cg-hang-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "initialized"), "1");
    writeFileSync(path.join(dir, "hang-sync"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli, timeoutMs: 300 });
    const startedAt = Date.now();
    let err: unknown;
    try {
      await adapter.ensureIndex(path.join(dir, "proj"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(10_000); // 未被挂起子进程卡死
  });
});

describe("exportSymbols 只读投影（AF-2：直读 db，与 CLI 二进制解耦）", () => {
  test("① 二进制 null 但 db 存在 → 投影照常（构建面与投影面解耦）", async () => {
    const root = tmpDir("helix-cg-proj-");
    makeCodegraphDb(root);
    const adapter = new CodegraphEngineAdapter({ binaryPath: null });
    const set = await adapter.exportSymbols(root);
    expect(set.symbols.length).toBeGreaterThan(0);
  });

  test("② 三表投影：symbols（nodes 含 span）/contains（仅 contains 边）/files 基准面", async () => {
    const root = tmpDir("helix-cg-proj2-");
    makeCodegraphDb(root);
    const adapter = new CodegraphEngineAdapter({ binaryPath: null });
    const set = await adapter.exportSymbols(root);

    // symbols ← nodes（忠实投影，含 file/import 类行；消费侧过滤归 T2.2）
    expect(set.symbols).toHaveLength(3);
    const cls = set.symbols.find((s) => s.id === "class:aaa");
    expect(cls).toEqual({
      id: "class:aaa",
      kind: "class",
      name: "Greeter",
      qualifiedName: "Greeter",
      filePath: "src/app.ts",
      language: "typescript",
      signature: "class Greeter",
      startLine: 1,
      endLine: 20,
      startColumn: 0,
      endColumn: 1,
    });
    const method = set.symbols.find((s) => s.id === "method:bbb");
    expect(method?.qualifiedName).toBe("Greeter.greet");
    expect(method?.startLine).toBe(5);
    expect(method?.endLine).toBe(7);

    // contains ← edges WHERE kind='contains'：calls 边不导（导入范围刻意最小，AD-8）
    expect(set.containsEdges).toEqual([
      { containerId: "file:src/app.ts", symbolId: "class:aaa" },
      { containerId: "class:aaa", symbolId: "method:bbb" },
    ]);

    // files ← files 表基准面
    expect(set.files).toEqual([
      {
        path: "src/app.ts",
        contentHash: "deadbeef",
        modifiedAt: 1786819913656,
        indexedAt: 1786819933558,
      },
    ]);
  });

  test("③ 只读边界：投影执行后 codegraph.db 逐字节不变，且不产生 -wal/-shm", async () => {
    const root = tmpDir("helix-cg-ro-");
    makeCodegraphDb(root);
    const dbFile = path.join(root, ".codegraph", "codegraph.db");
    const before = sha256Of(dbFile);
    const adapter = new CodegraphEngineAdapter({ binaryPath: null });

    await adapter.exportSymbols(root);
    await adapter.exportSymbols(root); // 二次投影同样零写入

    expect(sha256Of(dbFile)).toBe(before);
    expect(readdirSync(path.join(root, ".codegraph"))).toEqual(["codegraph.db"]);
  });

  test("④ WAL 干净退出态（无 -wal/-shm 的 WAL 库）→ 只读回退连接仍可投影", async () => {
    const root = tmpDir("helix-cg-wal-");
    makeCodegraphDb(root);
    const dbFile = path.join(root, ".codegraph", "codegraph.db");
    // 转 WAL + 干净关闭后移除 -wal/-shm（模拟 CLI wal-valve 退出后的磁盘态）
    const db = new Database(dbFile);
    db.exec("PRAGMA journal_mode = WAL;");
    db.run("INSERT INTO schema_versions (version, applied_at) VALUES (?,?)", [3, 0]);
    db.close();
    rmSync(`${dbFile}-wal`, { force: true });
    rmSync(`${dbFile}-shm`, { force: true });
    const before = sha256Of(dbFile);

    const adapter = new CodegraphEngineAdapter({ binaryPath: null });
    const set = await adapter.exportSymbols(root);

    expect(set.symbols.length).toBeGreaterThan(0);
    expect(sha256Of(dbFile)).toBe(before);
  });

  test("⑤ schema 门：版本高于已测上限 → EngineUnavailable（绝不写/迁移）", async () => {
    const root = tmpDir("helix-cg-vover-");
    makeCodegraphDb(root, { schemaVersion: CODEGRAPH_SCHEMA_MAX_VERSION + 1 });
    const dbFile = path.join(root, ".codegraph", "codegraph.db");
    const before = sha256Of(dbFile);
    const adapter = new CodegraphEngineAdapter({ binaryPath: null });
    await expect(adapter.exportSymbols(root)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(sha256Of(dbFile)).toBe(before);
    expect(CODEGRAPH_SCHEMA_MAX_VERSION).toBe(9);
  });

  test("⑥ schema 门：缺 nodes 表 → EngineUnavailable", async () => {
    const root = tmpDir("helix-cg-notbl-");
    makeCodegraphDb(root, { omitNodes: true });
    const adapter = new CodegraphEngineAdapter({ binaryPath: null });
    await expect(adapter.exportSymbols(root)).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  test("⑦ 库缺失（项目未建索引）→ EngineUnavailable", async () => {
    const root = tmpDir("helix-cg-nodb-");
    const adapter = new CodegraphEngineAdapter({ binaryPath: null });
    await expect(adapter.exportSymbols(root)).rejects.toBeInstanceOf(EngineUnavailableError);
  });
});
