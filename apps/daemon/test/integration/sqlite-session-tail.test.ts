/**
 * readSessionTail 集成测试（会话内容级感知 M3：repo 层尾部投影读面）。
 *
 * 断言面：
 * 1. 尾部 N 条投影：role/text 直读（旧→新序）；n > 总数 = 全量；
 * 2. 单条截断 300（Unicode 码点 + 省略号）——LLM 面体量护栏在出口处；
 * 3. 点读单行成本（SELECT entries 单行——与 restore 同级，投影后原文即弃）；
 * 4. 不存在 sessionId → undefined（引导层判据）。
 */
import { describe, expect, test, afterAll } from "bun:test";
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

// ── 参数化批（回递全文 + 深读翻页——2026-10-11 用户裁决）──────────
// 缺省行为（单条截 300）由上方②钉位不变；本块断言 opts 两参数：
// maxEntryChars=Infinity（回递链路全文入诊）/ entryOffset（管家逐条翻页）。

describe("readSessionTail 参数化（maxEntryChars / entryOffset）", () => {
  /** TR-152：登记数组 + afterAll 幂等回收（finally 内 close 招错不得跳过 rm）。 */
  const homes: string[] = [];
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  async function openRepo(): Promise<{ repo: SqliteSessionRepository; queue: WriteQueue }> {
    const home = tmpHome();
    homes.push(home);
    const queue = new WriteQueue(path.join(home, "helix.db"));
    return { repo: new SqliteSessionRepository(queue), queue };
  }

  test("④ maxEntryChars=Infinity：单条全文（回递链路全文入诊——用户裁决）", async () => {
    const { repo, queue } = await openRepo();
    const long = "全文".repeat(400); // 800 码点 > 300
    await saveWithMessages(repo, "sess-full", [{ role: "user", text: long }]);
    const rows = await repo.readSessionTail("sess-full", 1, { maxEntryChars: Infinity });
    expect(rows![0]!.text).toBe(long); // 无省略号、无截断
    queue.close();
  });

  test("⑤ entryOffset 翻页：跳过最近 N 条读更早窗口（旧→新序保持）", async () => {
    const { repo, queue } = await openRepo();
    await saveWithMessages(repo, "sess-page", [
      { role: "user", text: "第一条" },
      { role: "user", text: "第二条" },
      { role: "user", text: "第三条" },
      { role: "user", text: "第四条" },
      { role: "user", text: "第五条" },
    ]);
    // 跳过最近 2 条（第五/四），取 2 条（第二/三——旧→新序保持）；offset 0 = 现状尾窗
    const page = await repo.readSessionTail("sess-page", 2, { entryOffset: 2 });
    expect(page!.map((r) => r.text)).toEqual(["第二条", "第三条"]);
    const tail = await repo.readSessionTail("sess-page", 2);
    expect(tail!.map((r) => r.text)).toEqual(["第四条", "第五条"]);
    queue.close();
  });

  test("⑥ offset ≥ 条目数 → 空窗口（翻页越界 = 空数组非 undefined）", async () => {
    const { repo, queue } = await openRepo();
    await saveWithMessages(repo, "sess-over", [{ role: "user", text: "唯一" }]);
    expect(await repo.readSessionTail("sess-over", 6, { entryOffset: 10 })).toEqual([]);
    queue.close();
  });

  test("⑦ offset × 全文组合：翻页模式读更早的长条目不截（体量靠翻页不靠截断）", async () => {
    const { repo, queue } = await openRepo();
    const long = "早".repeat(450);
    await saveWithMessages(repo, "sess-mix", [
      { role: "user", text: long },
      { role: "user", text: "短" },
    ]);
    const page = await repo.readSessionTail("sess-mix", 1, { entryOffset: 1, maxEntryChars: Infinity });
    expect(page![0]!.text).toBe(long);
    queue.close();
  });
});
