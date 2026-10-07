import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  ensureSchemaEvolved,
  runBatchedBackfill,
} from "../../../src/adapters/driven/sqlite-session/schema-evolution";

/**
 * TR-245 根修：守护迁移数据回填分批可续传——
 * ① kind 回填语义保持（legacy 'main'/主 id 对照 → main，其余 → subagent，已定格行不动）；
 * ② 分批续传：中途停止（模拟 SIGKILL）只丢当前批，重开库跑 ensureSchemaEvolved 从剩余行续传；
 * ③ 幂等：跑满后重跑零动作。
 * 全程 tmp 目录（不碰真实 ~/.helix）。
 */
// TR-152：tmpdir 登记数组 + afterEach 统一 force 幂等回收（CI 全前缀审计防泄漏）
const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-se-"));
  tmpDirs.push(dir);
  return path.join(dir, "helix.db");
}

/** 旧形态库（kind 列引入前）：ensureSchemaEvolved 走 ALTER 补列 + 回填的事故路径。 */
function seedLegacyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session_state (
      session_id TEXT PRIMARY KEY,
      main_instance_id TEXT,
      entries TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      instance_id TEXT
    );
    INSERT INTO session_state (session_id, main_instance_id, entries, created_at, updated_at)
      VALUES ('s1', 'agent-aaa', '[]', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO tool_calls (id, session_id, instance_id) VALUES
      ('t1', 's1', 'main'),        -- legacy 主实例 id → main
      ('t2', 's1', 'agent-aaa'),   -- = 会话 main_instance_id → main
      ('t3', 's1', 'agent-bbb'),   -- 其余 → subagent
      ('t4', 's2', 'main'),        -- 无 session_state 行（子查询 NULL）：legacy id 仍 → main
      ('t5', 's2', 'agent-ccc');   -- 无会话对照 → subagent
  `);
  db.close();
}

describe("ensureSchemaEvolved：tool_calls.kind 回填", () => {
  test("语义保持：legacy 'main'/主 id 对照 → main，其余 → subagent；已定格行不动", () => {
    const dbPath = tmpDbPath();
    seedLegacyDb(dbPath);
    const db = new Database(dbPath);
    ensureSchemaEvolved(db);
    const rows = db
      .prepare("SELECT id, kind FROM tool_calls ORDER BY id")
      .all() as { id: string; kind: string | null }[];
    expect(rows).toEqual([
      { id: "t1", kind: "main" },
      { id: "t2", kind: "main" },
      { id: "t3", kind: "subagent" },
      { id: "t4", kind: "main" },
      { id: "t5", kind: "subagent" },
    ]);
    // 二次开库：kind 列时代新增的 steward 直书行（已定格）不得被回填覆盖；
    // 顺带补入的 NULL 行照常回填
    db.prepare(
      "INSERT INTO tool_calls (id, session_id, instance_id, kind) VALUES ('t6', 's1', 'agent-ddd', 'steward')",
    ).run();
    db.prepare(
      "INSERT INTO tool_calls (id, session_id, instance_id) VALUES ('t7', 's1', 'agent-eee')",
    ).run();
    ensureSchemaEvolved(db);
    const later = db
      .prepare("SELECT id, kind FROM tool_calls WHERE id IN ('t6','t7') ORDER BY id")
      .all() as { id: string; kind: string | null }[];
    expect(later).toEqual([
      { id: "t6", kind: "steward" },
      { id: "t7", kind: "subagent" },
    ]);
    db.close();
  });
});

describe("runBatchedBackfill：分批可续传（TR-245）", () => {
  test("预算内只跑给定批数（模拟迁移中途被杀）；已提交批保留，重开库 ensureSchemaEvolved 从剩余行续传至完", () => {
    const dbPath = tmpDbPath();
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE session_state (session_id TEXT PRIMARY KEY, main_instance_id TEXT, entries TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, session_id TEXT, instance_id TEXT, kind TEXT);
    `);
    for (let i = 0; i < 7; i += 1) {
      seed
        .prepare("INSERT INTO tool_calls (session_id, instance_id) VALUES ('s1', 'agent-x')")
        .run();
    }
    seed.close();

    // 第一段：批大小 2、预算 2 批 → 只提交 2 批（4 行），模拟 SIGKILL 停在此处
    const interrupted = new Database(dbPath);
    const result = runBatchedBackfill(
      interrupted,
      "tool_calls",
      `kind = CASE WHEN instance_id = 'main' OR instance_id = (SELECT main_instance_id FROM session_state WHERE session_state.session_id = tool_calls.session_id) THEN 'main' ELSE 'subagent' END`,
      "kind IS NULL",
      { batchSize: 2, maxBatches: 2 },
    );
    expect(result.done).toBe(false);
    expect(result.batches).toBe(2);
    const remaining = interrupted
      .prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE kind IS NULL")
      .get() as { n: number };
    expect(remaining.n).toBe(3); // 7 - 2批×2行：已提交批不回滚
    interrupted.close();

    // 第二段：重开库跑守护迁移 → 从剩余 3 行续传至完（不从零重跑）
    const reopened = new Database(dbPath);
    ensureSchemaEvolved(reopened);
    const left = reopened
      .prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE kind IS NULL")
      .get() as { n: number };
    expect(left.n).toBe(0);
    const kinds = reopened.prepare("SELECT DISTINCT kind FROM tool_calls").all() as { kind: string }[];
    expect(kinds).toEqual([{ kind: "subagent" }]); // 全部 agent-x → subagent
    reopened.close();
  });

  test("幂等：跑满后重跑零动作（done=true, batches=0）", () => {
    const dbPath = tmpDbPath();
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE session_state (session_id TEXT PRIMARY KEY, main_instance_id TEXT, entries TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, session_id TEXT, instance_id TEXT, kind TEXT);
    `);
    seed
      .prepare("INSERT INTO tool_calls (session_id, instance_id) VALUES ('s1', 'agent-x')")
      .run();
    seed.close();

    const db = new Database(dbPath);
    const first = runBatchedBackfill(db, "tool_calls", "kind = 'subagent'", "kind IS NULL", {
      batchSize: 10,
    });
    expect(first).toEqual({ done: true, batches: 1 });
    const second = runBatchedBackfill(db, "tool_calls", "kind = 'subagent'", "kind IS NULL", {
      batchSize: 10,
    });
    expect(second).toEqual({ done: true, batches: 0 });
    db.close();
  });

  test("空表零批即完（无谓词行 = no-op）", () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.exec("CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, kind TEXT)");
    const result = runBatchedBackfill(db, "tool_calls", "kind = 'main'", "kind IS NULL", {
      batchSize: 5,
    });
    expect(result).toEqual({ done: true, batches: 0 });
    db.close();
  });
});

describe("updated_at 修复回填：分批可续传（同一执行器）", () => {
  test("中途停止后重开库续传至完；空 entries 兜底 created_at", () => {
    const dbPath = tmpDbPath();
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE session_state (
        session_id TEXT PRIMARY KEY,
        main_instance_id TEXT,
        entries TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
    const insert = seed.prepare(
      "INSERT INTO session_state (session_id, entries, created_at, updated_at) VALUES (?, ?, '2024-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
    );
    insert.run("s1", JSON.stringify([{ createdAt: "2024-06-01T00:00:00.000Z" }]));
    insert.run("s2", JSON.stringify([{ createdAt: "2024-07-01T00:00:00.000Z" }]));
    insert.run("s3", "[]"); // 空 entries → 兜底 created_at
    seed.close();

    const interrupted = new Database(dbPath);
    const partial = runBatchedBackfill(
      interrupted,
      "session_state",
      "updated_at = COALESCE(json_extract(entries, '$[#-1].createdAt'), created_at)",
      "updated_at IS NOT COALESCE(json_extract(entries, '$[#-1].createdAt'), created_at)",
      { batchSize: 1, maxBatches: 1 },
    );
    expect(partial.done).toBe(false);
    interrupted.close();

    const reopened = new Database(dbPath);
    ensureSchemaEvolved(reopened);
    const rows = reopened
      .prepare("SELECT session_id, updated_at FROM session_state ORDER BY session_id")
      .all() as { session_id: string; updated_at: string }[];
    expect(rows).toEqual([
      { session_id: "s1", updated_at: "2024-06-01T00:00:00.000Z" },
      { session_id: "s2", updated_at: "2024-07-01T00:00:00.000Z" },
      { session_id: "s3", updated_at: "2024-01-01T00:00:00.000Z" },
    ]);
    reopened.close();
  });
});
