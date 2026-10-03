import { describe, expect, test } from "bun:test";
// pi-ai 真实估算面：estimateContextTokens 会在请求构造期（simple-options
// maxTokens 钳制）被走到——pi-ai 1.0.0 的 getLastAssistantUsageInfo 对
// assistant.usage 无判空（calculateContextTokens(assistant.usage) 直读
// usage.totalTokens），回填消息缺 usage 即抛 TypeError（2026-10-03 管家
// 全量「模型调用失败」事故根因）。本套 = 回填形状的防回归锚。
// 注：pi-ai exports 不开放 utils 子路径，经 import.meta.resolve 定位包根后
// 按文件路径动态引入（锚真实安装版而非 vendored 副本）。
const resolved = import.meta.resolve("@earendil-works/pi-ai").replace(/\/dist(?:\/index\.js)?\/?$/, "");
const { estimateContextTokens } = (await import(`${resolved}/dist/utils/estimate.js`)) as {
  estimateContextTokens: (messages: readonly unknown[]) => { tokens: number; usageTokens: number; trailingTokens: number };
};
import { stewardMessagesToPi } from "../../src/adapters/driven/steward/StewardLlmMessages";
import type { StewardLlmMessage } from "../../src/application/ports/outbound/StewardLlmPort";

const dialog: readonly StewardLlmMessage[] = [
  { role: "user", text: "我最近在改的这个 loop，你知道是什么吗？" },
  {
    role: "assistant",
    content: [
      { type: "thinking", text: "应该查一下近期工作记录", signature: "reasoning_content" },
      { type: "toolCall", id: "call_x", name: "query_recent_work", args: { time_range: "this_week" } },
    ],
  },
  { role: "toolResult", toolCallId: "call_x", name: "query_recent_work", text: "（结果）" },
  { role: "assistant", content: [{ type: "text", text: "查到了两个相关会话。" }] },
  { role: "user", text: "展开讲讲" },
];

describe("stewardMessagesToPi 回填 assistant 消息形状（pi-ai estimate 防回归）", () => {
  test("回填 assistant 必须携带 usage 字段（零值亦可）——缺字段即触发 pi-ai 裸读崩溃", () => {
    const pi = stewardMessagesToPi(dialog);
    const assistants = pi.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);
    for (const m of assistants) {
      const usage = (m as { usage?: unknown }).usage;
      expect(usage).toBeDefined();
      expect(typeof (usage as { totalTokens?: number }).totalTokens).toBe("number");
    }
  });

  test("回填产物过 pi-ai estimateContextTokens 不抛（maxTokens 钳制路径等价形态）", () => {
    const pi = stewardMessagesToPi(dialog);
    expect(() => estimateContextTokens(pi as never)).not.toThrow();
  });

  test("零值 usage 不改变估算语义：估算走字符启发而非零 usage 锚", () => {
    const pi = stewardMessagesToPi(dialog);
    const est = estimateContextTokens(pi as never);
    expect(est.usageTokens).toBe(0); // 零值 usage 不被采信为 usage 锚
    expect(est.tokens).toBeGreaterThan(0);
  });
});
