import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { textOfContent } from "../../src/adapters/driven/pi-engine/mappers/SessionMapper";

/**
 * TP-CL4-1（恢复回填批）：恢复后 mainAgent 引擎 transcript 含历史。
 *
 * 三层模型（架构 TR-AD-16）：实例窗口 = LLM 上下文、销毁重建。空闲卸载/
 * 重启 = 同一实例复活——应从 Entry 树按 mainInstanceId 过滤回填该实例自己的
 * user/assistant 历史（工具/thinking/compaction/SubAgent 不回填）。
 *
 * 用 production 引擎形态 + mainSessionLlmOverride（fake 剧本 streamFn）——
 * 捕获每次 LLM 请求的 context.messages，证明：
 * ① 新建会话首轮上下文无历史（基线）；
 * ② 重启恢复后首轮上下文含停前历史 + 新 prompt（回填生效）。
 */
function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-restore-transcript-"));
}

const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as const,
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 捕获型 fake LLM：记录每次请求的 context.messages（role + text）。 */
function makeCapturingLLM(seen: Array<Array<{ role: string; text: string }>>): StreamFn {
  return (model, context) => {
    const ctx = context as unknown as { messages?: Array<{ role: string; content: unknown }> };
    seen.push((ctx.messages ?? []).map((m) => ({ role: m.role, text: textOfContent(m.content) })));
    const stream = createAssistantMessageEventStream();
    const final = assistantMessage(`回复@${model.id}`);
    void (async () => {
      stream.push({ type: "start", partial: final });
      stream.push({ type: "text_end", contentIndex: 0, content: "回复", partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
}

function makeLlmOverride(seen: Array<Array<{ role: string; text: string }>>) {
  return {
    model: () => fakeModel,
    streamFn: makeCapturingLLM(seen),
    apiKeys: () => ({ anthropic: "sk-test" }),
  };
}

describe("TP-CL4-1：恢复后 mainAgent 引擎 transcript 回填", () => {
  test("新建会话首轮无历史（基线）→ 重启恢复后首轮含停前历史 + 新 prompt", async () => {
    const home = tmpHome();
    try {
      // ① 首启：发一条消息产生历史（user + assistant 各一条）
      const seen1: Array<Array<{ role: string; text: string }>> = [];
      const d1 = await createTestDaemon({
        home,
        skipConfig: true,
        port: 0,
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
        mainSessionLlmOverride: makeLlmOverride(seen1),
      });
      await d1.chat.sendMessage("第一个问题");
      expect(seen1).toHaveLength(1);
      // 基线：新建会话首轮 LLM 上下文只有新 prompt，无历史
      expect(seen1[0]!.map((m) => m.role)).toEqual(["user"]);
      expect(seen1[0]![0]!.text).toBe("第一个问题");
      await d1.shutdown();

      // ② 重启恢复：同 --home，发第二条消息
      const seen2: Array<Array<{ role: string; text: string }>> = [];
      const d2 = await createTestDaemon({
        home,
        skipConfig: true,
        port: 0,
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
        mainSessionLlmOverride: makeLlmOverride(seen2),
      });
      await d2.chat.sendMessage("第二个问题");
      expect(seen2).toHaveLength(1);
      // 回填生效：恢复后首轮上下文 = 历史（user + assistant）+ 新 prompt（user）
      expect(seen2[0]!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(seen2[0]![0]!.text).toBe("第一个问题"); // 历史 user
      expect(seen2[0]![1]!.text).toBe("回复@fake-model"); // 历史 assistant 回复
      expect(seen2[0]![2]!.text).toBe("第二个问题"); // 新 prompt
      await d2.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
