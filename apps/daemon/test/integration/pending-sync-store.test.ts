import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { Session } from "../../src/domain/session/Session";
import { ToolCallRecord } from "../../src/domain/tools/ToolCallRecord";
import type { PersistedDomainState } from "../../src/application/ports/outbound/SessionRepositoryPort";

/**
 * W2-D（R13/R22）pending_sync 持久化集成（TR-TEST-4 真 SQLite @ tmp）：
 * - 写类工具成功调用判定（v1 口径：仅 edit/write 工具名 + completed；
 *   bash 写操作难判定不算、edit-lines 不在第一版集合内、failed 不算）；
 * - savePendingSync upsert（新变更 changed_at 刷新 + notified 复位 0）；
 * - queryUnnotifiedPendingSync（任务会话 sessionId 或 job_id 命中，notified=0）；
 * - markPendingSyncNotified 幂等置位；
 * - deleteSession 级联清 pending_sync 行。
 */

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-w2d-store-"));
}

function completedTool(id: string, toolName: string) {
  const record = ToolCallRecord.create(id, toolName, { path: "/x" });
  record.markRunning("2024-01-01T00:00:01.000Z");
  record.complete("ok", "2024-01-01T00:00:02.000Z");
  return record.toData();
}

function failedTool(id: string, toolName: string) {
  const record = ToolCallRecord.create(id, toolName, { path: "/x" });
  record.markRunning("2024-01-01T00:00:01.000Z");
  record.fail("boom", "2024-01-01T00:00:02.000Z");
  return record.toData();
}

async function saveWithTools(
  repo: SqliteSessionRepository,
  sessionId: string,
  toolCalls: PersistedDomainState["toolCalls"],
): Promise<void> {
  const session = Session.create(sessionId, "2024-01-01T00:00:00.000Z");
  await repo.save({ session: session.toSnapshot(), agentState: "idle", toolCalls });
}

describe("W2-D pending_sync 持久化", () => {
  test("hasSuccessfulWriteToolCall：edit/write completed 命中；bash/edit-lines/failed/无记录不命中", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);

      // tool_calls.id 为表单主键——跨会话复用同 id 会撞键，按会话派生唯一 id
      await saveWithTools(repo, "s-edit", [completedTool("s-edit-t1", "edit")]);
      await saveWithTools(repo, "s-write", [completedTool("s-write-t1", "write")]);
      await saveWithTools(repo, "s-bash", [completedTool("s-bash-t1", "bash")]);
      await saveWithTools(repo, "s-edit-lines", [completedTool("s-edit-lines-t1", "edit-lines")]);
      await saveWithTools(repo, "s-failed", [failedTool("s-failed-t1", "edit")]);
      await saveWithTools(repo, "s-mixed", [failedTool("s-mixed-t1", "edit"), completedTool("s-mixed-t2", "write")]);

      expect(repo.hasSuccessfulWriteToolCall("s-edit")).toBe(true);
      expect(repo.hasSuccessfulWriteToolCall("s-write")).toBe(true);
      expect(repo.hasSuccessfulWriteToolCall("s-mixed")).toBe(true);
      expect(repo.hasSuccessfulWriteToolCall("s-bash")).toBe(false); // 口径：bash 写操作难判定，第一版不算
      expect(repo.hasSuccessfulWriteToolCall("s-edit-lines")).toBe(false); // 口径：第一版只认 edit/write 工具名
      expect(repo.hasSuccessfulWriteToolCall("s-failed")).toBe(false);
      expect(repo.hasSuccessfulWriteToolCall("s-absent")).toBe(false);
      await queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("savePendingSync upsert：插入 → 置提示 → 新变更复位 notified=0 并刷新 changed_at", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);

      await repo.savePendingSync("task:job-1", "job-1", "2024-01-01T00:00:10.000Z");
      expect(repo.queryUnnotifiedPendingSync("task:job-1", "job-1")).toEqual([
        { sessionId: "task:job-1", jobId: "job-1", changedAt: "2024-01-01T00:00:10.000Z" },
      ]);

      await repo.markPendingSyncNotified(["task:job-1"]);
      expect(repo.queryUnnotifiedPendingSync("task:job-1", "job-1")).toEqual([]);

      // 新变更：upsert 刷新 changed_at + notified 复位 0（同主键单行）
      await repo.savePendingSync("task:job-1", "job-1", "2024-01-01T00:01:00.000Z");
      expect(repo.queryUnnotifiedPendingSync("task:job-1", "job-1")).toEqual([
        { sessionId: "task:job-1", jobId: "job-1", changedAt: "2024-01-01T00:01:00.000Z" },
      ]);
      await queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("queryUnnotifiedPendingSync：sessionId 或 job_id 双径命中；他会话/他 job 行不命中", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);

      await repo.savePendingSync("task:job-1", "job-1", "2024-01-01T00:00:10.000Z");
      await repo.savePendingSync("chat-s-1", null, "2024-01-01T00:00:11.000Z"); // chat 场景 job_id 可空

      // 任务会话命中
      expect(repo.queryUnnotifiedPendingSync("task:job-1", "job-1").map((r) => r.sessionId)).toEqual(["task:job-1"]);
      // chat 会话命中（job_id null 行按 sessionId 命中；探测 jobId 取无碰撞值——
      // 双径 OR 语义下传 "job-1" 会连同任务行一起命中，非本断言意图）
      expect(repo.queryUnnotifiedPendingSync("chat-s-1", "job-9").map((r) => r.sessionId)).toEqual(["chat-s-1"]);
      // 无关会话/job 不命中
      expect(repo.queryUnnotifiedPendingSync("task:job-2", "job-2")).toEqual([]);
      await queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("deleteSession 级联清 pending_sync 行", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);

      await saveWithTools(repo, "s-del", [completedTool("t1", "edit")]);
      await repo.savePendingSync("s-del", null, "2024-01-01T00:00:10.000Z");
      expect(repo.queryUnnotifiedPendingSync("s-del", "job-x")).toHaveLength(1);

      await repo.deleteSession("s-del");
      expect(repo.queryUnnotifiedPendingSync("s-del", "job-x")).toEqual([]);
      await queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
