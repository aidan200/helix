import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { createPaths } from "../../src/infrastructure/paths";

/**
 * thinking 批 T1.2 跨冷恢复（test-design §2.3；architecture §3.4③/§5.5；AD-4③）：
 * - daemon 重启 → RestoreService 回放 domain_events（agent.thinking.changed）
 *   → 覆盖重建（引擎内存态恢复）；SessionStateView 携带 thinking{override,effective}；
 * - 恢复语义差异钉死（TR-AD-41 反例）：thinking 覆盖跨冷恢复 ≠ model.set 不跨冷恢复
 *   ——负断言：model 覆盖重启后仍不恢复；
 * - 恢复铁律：零新事件流零落盘（回放不产生新的 domain_events 行）。
 */

const tmpRoots: string[] = [];
function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-thinking-restore-"));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function thinkingRows(home: string): Promise<readonly unknown[]> {
  const queue = new WriteQueue(createPaths(home).dbPath());
  const rows = new SqliteSessionRepository(queue).queryEvents({ type: "agent.thinking.changed" });
  return queue.close().then(() => rows);
}

describe("跨冷恢复（F1.5 / NFR-3）", () => {
  test("重启后覆盖重建 + SessionStateView 携带 thinking；model 覆盖仍不恢复；零新事件流", async () => {
    const home = tmpHome();
    const engine1 = new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5", replies: [{ text: "首条回复。" }] });
    const d1 = await createTestDaemon({
      home,
      engine: engine1,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    const sid = d1.registry.currentSessionId();
    await d1.chat.sendMessage("暖场"); // 转正落库
    // thinking 覆盖 + model 覆盖（负断言素材：两者语义差异须钉死）
    await d1.model.setThinking(sid, "high");
    await d1.model.setModel(sid, "anthropic/claude-haiku-4-5");
    const viewBefore = structuredClone(d1.session.getSnapshot());
    expect(viewBefore.thinking).toEqual({ override: "high", effective: "high" }); // Fake 契约等价面：恒支持
    expect(viewBefore.model).toBe("anthropic/claude-haiku-4-5");
    await d1.shutdown();
    expect(await thinkingRows(home)).toHaveLength(1); // 覆盖事件经单写队列落盘一行

    // 重启：RestoreService 回放重建（同 --home）
    const engine2 = new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5", replies: [{ text: "重启后回复。" }] });
    const d2 = await createTestDaemon({
      home,
      engine: engine2,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const viewAfter = d2.session.getSnapshot();
      // ① thinking 覆盖跨冷恢复：快照携带且与重启前一致（UI 与引擎一致）
      expect(viewAfter.thinking).toEqual(viewBefore.thinking);
      // ② 负断言钉死：model 覆盖仍不恢复（≠ thinking 语义，AD-4③/F-5）
      expect(viewAfter.model).toBe("anthropic/claude-sonnet-4-5");
      expect(viewAfter.model).not.toBe(viewBefore.model);
      // ③ 恢复铁律：零新事件流零落盘（回放不追加 domain_events 行）
      expect(await thinkingRows(home)).toHaveLength(1);
      // ④ 恢复后是活会话：覆盖态随引擎延续（Fake 观测面）
      expect(d2.registry.peek(sid)!.chatService.currentThinking).toEqual({ override: "high", effective: "high" });
    } finally {
      await d2.shutdown();
    }
  }, 20000);

  test("多次覆盖取最后一帧（事件流回放末值生效）", async () => {
    const home = tmpHome();
    const d1 = await createTestDaemon({
      home,
      engine: new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5", replies: [{ text: "r1" }] }),
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    const sid = d1.registry.currentSessionId();
    await d1.chat.sendMessage("暖场");
    await d1.model.setThinking(sid, "low");
    await d1.model.setThinking(sid, "xhigh");
    await d1.shutdown();

    const d2 = await createTestDaemon({
      home,
      engine: new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5" }),
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect(d2.session.getSnapshot().thinking).toEqual({ override: "xhigh", effective: "xhigh" });
    } finally {
      await d2.shutdown();
    }
  }, 20000);
});
