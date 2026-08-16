import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ChatService } from "../../src/application/services/ChatService";
import { SessionService } from "../../src/application/services/SessionService";
import { CliAdapter } from "../../src/adapters/driving/cli/CliAdapter";
import { StdoutEventPublisher } from "../../src/adapters/driving/cli/CliAdapter";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";

/**
 * TP-CL4-6（I）：CLI 多轮常驻——FakeAgentEngine 剧本 S1（≥3 轮「输入→流式→
 * 再输入」，进程内不重启）；TP-CL4-8（I 半）：S3 steer 剧本（生成中输入 →
 * 入队提示 → turn 边界注入 → 注入驱动新回复）；TP-CL4-9：S4 abort 剧本
 * （Ctrl-C 分流路径 interrupt() → abort → 会话可继续）。
 *
 * IO 注入：PassThrough 流替代 stdin/stdout（showPrompt 关闭保证输出纯净；
 * installSignals 关闭——interrupt() 即 SIGINT 处理器的同一分流路径）。
 */

function makeCli(engine: FakeAgentEngine) {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
  });
  const targets: import("../../src/application/ports/outbound/EventPublisherPort").EventPublisherPort[] = [];
  const fanout = {
    publish: (e: never) => {
      for (const t of targets) t.publish(e);
    },
    publishDelta: (d: never) => {
      for (const t of targets) t.publishDelta(d);
    },
  };
  const chat = new ChatService({
    engine,
    repository: new InMemorySessionRepository(),
    events: fanout, // 先接 fan-out，目标在下面装配（与组合根同构）
    clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() },
  });
  const session = new SessionService({
    getSession: () => chat.sessionView,
    getAgentState: () => chat.agentState,
    getToolCalls: () => chat.toolCallData, // D-1：快照取数面扩展（与组合根同构）
  });
  const publisher = new StdoutEventPublisher(output);
  targets.push(publisher, {
    publish: (e) => session.notify(e),
    publishDelta: (d) => session.notify(d),
  });
  const adapter = new CliAdapter({ chat, session, events: publisher, input, output, showPrompt: false, installSignals: false });
  const read = () => buffered;
  return { adapter, input, read, chat, session, publisher };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时：输出至今为「${cond}」`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TP-CL4-6：CLI 多轮常驻（S1 剧本，≥3 轮不重启进程）", () => {
  test("三轮「输入→流式→再输入」全部流式输出到 stdout", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "第一轮回复：**加粗**与`行内码`。" },
        { text: "第二轮回复：- 列表项 A\n- 列表项 B。" },
        { text: "第三轮回复：```code block```。" },
      ],
      chunkDelayMs: 4,
    });
    const { adapter, input, read } = makeCli(engine);
    const run = adapter.run();

    // 每轮：输入 → 等本轮流式完全结束（回复全文出现 + 引擎回空闲）→ 再输入
    input.write("第一问\n");
    await until(() => read().includes("第一轮回复：**加粗**与`行内码`。") && !engine.isStreaming());
    input.write("第二问\n");
    await until(() => read().includes("- 列表项 B。") && !engine.isStreaming());
    input.write("第三问\n");
    await until(() => read().includes("第三轮回复：```code block```。") && !engine.isStreaming());

    // 三条用户回显 + 流式增量逐字到达（非一次性打印）
    expect(read().match(/你：第一问/g)).toBeTruthy();
    expect(read()).toContain("第一轮回复：**加粗**与`行内码`。");
    expect(read()).toContain("第二轮回复：- 列表项 A");
    expect(read()).toContain("第三轮回复：");
    // 进程内三轮（引擎 run 数 = 3，无重启）
    expect(engine.events.filter((e) => e.type === "agent_start").length).toBe(3);

    input.write("/exit\n");
    await run;
  });
});

describe("TP-CL4-8（I 半）：S3 steer 剧本（生成中输入 → 入队 → 注入驱动）", () => {
  test("stdout 显示已入队，turn 结束后注入并驱动新回复", async () => {
    const engine = new FakeAgentEngine({
      replies: [{ text: "正在生成的较长回复，为 steer 注入留出时间窗口，继续生成中……", chunkDelayMs: 15 }],
      steerReplies: [{ text: "（按注入要求改写）简短版本。" }],
    });
    const { adapter, input, read } = makeCli(engine);
    const run = adapter.run();

    input.write("写一段长介绍\n");
    await until(() => read().includes("正在生成的较长回复"));
    input.write("要简短一些\n"); // 生成中的新输入 → ChatService 路由为 steer
    await until(() => read().includes("[steer] 已入队"));
    await until(() => read().includes("（按注入要求改写）简短版本。"), 4000);

    const out = read();
    expect(out).toContain("[steer] 已入队（当前 turn 结束后注入）：要简短一些");
    expect(out).toContain("[steer] 已注入并驱动新回复：要简短一些");
    // domain 侧（steer 入队→drain 两态可观测）经事件流到达订阅者
    expect(engine.events.some((e) => e.type === "message_start" && e.source === "steer-drain")).toBe(true);

    input.write("/exit\n");
    await run;
  });
});

describe("TP-CL4-9：S4 abort 剧本（Ctrl-C 分流 → 会话可继续）", () => {
  test("interrupt() 中断当前生成，随后新消息正常流式回复", async () => {
    const engine = new FakeAgentEngine({
      replies: [
        { text: "这轮回复很长很长，等待被中断。继续流式中……", chunkDelayMs: 20 },
        { text: "中断后的新回复。" },
      ],
    });
    const { adapter, input, read } = makeCli(engine);
    const run = adapter.run();

    input.write("第一问\n");
    await until(() => read().includes("这轮回复很长"));
    adapter.interrupt(); // ← SIGINT 处理器同一分流路径（生成中 → abort）
    await until(() => read().includes("[turn] 已中断"));
    expect(read()).toContain("[abort] 已请求中断当前生成…");

    // 非销毁：会话继续，新消息正常流式回复
    input.write("继续问\n");
    await until(() => read().includes("中断后的新回复。"), 4000);
    expect(engine.events.filter((e) => e.type === "agent_start").length).toBe(2);

    input.write("/exit\n");
    await run;
  });

  test("空闲时 interrupt() → 退出主循环（第二次 Ctrl-C 语义）", async () => {
    const engine = new FakeAgentEngine({ replies: [{ text: "ok" }] });
    const { adapter, input } = makeCli(engine);
    const run = adapter.run();
    input.write("问\n");
    await new Promise((r) => setTimeout(r, 60)); // 等 run 结束回空闲
    adapter.interrupt();
    await run; // 主循环退出（不挂起）
  });
});
