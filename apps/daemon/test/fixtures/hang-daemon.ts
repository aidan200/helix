import { writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * kill -9 强杀测试夹具（TP-CL8-6 强杀变体）：真实进程跑 createDaemon
 * （Fake 引擎、--home 隔离），发起一次带工具的对话；流式中段注入一条
 * steer 后写标记文件 `hang.marker`——测试进程轮询到标记即 SIGKILL。
 *
 * argv: [bun, 本文件, "--home", <dir>]
 * 不 runCli（stdin 置 PassThrough 常开）、不 shutdown——进程保持「流式进行中」
 * 的崩溃现场，直到被强杀。
 */

function parseHomeArg(argv: readonly string[]): string {
  const i = argv.indexOf("--home");
  if (i === -1 || i + 1 >= argv.length) {
    throw new Error("用法：bun hang-daemon.ts --home <dir>");
  }
  return argv[i + 1]!;
}

const home = parseHomeArg(process.argv);

const engine = new FakeAgentEngine({
  // 长回复 × 慢分片：流式窗口远大于测试轮询+kill 的时延
  replies: [{ text: "强".repeat(2400), chunkDelayMs: 25 }],
  steerReplies: [{ text: "（重启后才会发出的注入回复）" }],
});

const daemon = await createDaemon({
  home,
  engine,
  skipConfig: true,
  cliInput: new PassThrough(),
  cliOutput: new PassThrough(),
});

let deltas = 0;
daemon.session.subscribe((e) => {
  if (!("delta" in e)) return;
  deltas++;
  // 第 2 片 delta 时注入 steer（steer.queued 里程碑 + pendingSteer 落盘）
  if (deltas === 2) {
    void daemon.chat.sendMessage("流式中注入的一条消息").catch(() => process.exit(1));
  }
  // 第 5 片时写标记：此刻 user entry/turn.started/running/steer.queued 均已落盘，
  // 半截流式正文只存在于 delta（不落盘）
  if (deltas === 5) {
    writeFileSync(path.join(home, "hang.marker"), "streaming", "utf8");
  }
});

void daemon.chat.sendMessage("会话开始的问题").catch(() => process.exit(1));
setInterval(() => {}, 60_000); // 保活：等待被 SIGKILL
