import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * TP-CL8-6 / TP-CL8-7：重启恢复两变体 + 恢复后活会话。
 * - 优雅变体（进程内 SIGTERM 语义 = shutdown() drain）：对话（含工具轮）
 *   → 停 daemon → 重启（createDaemon 同 --home）→ 快照与停前一致 → 续对话。
 * - 强杀变体（真实子进程 SIGKILL）：流式中 + steer 已落盘 → kill -9 →
 *   重启 → 恢复到最后一致里程碑（半截流式丢弃、open turn 收口 interrupted、
 *   未消费 steer 保留）→ 会话可继续。
 */
function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-restore-"));
}

async function spawnHangDaemon(home: string): Promise<void> {
  const fixture = path.join(import.meta.dir, "..", "fixtures", "hang-daemon.ts");
  const proc = Bun.spawn({
    cmd: [process.execPath, fixture, "--home", home],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // 轮询崩溃现场标记（fixture 在「流式中 + steer 已落盘」时写）
  const marker = path.join(home, "hang.marker");
  const t0 = Date.now();
  while (!existsSync(marker)) {
    if (Date.now() - t0 > 20_000) throw new Error("hang-daemon 夹具未进入流式现场（marker 超时）");
    await new Promise((r) => setTimeout(r, 10));
  }
  // 现场就绪：SIGKILL 强杀（不给优雅退出/drain 的机会）
  proc.kill("SIGKILL");
  await proc.exited;
}

describe("TP-CL8-6 优雅变体：SIGTERM 语义停机 → 重启恢复一致", () => {
  test("含工具轮对话 → shutdown（drain）→ 重启 → 快照一致 + 工具记录在库", async () => {
    const home = tmpHome();
    try {
      const engine1 = new FakeAgentEngine({
        replies: [
          {
            toolCalls: [{ toolName: "bash", args: { command: "echo hi" }, result: "hi" }],
            text: "工具已执行并回答完毕。",
          },
        ],
      });
      const d1 = await createDaemon({
        home,
        engine: engine1,
        skipConfig: true,
        port: 0, // 随机端口：并行测试不撞 7333（T1.6 WS 装配后必传）
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
      });
      await d1.chat.sendMessage("跑个工具");
      const viewBefore = structuredClone(d1.session.getSnapshot());
      expect(viewBefore.session.entries.filter((e): e is (typeof viewBefore.session.entries)[number] & { role: "user" | "assistant" } => "role" in e).map((e) => e.role)).toEqual(["user", "assistant"]);
      expect(viewBefore.session.turns[0]!.status).toBe("completed");
      // D-1 修复（原固化缺口断言改写为固化正确行为）：含工具轮对话后
      // 快照视图携带工具调用记录（工具卡随快照恢复，契约 §6）
      expect(viewBefore.toolCalls).toHaveLength(1);
      expect(viewBefore.toolCalls[0]!.toolName).toBe("bash");
      expect(viewBefore.toolCalls[0]!.status).toBe("completed");
      expect(viewBefore.toolCalls[0]!.result).toBe("hi");
      expect(d1.system.getStatus().agentState).toBe("idle");

      await d1.shutdown(); // 优雅退出：drain 单写队列

      // 重启：RestoreService 读盘重建（同 --home）
      const engine2 = new FakeAgentEngine({ replies: [{ text: "重启后的新回复。" }] });
      const d2 = await createDaemon({
        home,
        engine: engine2,
        skipConfig: true,
        port: 0, // 随机端口：并行测试不撞 7333（T1.6 WS 装配后必传）
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
      });
      expect(d2.session.getSnapshot()).toEqual(viewBefore); // 快照（聚合+工具记录）与停前一致
      expect(d2.system.getStatus().sessionId).toBe(viewBefore.session.sessionId); // 同一会话延续

      // TP-CL8-7：恢复的是活会话——续发消息正常流式回复
      const outcome = await d2.chat.sendMessage("重启后继续问");
      expect(outcome.mode).toBe("turn");
      const snapAfter = d2.session.getSnapshot();
      expect(snapAfter.session.entries.length).toBe(viewBefore.session.entries.length + 2);
      expect(snapAfter.session.entries.filter((e) => "role" in e).at(-1)!.text).toBe("重启后的新回复。");
      expect(snapAfter.session.turns.every((t) => t.status === "completed")).toBe(true);
      expect(snapAfter.toolCalls).toHaveLength(1); // 工具记录随恢复延续
      await d2.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("TP-CL8-6 强杀变体：kill -9 → 恢复到最后一致里程碑", () => {
  test("流式中 SIGKILL → 重启 → 半截流式丢弃、open turn 收口、steer 保留、可继续", async () => {
    const home = tmpHome();
    try {
      await spawnHangDaemon(home);

      // 崩溃现场断言（重启前直接查 DB）：里程碑在、半截流式不在
      const { WriteQueue } = await import("../../src/adapters/driven/sqlite-session/WriteQueue");
      const { SqliteSessionRepository } = await import(
        "../../src/adapters/driven/sqlite-session/SqliteSessionRepository"
      );
      const readQueue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(readQueue);
      const crashed = await repo.restore((await repo.listSessionIds()).at(-1)!);
      expect(crashed).toBeDefined();
      // 最后一致里程碑：user entry + turn.started(generating) + steer entry 已落盘；
      // 半截 assistant 流式正文未落盘（delta 不进队列）
      expect(crashed!.session.entries.filter((e): e is NonNullable<typeof crashed>["session"]["entries"][number] & { role: "user" | "assistant"; text: string } => "role" in e).map((e) => [e.role, e.text])).toEqual([
        ["user", "会话开始的问题"],
        ["user", "流式中注入的一条消息"],
      ]);
      expect(crashed!.session.turns[0]!.status).toBe("generating"); // run 未收尾
      expect(crashed!.session.pendingSteer).toHaveLength(1); // 未消费 steer 已落盘
      expect(crashed!.session.pendingSteer[0]!.text).toBe("流式中注入的一条消息");
      // D-2 后 entry 序号含流式预分配（id 序列相关），断言形状不固化序号
      expect(crashed!.session.pendingSteer[0]!.entryId).toMatch(/^e\d+$/);
      expect(crashed!.agentState).toBe("steering"); // 生命周期最后状态
      await readQueue.close();

      // 重启：死锁接管（SIGKILL 遗留 daemon.lock，pid 已死）+ RestoreService 重建
      const engine = new FakeAgentEngine({ replies: [{ text: "强杀重启后的回复。" }] });
      const daemon = await createDaemon({
        home,
        engine,
        skipConfig: true,
        port: 0, // 随机端口：并行测试不撞 7333（T1.6 WS 装配后必传）
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
      });
      const snap = daemon.session.getSnapshot();
      // 恢复语义：已完成条目保留；未完成 turn 收口 interrupted（半截流式按语义丢弃）
      expect(snap.session.sessionId).toBe(crashed!.session.sessionId);
      expect(snap.session.entries.filter((e): e is (typeof snap.session.entries)[number] & { role: "user" | "assistant" } => "role" in e).map((e) => e.role)).toEqual(["user", "user"]); // 无半截 assistant
      expect(snap.session.turns[0]!.status).toBe("interrupted");
      expect(snap.session.pendingSteer).toEqual(crashed!.session.pendingSteer); // steer 队列随会话保留
      expect(daemon.system.getStatus().agentState).toBe("idle"); // 重启后无 run 在飞
      expect(snap.toolCalls).toEqual([]); // 本现场无工具轮：工具记录面为空

      // 活会话：收口后的会话可继续对话（open turn 已收口不阻塞新输入）
      const outcome = await daemon.chat.sendMessage("强杀重启后的新问题");
      expect(outcome.mode).toBe("turn");
      expect(daemon.session.getSnapshot().session.entries.filter((e) => "role" in e).at(-1)!.text).toBe("强杀重启后的回复。");
      await daemon.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 40000);
});
