import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WriteQueue } from "../../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { PersistedDomainState } from "../../../src/application/ports/outbound/SessionRepositoryPort";
import { Session } from "../../../src/domain/session/Session";

/**
 * 语音闭环批 ④：readSessionTitle 单会话短标题点读（title > topic > 首条
 * user entry——与 listSessionMetadata 同优先级，但不拉全表）。
 */
function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "helix-title-")), "helix.db");
}

function stateOf(sessionId: string, opts: { title?: string; topic?: string; firstUser?: string } = {}): PersistedDomainState {
  const session = Session.create(sessionId, "2024-01-01T00:00:00.000Z");
  if (opts.firstUser !== undefined) session.appendUserEntry(opts.firstUser, "2024-01-01T00:00:01.000Z");
  const snap = session.toSnapshot();
  return {
    session: {
      ...snap,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
    },
    agentState: "running",
    toolCalls: [],
  };
}

describe("④ readSessionTitle（单会话短标题点读）", () => {
  test("title > topic > 首条 user entry 优先级；不存在 → undefined", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      const repo = new SqliteSessionRepository(queue);
      await repo.save(stateOf("s-title", { title: "显式标题", topic: "演进主题", firstUser: "首条用户消息" }));
      await repo.save(stateOf("s-topic", { topic: "演进主题", firstUser: "首条用户消息" }));
      await repo.save(stateOf("s-first", { firstUser: "首条用户消息" }));
      await repo.save(stateOf("s-empty"));

      expect(await repo.readSessionTitle("s-title")).toBe("显式标题");
      expect(await repo.readSessionTitle("s-topic")).toBe("演进主题");
      expect(await repo.readSessionTitle("s-first")).toBe("首条用户消息");
      expect(await repo.readSessionTitle("s-empty")).toBeUndefined();
      expect(await repo.readSessionTitle("s-nope")).toBeUndefined();
      await queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});
