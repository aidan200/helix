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
