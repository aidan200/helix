import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";

/**
 * O-3 守护式 schema 演进（架构 §8.1，iter-20260816-uzvg T1.2）：
 * 旧库文件（v0 DDL：domain_events 无 agent_instance_id、agent_lifecycle 单列
 * PK、tool_calls 无 instance_id）→ WriteQueue 打开即自动补列/重建 PK，
 * 旧行回填 main，daemon 正常服务（F1.7 验收①④）。
 *
 * - 旧行 agent_instance_id 全为 main（回填常量 = 主实例固定 id，O-3/O-4 一致）；
 * - agent_lifecycle PK 扩 (session_id, instance_id)：同会话 main + 两个 SubAgent
 *   实例行并存可查；同 (session, agent-1) 二次 upsert 替换不重复；
 * - 迁移幂等：二次打开不重复迁移、数据完好；
 * - 新库直建新形状（不走迁移分支）。
 */

/** v0 时代 DDL（升级前库文件的形状；与现 schema.ts 的差异即本次演进面）。 */
const V0_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS domain_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain_events_session ON domain_events(session_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_agent_kind ON domain_events(agent_kind);
CREATE INDEX IF NOT EXISTS idx_domain_events_type ON domain_events(type);
CREATE INDEX IF NOT EXISTS idx_domain_events_ts ON domain_events(ts);

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  entries TEXT NOT NULL,
  turns TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_lifecycle (
  session_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
`;

function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "helix-mig-")), "helix.db");
}

/** 构造旧库文件：v0 DDL + 各表典型旧行（entries JSON 无 instanceId）。 */
function buildLegacyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(V0_SCHEMA_SQL);
  db.exec(
    "INSERT INTO domain_events (session_id, agent_kind, type, payload, ts) VALUES " +
      "('s-old', 'main', 'message.completed', '{\"entryId\":\"e1\"}', '2024-01-01T00:00:01.000Z')," +
      "('s-old', 'main', 'turn.completed', '{}', '2024-01-01T00:00:02.000Z')",
  );
  db.exec(
    "INSERT INTO session_state (session_id, created_at, entries, turns, updated_at) VALUES " +
      "('s-old', '2024-01-01T00:00:00.000Z', " +
      "'[{\"id\":\"e1\",\"role\":\"user\",\"text\":\"旧库里的第一问\",\"turnId\":null,\"isSteer\":false,\"createdAt\":\"2024-01-01T00:00:01.000Z\"}]', " +
      "'[]', '2024-01-01T00:00:02.000Z')",
  );
  db.exec("INSERT INTO agent_lifecycle (session_id, state, updated_at) VALUES ('s-old', 'idle', '2024-01-01T00:00:02.000Z')");
  db.exec(
    "INSERT INTO tool_calls (id, session_id, tool_name, args, status, result, error, started_at, ended_at) VALUES " +
      "('tc-old', 's-old', 'bash', '{\"command\":\"echo hi\"}', 'completed', 'hi', NULL, '2024-01-01T00:00:01.500Z', '2024-01-01T00:00:02.000Z')",
  );
  db.close();
}

function columnsOf(db: Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

function pkOf(db: Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[]
  )
    .filter((c) => c.pk > 0)
    .map((c) => c.name);
}

describe("O-3：旧库守护式补列（F1.7 验收①）", () => {
  test("旧库文件打开即自动补列；domain_events 旧行 agent_instance_id 全为 main；服务正常", async () => {
    const dbPath = tmpDbPath();
    try {
      buildLegacyDb(dbPath);

      // 打开 = WriteQueue 构造（启动期守护迁移）
      const queue = new WriteQueue(dbPath);
      const repo = new SqliteSessionRepository(queue);
      const probe = new Database(dbPath, { readonly: true });

      // 列已补齐 + 索引就位
      expect(columnsOf(probe, "domain_events")).toContain("agent_instance_id");
      expect(columnsOf(probe, "tool_calls")).toContain("instance_id");
      // T9 图片下行：tool_calls.images 补列（旧行 NULL = 无图前向兼容）
      expect(columnsOf(probe, "tool_calls")).toContain("images");
      expect(columnsOf(probe, "agent_lifecycle")).toContain("instance_id");
      expect(pkOf(probe, "agent_lifecycle")).toEqual(["session_id", "instance_id"]);
      const indexes = (
        probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'domain_events'")
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(indexes).toContain("idx_domain_events_instance");

      // 旧行回填 main（O-3 裁决：回填常量 = 主实例固定 id）
      const eventIds = probe
        .prepare("SELECT agent_instance_id FROM domain_events ORDER BY id")
        .all() as { agent_instance_id: string }[];
      expect(eventIds.map((r) => r.agent_instance_id)).toEqual(["main", "main"]);
      expect(
        (probe.prepare("SELECT instance_id FROM tool_calls").get() as { instance_id: string }).instance_id,
      ).toBe("main");
      expect(
        (probe.prepare("SELECT instance_id FROM agent_lifecycle").get() as { instance_id: string }).instance_id,
      ).toBe("main");

      // daemon 正常服务：旧会话可恢复（entries 无 instanceId → 兜底 main）
      const restored = await repo.restore("s-old");
      expect(restored).toBeDefined();
      expect(restored!.agentState).toBe("idle");
      expect(restored!.session.entries[0]!.instanceId).toBe("main"); // fromRow 兜底
      expect(restored!.toolCalls[0]!.id).toBe("tc-old");

      // 新写入（带 SubAgent instanceId）照常
      const ev: DomainEvent = {
        type: "message.completed",
        sessionId: "s-old",
        instanceId: "agent-1",
        turnId: "t1",
        payload: { entryId: "e9" },
        occurredAt: "2024-01-02T00:00:00.000Z",
      };
      await queue.appendEvent(ev, "subagent");
      await queue.close();
      const after = new Database(dbPath, { readonly: true });
      const rows = after
        .prepare("SELECT agent_instance_id FROM domain_events WHERE type = 'message.completed' ORDER BY id")
        .all() as { agent_instance_id: string }[];
      after.close();
      expect(rows.map((r) => r.agent_instance_id)).toEqual(["main", "agent-1"]); // 旧行 main + 新行 agent-1
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("迁移幂等：二次打开不报错、数据完好", async () => {
    const dbPath = tmpDbPath();
    try {
      buildLegacyDb(dbPath);
      const q1 = new WriteQueue(dbPath);
      await q1.close();
      const q2 = new WriteQueue(dbPath); // 重启后再开：全部守护分支 no-op
      await q2.appendEvent({
        type: "engine.error",
        sessionId: "s-old",
        payload: { message: "x" },
        occurredAt: "2024-01-02T00:00:00.000Z",
      });
      await q2.close();

      const db = new Database(dbPath, { readonly: true });
      const count = (db.prepare("SELECT COUNT(*) AS c FROM domain_events").get() as { c: number }).c;
      const legacy = (
        db.prepare("SELECT COUNT(*) AS c FROM agent_lifecycle").get() as { c: number }
      ).c;
      db.close();
      expect(count).toBe(3); // 旧 2 + 新 1，无重复迁移副作用
      expect(legacy).toBe(1); // main 行未翻倍
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("新库直建新形状（列/复合 PK/索引一次到位，不走迁移分支）", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      await queue.appendEvent({
        type: "message.completed",
        sessionId: "s-new",
        turnId: "t1",
        payload: { entryId: "e1" },
        occurredAt: "2024-01-01T00:00:00.000Z",
      });
      await queue.close();
      const db = new Database(dbPath, { readonly: true });
      expect(pkOf(db, "agent_lifecycle")).toEqual(["session_id", "instance_id"]);
      expect(
        (db.prepare("SELECT agent_instance_id FROM domain_events").get() as { agent_instance_id: string })
          .agent_instance_id,
      ).toBe("main");
      db.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("F1.7 验收②：agent_lifecycle 复合 PK (session_id, instance_id) 多实例并存", () => {
  test("同会话 main + agent-1 + agent-2 三行并存可查；同键二写替换不重复", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      // main 行走既有写面（saveState 投影）
      const session = {
        sessionId: "s-multi",
        createdAt: "2024-01-01T00:00:00.000Z",
        entries: [],
        turns: [],
        pendingSteer: [],
      };
      await queue.saveState({ session, agentState: "running", toolCalls: [] });

      // SubAgent 实例行（T2.2 调度器写面未接，此处直写验证 schema 承载力）
      const db = queue.database;
      db.exec(
        "INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) VALUES " +
          "('s-multi', 'agent-1', 'running', '2024-01-01T00:00:05.000Z')," +
          "('s-multi', 'agent-2', 'queued', '2024-01-01T00:00:06.000Z')",
      );

      const rows = db
        .prepare("SELECT instance_id, state FROM agent_lifecycle WHERE session_id = 's-multi' ORDER BY instance_id")
        .all() as { instance_id: string; state: string }[];
      expect(rows).toEqual([
        { instance_id: "agent-1", state: "running" },
        { instance_id: "agent-2", state: "queued" },
        { instance_id: "main", state: "running" },
      ]);

      // 同键 upsert 替换（复合 PK 冲突面）
      db.exec(
        "INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) VALUES " +
          "('s-multi', 'agent-1', 'done', '2024-01-01T00:00:09.000Z') " +
          "ON CONFLICT(session_id, instance_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
      );
      const after = db
        .prepare("SELECT COUNT(*) AS c FROM agent_lifecycle WHERE session_id = 's-multi'")
        .get() as { c: number };
      const a1 = db
        .prepare("SELECT state FROM agent_lifecycle WHERE session_id = 's-multi' AND instance_id = 'agent-1'")
        .get() as { state: string };
      expect(after.c).toBe(3);
      expect(a1.state).toBe("done");
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});
