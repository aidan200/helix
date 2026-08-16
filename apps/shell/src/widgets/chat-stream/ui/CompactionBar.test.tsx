// @vitest-environment jsdom
/**
 * compaction 里程碑条组件测试（F4.1/AD-9；test-design §2.4 F4.1 UI 行）。
 *
 * ⇄ 折叠条「上下文已压缩 {before}→{after}」+ meta（实例 chip · 时间 · usage
 * 入账值）+ 展开 summary 全文与保留尾部注；与 thinking 折叠条组件模式同构
 * （FlowBar 消费 + violet 变体）。mock 帧数据字段结构与 CompactionEntryDto
 * 契约一致（tokensBefore/tokensAfter/summary/usage/createdAt）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { CompactionEntryDto } from "@helix/protocol";
import CompactionBar from "./CompactionBar";

function compactionEntry(over: Partial<CompactionEntryDto> = {}): CompactionEntryDto {
  return {
    kind: "compaction",
    id: "compact-1",
    instanceId: "main",
    tokensBefore: 340_000,
    tokensAfter: 20_000,
    summary: "会话前段摘要：用户要求四任务并行；MainAgent 按预算拆分，spawn agent-1..4。",
    usage: { input: 30_000, output: 2_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 32_000, cost: 0.11 },
    // 本地时区构造（14:05）→ formatTs 与运行环境时区无关
    createdAt: new Date(2026, 7, 16, 14, 5).toISOString(),
    ...over,
  };
}

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("CompactionBar（F4.1 里程碑条）", () => {
  it("折叠条「⇄ 上下文已压缩 340k→20k」+ meta（实例 chip · 时间 · usage 入账值）", () => {
    render(
      <I18nProvider>
        <CompactionBar entry={compactionEntry()} />
      </I18nProvider>,
    );
    expect(screen.getByText("上下文已压缩 340k→20k")).toBeTruthy();
    expect(screen.getByText("main", { selector: ".who-chip" })).toBeTruthy();
    expect(screen.getByText("14:05")).toBeTruthy();
    expect(screen.getByText("32k tok · $0.11")).toBeTruthy();
  });

  it("violet 变体与 thinking 折叠条同构区分（fb-wrap.compact）", () => {
    render(
      <I18nProvider>
        <CompactionBar entry={compactionEntry()} />
      </I18nProvider>,
    );
    const wrap = document.querySelector('.fb-wrap[data-kind="compaction"]');
    expect(wrap).not.toBeNull();
    expect(wrap!.className).toContain("compact");
    expect(wrap!.getAttribute("data-entry-id")).toBe("compact-1");
  });

  it("点击展开 summary 全文 + 保留尾部注；再点收起（aria-expanded 同步）", () => {
    render(
      <I18nProvider>
        <CompactionBar entry={compactionEntry()} />
      </I18nProvider>,
    );
    const btn = screen.getByRole("button", { name: /上下文已压缩/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/会话前段摘要/)).toBeTruthy();
    expect(
      screen.getByText(/保留尾部消息与 SubAgent 卡片状态 · 摘要调用 usage 已入账/),
    ).toBeTruthy();

    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
});
