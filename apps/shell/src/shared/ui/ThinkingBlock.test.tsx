// @vitest-environment jsdom
/**
 * thinking 块组件测试（F2.3/F2.4；test-design §2.2 F2.3 UI 行）。
 *
 * 三态渲染面：streaming（think-live muted 流式+光标+「思考中」标签）/
 * complete（💭 折叠条 Ns·N tokens+实例 chip，点击展开/收起 aria-expanded 同步）。
 * 三态互斥与 complete 不可逆的 reducer 面已由 session-reducer-v01.test.ts 守护；
 * MessageFlow 挂载分流断言在 widgets/chat-stream/ui/MessageFlow.test.tsx
 * （T4.3 组件上移 shared 后按 FSD 分层归位）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { ThinkingEntryDto } from "@helix/protocol";

import { ThinkingEntryView, ThinkingLiveView } from "./ThinkingBlock";

function ui(node: React.ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

function thinkEntry(over: Partial<ThinkingEntryDto> = {}): ThinkingEntryDto {
  return {
    kind: "thinking",
    id: "think-1",
    instanceId: "main",
    text: "盘点当前态：并发预算 3，前三个立即执行，依赖扫描进 FIFO 队列。",
    durationMs: 12_400,
    createdAt: "2026-08-16T14:02:00+08:00",
    ...over,
  };
}

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("ThinkingLiveView（streaming 态）", () => {
  it("muted 流式块：「思考中」标签 + accent 脉冲点 + 累积文本 + 光标", () => {
    ui(<ThinkingLiveView text="先拆任务" />);
    const live = document.querySelector(".think-live");
    expect(live).not.toBeNull();
    expect(live!.querySelector(".tl-label .hud-dot-pulse")).not.toBeNull();
    expect(screen.getByText("思考中")).toBeTruthy();
    expect(screen.getByText("先拆任务")).toBeTruthy();
    expect(live!.querySelector(".stream-cursor")).not.toBeNull();
  });
});

describe("ThinkingEntryView（complete 折叠条）", () => {
  it("「💭 已思考 12s」+ 实例 chip；duration 取整秒、不携带 token（CAND-35）", () => {
    ui(<ThinkingEntryView entry={thinkEntry()} />);
    expect(screen.getByText("已思考 12s")).toBeTruthy();
    expect(screen.getByText("main", { selector: ".who-chip" })).toBeTruthy();
  });

  it("点击展开全文回看再收起：aria-expanded 与 .open 同步（F2.4）", () => {
    ui(<ThinkingEntryView entry={thinkEntry()} />);
    const btn = screen.getByRole("button", { name: /已思考 12s/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const wrap = document.querySelector('.fb-wrap[data-kind="thinking"]');
    expect(wrap!.className).not.toContain("open");

    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(wrap!.className).toContain("open");
    expect(screen.getByText(/盘点当前态/)).toBeTruthy();

    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(wrap!.className).not.toContain("open");
  });
});
