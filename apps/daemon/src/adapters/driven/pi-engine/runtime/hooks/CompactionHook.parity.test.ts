import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Agent, AgentMessage, PrepareRequestContext } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { CompactionHook } from "./CompactionHook";
import type { CompactionSettings } from "../AgentProfile";

/**
 * F2（评审中危 #2/#3）：双档观测行为对齐——request 档 prepareCompaction
 * 失败（prep.ok=false）不得与「无可压缩内容」合并静默（失败上抛 onFailed
 * 契约，turn 档先例）；双档共享压缩执行体后失败文案/顺序同源。
 * 结构面断言 = 合并分支 idiom 零残留（prep.ok=false 现为 vendored
 * prepareCompaction 永不触发的防御路径，行为注入不可达——机械断言唯一面，
 * error-code-judgement TP-1.5c 结构断言先例）；行为面 = 双档异常路径
 * 文案同源（getApiKey fail-fast 注入）。
 */

/** 超阈值对话（同 request.test.ts 口径：8 对长文本 user/assistant）。 */
function overThresholdMessages(): AgentMessage[] {
  const long = "x".repeat(600);
  const messages: AgentMessage[] = [{ role: "system", content: "SYS_PROMPT", timestamp: 1 } as never];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `${long}#${i}` }], timestamp: i + 2 } as never);
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `${long}@${i}` }],
      stopReason: "stop",
      timestamp: i + 3,
    } as never);
  }
  return messages;
}

const settings: CompactionSettings = { enabled: true, reserveTokens: 500, keepRecentTokens: 20 };

const fakeModel = {
  provider: "stub",
  id: "stub-model",
  name: "Stub",
  api: "pi-messages",
  contextWindow: 1_000,
  maxTokens: 4_096,
} as never as Model<any>;

function fakeAgent(messages: AgentMessage[]): Agent {
  return { state: { model: fakeModel, messages, tools: [] } } as never as Agent;
}

function fakeRequest(messages: AgentMessage[]): PrepareRequestContext {
  return { context: { messages, tools: [] }, model: fakeModel, thinkingLevel: "off" } as never as PrepareRequestContext;
}

describe("F2 #2/#3：CompactionHook 双档失败观测对齐", () => {
  test("结构断言：prep.ok=false 与「无可压缩内容」合并且静默的 idiom 零残留", () => {
    const source = readFileSync(path.join(import.meta.dir, "CompactionHook.ts"), "utf8");
    expect(
      source.includes("!prep.ok || !prep.value"),
      "request 档合并分支残留：prep.ok=false（准备失败）应上抛 onFailed 后返回，不得与无可压缩内容（prep.value 空态）合并静默",
    ).toBe(false);
    // 分离后的失败分支必须存在（防误删整段判别）
    expect(source.includes("准备失败")).toBe(true);
  });

  test("行为对齐：request 档意外异常文案与 turn 档同源（compaction 执行异常）", async () => {
    const failures: string[] = [];
    const hook = new CompactionHook({
      settings,
      models: {} as Models,
      model: fakeModel,
      trigger: "request",
      // fail-fast 注入（compaction-apikey ③ 同型）：解析期抛错 → 异常路径
      getApiKey: () => {
        throw new Error("auth.json 缺 key");
      },
      onFailed: (m) => failures.push(m),
    });
    const messages = overThresholdMessages();
    hook.bind(fakeAgent(messages));
    const update = await hook.prepareRequest(fakeRequest(messages));
    expect(update).toBeUndefined();
    expect(failures).toHaveLength(1);
    // F2 归位后双档统一「compaction 执行异常」（原 request 档「摘要异常」漂移）
    expect(failures[0]).toContain("compaction 执行异常");
    expect(failures[0]).toContain("auth.json 缺 key");
  });
});
