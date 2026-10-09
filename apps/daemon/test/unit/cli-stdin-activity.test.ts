/**
 * CLI 两小接线（M3-d1 感知兑现批）——stdin 输入 → 用户在场信号。
 *
 * 链路：CliAdapter.handleLine（非空非 /exit 行）→ deps.onUserInput 回调 →
 * 组合根旁挂 StewardPerceptionService.noteUserActivity() + 活动账
 * noteCliSession(currentSessionId)（cli: 域标签的会话来源登记）。
 *
 * 此前用户在场信号仅认 GUI ask（StewardService.onUserActivity）——CLI
 * 终端会话全程不点亮激活窗；本批补齐（E-20 CliAdapter 侧识别会话来源）。
 */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CliAdapter } from "../../src/adapters/driving/cli/CliAdapter";
import type { SessionChatPort, SendOutcome } from "../../src/application/ports/inbound/ChatPort";
import type { SessionPort } from "../../src/application/ports/inbound/SessionPort";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";

function fakePorts() {
  const chat: SessionChatPort = {
    sendMessage: async (): Promise<SendOutcome> => ({ mode: "turn", turnId: "t1", entryId: "e1" }),
    steer: async () => ({ entryId: "e1" }),
    abort: () => undefined,
  };
  const session: SessionPort = {
    subscribe: () => () => undefined,
  } as unknown as SessionPort;
  const events: EventPublisherPort = { publish: () => undefined, publishDelta: () => undefined };
  return { chat, session, events };
}

async function runCli(lines: readonly string[], onUserInput?: () => void): Promise<void> {
  const input = new PassThrough();
  const output = new PassThrough();
  const { chat, session, events } = fakePorts();
  const adapter = new CliAdapter({
    chat,
    session,
    events,
    input,
    output,
    showPrompt: false,
    installSignals: false,
    ...(onUserInput !== undefined ? { onUserInput } : {}),
  });
  const done = adapter.run();
  for (const line of lines) input.write(`${line}\n`);
  input.write("/exit\n");
  await done;
}

describe("CLI stdin → 用户在场信号（M3-d1）", () => {
  test("非空对话行 → onUserInput 逐行触发（用户在场信号 + cli 会话登记旁挂点）", async () => {
    const calls: number[] = [];
    await runCli(["帮我看看任务", "继续"], () => calls.push(calls.length));
    expect(calls).toHaveLength(2);
  });

  test("空行 / /exit / /quit 不触发（非对话动作零信号）", async () => {
    const calls: number[] = [];
    await runCli(["   ", "/exit"], () => calls.push(calls.length));
    expect(calls).toHaveLength(0);
  });

  test("回调缺席 = 零信号零异常（回归兼容形态）", async () => {
    await expect(runCli(["你好"])).resolves.toBeUndefined();
  });

  test("回调抛错不炸 CLI 主循环（隔离面——感知旁挂不阻断对话）", async () => {
    await expect(
      runCli(["你好"], () => {
        throw new Error("perception boom");
      }),
    ).resolves.toBeUndefined();
  });
});
