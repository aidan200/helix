import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { WriteQueue } from "../../../src/adapters/driven/sqlite-session/WriteQueue";
import type { DomainEvent } from "../../../src/domain/events/DomainEvent";
import type { PersistedDomainState } from "../../../src/application/ports/outbound/SessionRepositoryPort";
import { Session } from "../../../src/domain/session/Session";
import { ToolCallRecord } from "../../../src/domain/tools/ToolCallRecord";

/**
 * TP-CL8-2（U+I 半）：WriteQueue 单写队列行为——
 * ① 并发 N 事件入队 → 落盘顺序与入队序一致（FIFO 串行化）；
 * ② drain/flush 完成后队列清空、close 释放连接；
 * ③ WAL 模式（`PRAGMA journal_mode` = wal）+ db 文件在给定路径。
 * 全程 tmp 目录（不碰真实 ~/.helix）。
 */
function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "helix-wq-")), "helix.db");
}

function ev(n: number, sessionId = "s1"): DomainEvent {
  return {
    type: "message.completed",
    sessionId,
    turnId: "t1",
    payload: { n },
    occurredAt: new Date(1_700_000_000_000 + n).toISOString(),
  };
}

function stateOf(sessionId: string): PersistedDomainState {
  const session = Session.create(sessionId, "2024-01-01T00:00:00.000Z");
  session.appendUserEntry(`用户消息-${sessionId}`, "2024-01-01T00:00:01.000Z");
  return { session: session.toSnapshot(), agentState: "running", toolCalls: [] };
}

