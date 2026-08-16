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
