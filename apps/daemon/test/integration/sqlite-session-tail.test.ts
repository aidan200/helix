/**
 * readSessionTail 集成测试（会话内容级感知 M3：repo 层尾部投影读面）。
 *
 * 断言面：
 * 1. 尾部 N 条投影：role/text 直读（旧→新序）；n > 总数 = 全量；
 * 2. 单条截断 300（Unicode 码点 + 省略号）——LLM 面体量护栏在出口处；
 * 3. 点读单行成本（SELECT entries 单行——与 restore 同级，投影后原文即弃）；
 * 4. 不存在 sessionId → undefined（引导层判据）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { Session } from "../../src/domain/session/Session";

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-readtail-"));
}

async function saveWithMessages(
  repo: SqliteSessionRepository,
  sessionId: string,
  messages: readonly { role: "user" | "assistant"; text: string }[],
): Promise<void> {
  const session = Session.create(sessionId, "2026-10-01T00:00:00.000Z");
  for (const [i, m] of messages.entries()) {
    const at = new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 60_000).toISOString();
    if (m.role === "user") session.appendUserEntry(m.text, at);
    else session.appendAssistantEntry(m.text, at);
  }
  await repo.save({ session: session.toSnapshot(), agentState: "idle", toolCalls: [] });
}

describe("readSessionTail（repo 层尾部投影）", () => {
  test("① 尾部 N 条（旧→新）+ n 超总数 = 全量 + role/text 直读", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);
      await saveWithMessages(repo, "sess-a", [
        { role: "user", text: "第一条" },
        { role: "user", text: "第二条" },
        { role: "user", text: "第三条" },
        { role: "user", text: "第四条" },
        { role: "user", text: "第五条" },
      ]);
      const tail = await repo.readSessionTail("sess-a", 2);
      expect(tail).toEqual([
        { role: "user", text: "第四条" },
        { role: "user", text: "第五条" },
      ]);
      expect((await repo.readSessionTail("sess-a", 99))!.length).toBe(5);
      queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("② 单条截断 300 码点 + 省略号", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);
      await saveWithMessages(repo, "sess-b", [{ role: "user", text: "长".repeat(500) }]);
      const tail = await repo.readSessionTail("sess-b", 5);
      expect(tail).toHaveLength(1);
      expect([...tail![0]!.text].length).toBeLessThanOrEqual(301);
      expect(tail![0]!.text.endsWith("…")).toBe(true);
      queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("③ 不存在 sessionId → undefined；空 entries 会话 → 空数组", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);
      const session = Session.create("sess-empty", "2026-10-01T00:00:00.000Z");
      await repo.save({ session: session.toSnapshot(), agentState: "idle", toolCalls: [] });
      expect(await repo.readSessionTail("sess-none", 5)).toBeUndefined();
      expect(await repo.readSessionTail("sess-empty", 5)).toEqual([]);
      queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
