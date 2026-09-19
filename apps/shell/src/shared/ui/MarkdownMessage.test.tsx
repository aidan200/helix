// @vitest-environment jsdom
/**
 * MarkdownMessage 换行渲染契约（多行输入回车可见 bug）：
 * CommonMark 语义下段内单换行（soft break）合并为空格——聊天场景
 * user/assistant 气泡的单换行必须可见（remark-breaks：soft break → <br>）。
 * 段落分隔（双换行）仍是分段语义不受影响；fenced 代码块换行原样保留。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import MarkdownMessage from "./MarkdownMessage";

afterEach(cleanup);

describe("MarkdownMessage 换行渲染", () => {
  it("段内单换行渲染为 <br>（多行输入回车可见；remark-breaks）", () => {
    const { container } = render(<MarkdownMessage text={"第一行\n第二行"} />);
    const brs = container.querySelectorAll(".md-body p br");
    expect(brs.length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("第一行");
    expect(container.textContent).toContain("第二行");
  });

  it("三行两换行 → 两个 <br>（每处单换行都可见）", () => {
    const { container } = render(<MarkdownMessage text={"a\nb\nc"} />);
    expect(container.querySelectorAll(".md-body p br").length).toBe(2);
  });

  it("段落分隔（双换行）仍是分段，不落 <br>", () => {
    const { container } = render(<MarkdownMessage text={"段落一\n\n段落二"} />);
    expect(container.querySelectorAll(".md-body p").length).toBe(2);
    expect(container.querySelectorAll(".md-body br").length).toBe(0);
  });

  it("回归钉：行内 code chip 与 fenced 代码块（含块内换行）渲染不变", () => {
    const { container } = render(<MarkdownMessage text={"a `x` b\n\n```ts\ncode\nline2\n```"} />);
    expect(container.querySelector("code.inline")).not.toBeNull();
    const pre = container.querySelector(".md-code pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("code\nline2");
  });
});
