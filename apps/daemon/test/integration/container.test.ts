import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import type { SessionStreamEvent } from "../../src/application/ports/inbound/SessionPort";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * 组合根集成（TP-CL4-6 旁证 + 接线正确性）：createDaemon 以 FakeAgentEngine
 * 注入装配全链（锁/config 模板/引擎/服务/CLI/fan-out/锁释放），
 * home 指向 tmp（不碰真实 ~/.helix，AG-07 纪律的测试面）。
 */
function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-daemon-it-"));
}

describe("createDaemon 组合根装配", () => {
  test("sendMessage 全链贯通 + 订阅者经 fan-out 收到事件 + 快照可取", async () => {
    const home = tmpHome();
    try {
      const engine = new FakeAgentEngine({ replies: [{ text: "组合根装配下的回复。" }] });
      const daemon = await createDaemon({
        home,
        engine,
        skipConfig: true,
        port: 0, // 随机端口：并行测试不撞 7333（T1.6 WS 装配后必传）
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
      });

      const received: SessionStreamEvent[] = [];
      daemon.session.subscribe((e) => received.push(e));

      const outcome = await daemon.chat.sendMessage("你好");
      expect(outcome.mode).toBe("turn");

      // 订阅流：领域事件 + 流式 delta 都经 fan-out 到达
      expect(received.some((e) => "type" in e && e.type === "message.completed")).toBe(true);
      expect(received.some((e) => "delta" in e)).toBe(true);

      // 快照面（SessionPort；D-1：会话聚合 + 工具记录双面）
      const snap = daemon.session.getSnapshot();
      expect(snap.session.entries.map((e) => e.role)).toEqual(["user", "assistant"]);
      expect(snap.toolCalls).toEqual([]); // 无工具轮：工具记录面为空

      // 状态面（SystemPort）
      const status = daemon.system.getStatus();
      expect(status.running).toBe(true);
      expect(status.locked).toBe(true);
      expect(status.home).toBe(home);
      expect(status.agentState).toBe("idle");

      // home 内产物：锁文件 + config 模板（0600）+ 日志 + SQLite 库（T1.8 write-through）
      const names = readdirSync(home);
      expect(names).toContain("daemon.lock");
      expect(names).toContain("config.json");
      expect(names).toContain("logs");
      expect(names).toContain("helix.db");

      await daemon.shutdown();
      expect(readdirSync(home)).not.toContain("daemon.lock"); // 锁已释放
      expect(daemon.system.getStatus().running).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