describe("M15：deleteSession 落定后 sessionTails 仓位条目清理（杜绝无界增长）", () => {
  test("deleteSession 后该会话 tail 条目删除；后续写重建仓位且行为不变", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      const tails = (queue as unknown as { sessionTails: Map<string, Promise<unknown>> }).sessionTails;
      await queue.appendEvent(ev(1, "s-del"));
      expect(tails.has("s-del")).toBe(true);
      await queue.deleteSession("s-del");
      // 落定后仓位条目清理（微任务冲洗确保清理链跑完）
      await queue.flush();
      expect(tails.has("s-del")).toBe(false);
      // 删除后新写重建仓位，行为不变（写-读往返正常）
      await queue.appendEvent(ev(2, "s-del"));
      expect(tails.has("s-del")).toBe(true);
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare("SELECT payload FROM domain_events WHERE session_id = 's-del'").all();
      db.close();
      expect(rows.length).toBe(1); // 仅删除后写入的 ev(2)
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("deleteSession 后新入队的同会话写不被误清（尾部位移守卫）", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      const tails = (queue as unknown as { sessionTails: Map<string, Promise<unknown>> }).sessionTails;
      const del = queue.deleteSession("s-race");
      const write = queue.appendEvent(ev(3, "s-race")); // 删除后同会话新写（尾部位移）
      await Promise.all([del, write]);
      await queue.flush();
      // 清理只删「尾部仍为本 delete job」的条目——新写入队后 tail 已位移，不误清
      expect(tails.has("s-race")).toBe(true);
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("TP-CL8-2：WriteQueue FIFO 保序 + drain", () => {
  test("① 并发 N 事件入队 → 落盘顺序与入队序一致", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      const N = 60;
      // 并发入队（不 await 逐个，全部在飞）：事件与状态保存混排
      const jobs: Promise<void>[] = [];
      for (let i = 0; i < N; i++) {
        jobs.push(queue.appendEvent(ev(i)));
        if (i % 10 === 0) jobs.push(queue.saveState(stateOf("s1")));
      }
      await queue.flush();
      await Promise.all(jobs);

      const db = new Database(dbPath, { readonly: true });
      const rows = db
        .prepare("SELECT payload FROM domain_events ORDER BY id")
        .all() as { payload: string }[];
      db.close();
      expect(rows.length).toBe(N);
      expect(rows.map((r) => JSON.parse(r.payload!).n)).toEqual(Array.from({ length: N }, (_, i) => i));
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("② write-through：appendEvent resolve 后立即可查（非批量延迟）", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      await queue.appendEvent(ev(0));
      const db = new Database(dbPath, { readonly: true });
      const count = (db.prepare("SELECT COUNT(*) AS c FROM domain_events").get() as { c: number }).c;
      db.close();
      expect(count).toBe(1);
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("③ close 前 drain：未 await 的入队任务全部落盘", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      for (let i = 0; i < 20; i++) void queue.appendEvent(ev(i)); // 不 await
      await queue.close(); // 优雅退出 drain
      const db = new Database(dbPath, { readonly: true });
      const count = (db.prepare("SELECT COUNT(*) AS c FROM domain_events").get() as { c: number }).c;
      db.close();
      expect(count).toBe(20);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("④ 单 job 失败不阻断后续（onError 上报、链继续）", async () => {
    const dbPath = tmpDbPath();
    try {
      const errors: string[] = [];
      const queue = new WriteQueue(dbPath, { onError: (err) => errors.push((err as Error).message) });
      await queue.appendEvent(ev(0));
      // 关闭后到达的 job 视为退出竞态：onError 上报、不抛未处理 rejection、链不断
      await queue.close();
      await queue.appendEvent(ev(1));
      await queue.saveState(stateOf("s1"));
      expect(errors.length).toBe(2);
      expect(errors[0]).toContain("已关闭");

      const db = new Database(dbPath, { readonly: true });
      const count = (db.prepare("SELECT COUNT(*) AS c FROM domain_events").get() as { c: number }).c;
      db.close();
      expect(count).toBe(1); // 关闭前的那条已落盘，关闭后两条被丢弃
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("TP-CL8-2：WAL 模式与 db 路径", () => {
  test("journal_mode=wal + db 文件在给定路径 + -wal 副文件出现", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      await queue.appendEvent(ev(0));
      expect(existsSync(dbPath)).toBe(true); // db 路径 = 传入路径（<home>/helix.db）
      expect(existsSync(`${dbPath}-wal`)).toBe(true); // WAL 模式的伴生文件

      const probe = new Database(dbPath, { readonly: true });
      const mode = probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      probe.close();
      expect(mode.journal_mode).toBe("wal");
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("重复打开同一路径幂等（CREATE IF NOT EXISTS）", async () => {
    const dbPath = tmpDbPath();
    try {
      const q1 = new WriteQueue(dbPath);
      await q1.appendEvent(ev(0));
      await q1.close();
      const q2 = new WriteQueue(dbPath); // 重启后再次打开
      await q2.appendEvent(ev(1));
      await q2.close();
      const db = new Database(dbPath, { readonly: true });
      const count = (db.prepare("SELECT COUNT(*) AS c FROM domain_events").get() as { c: number }).c;
      db.close();
      expect(count).toBe(2);
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("WriteQueue 状态保存（saveState 投影行）", () => {
  test("saveState 后投影表四类行可查（read side 由 repository 覆盖，这里验写入面）", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      const session = Session.create("s-proj", "2024-01-01T00:00:00.000Z");
      session.appendUserEntry("问", "2024-01-01T00:00:01.000Z");
      const tool = ToolCallRecord.create("tc-1", "bash", { command: "echo hi" });
      tool.markRunning("2024-01-01T00:00:02.000Z");
      tool.complete("hi", "2024-01-01T00:00:03.000Z");
      await queue.saveState({ session: session.toSnapshot(), agentState: "steering", toolCalls: [tool.toData()] });
      await queue.flush();

      const db = new Database(dbPath, { readonly: true });
      const sessionRow = db.prepare("SELECT session_id FROM session_state").get() as { session_id: string };
      const lifecycle = db.prepare("SELECT state FROM agent_lifecycle").get() as { state: string };
      const toolCount = (db.prepare("SELECT COUNT(*) AS c FROM tool_calls").get() as { c: number }).c;
      db.close();
      expect(sessionRow.session_id).toBe("s-proj");
      expect(lifecycle.state).toBe("steering");
      expect(toolCount).toBe(1);
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("T10a：session_state.main_instance_id 列（方案 A 主实例 id 持久化）", () => {
  test("新会话主实例 id 随状态行落盘往返；旧行 NULL = legacy \"main\" 兼容", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      const state = stateOf("s-mid");
      await queue.saveState(state);
      await queue.flush();

      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare("SELECT main_instance_id FROM session_state WHERE session_id = ?").get("s-mid") as {
        main_instance_id: string | null;
      };
      db.close();
      // 新会话：列值 = 会话主实例 id（agent-<唯一串>，非 "main"）
      expect(row.main_instance_id).toBe(state.session.mainInstanceId!);
      expect(row.main_instance_id).toMatch(/^agent-/);
      expect(row.main_instance_id).not.toBe("main");

      // 守护式演进幂等：重开同库不报错（列已存在 no-op）
      const reopened = new WriteQueue(dbPath);
      await reopened.close();
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("旧库（无 main_instance_id 列）打开后守护补列，存量行 NULL = legacy \"main\"", async () => {
    const dbPath = tmpDbPath();
    try {
      // 先造列前时代旧库形状（session_state 无 main_instance_id 列）
      const raw = new Database(dbPath);
      raw.exec(
        "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, entries TEXT NOT NULL, turns TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      raw.exec(
        "INSERT INTO session_state (session_id, created_at, entries, turns, updated_at) VALUES ('s-old', '2024-01-01T00:00:00.000Z', '[]', '[]', '2024-01-01T00:00:00.000Z')",
      );
      raw.close();

      const queue = new WriteQueue(dbPath); // 守护式演进：补列
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare("SELECT main_instance_id FROM session_state WHERE session_id = ?").get("s-old") as {
        main_instance_id: string | null;
      };
      db.close();
      expect(row.main_instance_id).toBeNull(); // 存量行 NULL（读取侧兜底 legacy "main"）
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

// ── P1 T3：session_state.mode 列（会话模式持久化，T10a 同构） ──

describe("P1 T3：session_state.mode 列（建会话定格 mode 随状态行落盘）", () => {
  test("快照携带 mode → 落列；快照不携带（列前/缺省）→ NULL；新库建表即含列", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      // mode 定格形状（建会话链 createFresh 经 resolveModeId 归一后落库）
      const withMode = Session.create("s-mode", "2024-01-01T00:00:00.000Z", "default");
      withMode.appendUserEntry("模式会话首条", "2024-01-01T00:00:01.000Z");
      await queue.saveState({ session: withMode.toSnapshot(), agentState: "running", toolCalls: [] });
      // 列前时代快照形状（旧聚合无 mode 键——Session.create 未传第三参）
      const noMode = stateOf("s-nomode");
      expect(noMode.session.mode).toBeUndefined();
      await queue.saveState(noMode);
      await queue.flush();

      const db = new Database(dbPath, { readonly: true });
      const rowMode = db.prepare("SELECT mode FROM session_state WHERE session_id = ?").get("s-mode") as {
        mode: string | null;
      };
      const rowNoMode = db.prepare("SELECT mode FROM session_state WHERE session_id = ?").get("s-nomode") as {
        mode: string | null;
      };
      db.close();
      expect(rowMode.mode).toBe("default"); // 携带 → 随首行 INSERT 落列
      expect(rowNoMode.mode).toBeNull(); // 不携带 → NULL（读取侧 default 兑底）
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("旧库（无 mode 列）打开后守护补列，存量行 NULL = default 语义（读取侧归一）", async () => {
    const dbPath = tmpDbPath();
    try {
      // 先造列前时代旧库形状（session_state 无 mode 列）
      const raw = new Database(dbPath);
      raw.exec(
        "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, entries TEXT NOT NULL, turns TEXT NOT NULL, updated_at TEXT NOT NULL, main_instance_id TEXT)",
      );
      raw.exec(
        "INSERT INTO session_state (session_id, created_at, entries, turns, updated_at) VALUES ('s-old', '2024-01-01T00:00:00.000Z', '[]', '[]', '2024-01-01T00:00:00.000Z')",
      );
      raw.close();

      const queue = new WriteQueue(dbPath); // 守护式演进：补列
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare("SELECT mode FROM session_state WHERE session_id = ?").get("s-old") as {
        mode: string | null;
      };
      db.close();
      expect(row.mode).toBeNull(); // 存量行 NULL（恢复链 RestoreService 归一 default）
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("updated_at 语义修复回填（历史脏行 → 真实活动时间）", () => {
  test("打开旧库：脏行 updated_at 回填为末条 entry createdAt；空 entries 兜底 created_at；幂等重开零变化", async () => {
    const dbPath = tmpDbPath();
    try {
      // 造「sealAll 落盘墙钟」污染的脏库：updated_at 远晚于真实活动时间
      const raw = new Database(dbPath);
      raw.exec(
        "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, entries TEXT NOT NULL, turns TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      const entries = JSON.stringify([
        { id: "e1", role: "user", text: "问", createdAt: "2024-01-01T00:00:01.000Z" },
        { id: "e2", role: "assistant", text: "答", createdAt: "2024-01-01T00:00:09.000Z" },
      ]);
      raw.exec(
        `INSERT INTO session_state VALUES ('s-dirty', '2024-01-01T00:00:00.000Z', '${entries}', '[]', '2026-09-01T04:10:05.000Z')`,
      );
      raw.exec(
        "INSERT INTO session_state VALUES ('s-empty', '2024-01-02T00:00:00.000Z', '[]', '[]', '2026-09-01T04:10:05.000Z')",
      );
      raw.close();

      const queue = new WriteQueue(dbPath); // 守护迁移：回填
      const db = new Database(dbPath, { readonly: true });
      const dirty = db.prepare("SELECT updated_at FROM session_state WHERE session_id = 's-dirty'").get() as { updated_at: string };
      const empty = db.prepare("SELECT updated_at FROM session_state WHERE session_id = 's-empty'").get() as { updated_at: string };
      db.close();
      expect(dirty.updated_at).toBe("2024-01-01T00:00:09.000Z"); // 末条 entry createdAt
      expect(empty.updated_at).toBe("2024-01-02T00:00:00.000Z"); // 空 entries 兜底 created_at

      // 幂等：重开同库零变化（WHERE IS NOT 不再命中）
      const reopened = new WriteQueue(dbPath);
      const db2 = new Database(dbPath, { readonly: true });
      const again = db2.prepare("SELECT updated_at FROM session_state WHERE session_id = 's-dirty'").get() as { updated_at: string };
      db2.close();
      expect(again.updated_at).toBe("2024-01-01T00:00:09.000Z");
      await reopened.close();
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("T2.3 closure 写面：closure_records 记录行 + reportPath 文件产物（O-5）", () => {
  test("saveClosureRecord 落盘后重开（进程内级重启）可读回；findings 保 JSON", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      await queue.saveClosureRecord("s-1", "agent-3", "done", {
        status: "done",
        summary: "任务完成",
        reportPath: "/tmp/reports/s-1/agent-3.md",
        findings: [{ kind: "sediment", desc: "x" }],
        taskId: "T2.3",
      });
      await queue.saveClosureRecord("s-1", "agent-4", "killed", {
        status: "failed",
        summary: "已由用户终止（kill）",
        reportPath: null,
        findings: null,
        taskId: null,
      });
      await queue.close(); // 优雅退出（drain 后关连接）

      // 重启（进程内级）：新 WriteQueue 实例同一路径读回
      const reopened = new WriteQueue(dbPath);
      const rows = reopened.database
        .prepare(
          "SELECT agent_id, result, status, summary, report_path, findings, task_id FROM closure_records WHERE session_id = ? ORDER BY id",
        )
        .all("s-1") as {
        agent_id: string;
        result: string;
        status: string;
        summary: string;
        report_path: string | null;
        findings: string | null;
        task_id: string | null;
      }[];
      await reopened.close();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        agent_id: "agent-3",
        result: "done",
        status: "done",
        summary: "任务完成",
        report_path: "/tmp/reports/s-1/agent-3.md",
        task_id: "T2.3",
      });
      expect(JSON.parse(rows[0]!.findings!)).toEqual([{ kind: "sediment", desc: "x" }]);
      expect(rows[1]).toMatchObject({ agent_id: "agent-4", result: "killed", status: "failed", report_path: null, findings: null, task_id: null });
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("saveReportFile：报告 markdown 经同队列落盘（flush 后文件可读、重启后仍在）", async () => {
    const dbPath = tmpDbPath();
    const reportPath = path.join(path.dirname(dbPath), "reports", "s-1", "agent-3.md");
    try {
      const queue = new WriteQueue(dbPath);
      await queue.saveReportFile(reportPath, "# 任务报告：agent-3\n\n- 收口：done\n");
      await queue.flush();
      expect(existsSync(reportPath)).toBe(true);
      await queue.close();

      // “重启”（进程内级）：新实例不碰报告文件，但文件已在磁盘上
      const reopened = new WriteQueue(dbPath);
      await reopened.close();
      const content = await Bun.file(reportPath).text();
      expect(content).toContain("agent-3");
      expect(content).toContain("done");
      expect(existsSync(reportPath + ".tmp")).toBe(false); // 临时文件不残留
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("T2.2 分仓（AD-4）：每会话独立仓位按 session_id 路由 + 会话删除", () => {
  test("两会话并发写入各自仓内保序；互不丢行；deleteSession 后全表清行且先于删除的写全落", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      // 两会话并发混排入队（不 await——在飞交错）
      const jobs: Promise<void>[] = [];
      for (let i = 0; i < 30; i++) {
        jobs.push(queue.appendEvent(ev(i, "sA")));
        jobs.push(queue.appendEvent(ev(i, "sB")));
        if (i % 10 === 0) jobs.push(queue.saveState(stateOf("sA")));
        if (i % 7 === 0) jobs.push(queue.saveState(stateOf("sB")));
      }
      await queue.flush();
      await Promise.all(jobs);

      const db = new Database(dbPath, { readonly: true });
      const rowsA = db
        .prepare("SELECT payload FROM domain_events WHERE session_id = ? ORDER BY id")
        .all("sA") as { payload: string }[];
      const rowsB = db
        .prepare("SELECT payload FROM domain_events WHERE session_id = ? ORDER BY id")
        .all("sB") as { payload: string }[];
      // 各自仓内 FIFO 保序（跨会话无序约束——仓间互不阻塞）
      expect(rowsA.map((r) => JSON.parse(r.payload!).n)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      expect(rowsB.map((r) => JSON.parse(r.payload!).n)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      const stateRows = db.prepare("SELECT session_id FROM session_state").all() as { session_id: string }[];
      expect(stateRows.map((r) => r.session_id).sort()).toEqual(["sA", "sB"]);
      db.close();

      // 删除 sA：先于删除的写（同仓 FIFO）全部落盘，随后六表清行；sB 不受影响
      jobs.push(queue.appendEvent(ev(99, "sA")));
      await Promise.all(jobs);
      await queue.deleteSession("sA");
      await queue.flush();

      const db2 = new Database(dbPath, { readonly: true });
      expect(db2.prepare("SELECT COUNT(*) AS n FROM session_state WHERE session_id = ?").get("sA")).toEqual({ n: 0 });
      expect(db2.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE session_id = ?").get("sA")).toEqual({ n: 0 });
      expect(db2.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE session_id = ?").get("sB")).toEqual({ n: 30 });
      expect(db2.prepare("SELECT COUNT(*) AS n FROM session_state WHERE session_id = ?").get("sB")).toEqual({ n: 1 });
      db2.close();
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});
