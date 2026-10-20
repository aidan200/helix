/**
 * SubAgentCard 流式摘要固定槽 CSS/组件契约（TR-194 + TR-285 口径守卫）。
 *
 * 钉纪律：running 态摘要槽 .sa-stream-text 的「高度恒定」由纯盒模型实现——
 * height（2 × line-height 1.6 = 3.2em）+ overflow:hidden；**禁止**改用
 * line-clamp 钳行数（新版 Chrome 已降级 -webkit-box，clamp 容器失效钳不住，
 * TR-194 实测 325 字符爆到 6156px）。本测试同时钉组件注释口径在场（不得
 * 回潮到「line-clamp:2 + min-height 锁 2 行」的失实描述）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/app.css", import.meta.url)),
  "utf8",
);
const card = readFileSync(fileURLToPath(new URL("./SubAgentCard.tsx", import.meta.url)), "utf8");

describe("SubAgentCard 流式摘要固定槽（纯盒模型 · 非 line-clamp）", () => {
  it("槽层纯盒模型：height（em 定值）+ overflow: hidden", () => {
    expect(css).toMatch(/\.sa-stream-text\s*\{[^}]*height:\s*[\d.]+em/);
    expect(css).toMatch(/\.sa-stream-text\s*\{[^}]*overflow:\s*hidden/);
  });

  it("禁用 line-clamp 钳行数（.sa-stream-text 规则块内零 clamp 声明）", () => {
    expect(css).not.toMatch(/\.sa-stream-text\s*\{[^}]*line-clamp/);
  });

  it("组件注释口径在场：height 3.2em + overflow 锁槽（TR-285 新口径断言）", () => {
    expect(card).toContain("height 3.2em");
    expect(card).toContain("overflow:hidden");
  });

  it("旧失实口径禁回潮：注释不得再称「line-clamp:2 + min-height」（分片拼接防恒真）", () => {
    const banned = ["line" + "-clamp:2", "min" + "-height\n          锁 2 行"];
    for (const b of banned) expect(card).not.toContain(b);
  });
});
