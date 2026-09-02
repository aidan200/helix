// @vitest-environment jsdom
/**
 * SystemInjectBar 系统注入细条测试（时间轴语义分层：气泡=人说的话，
 * 细条=系统的注入）。
 *
 * 钉三态：
 * - source=closure → CLOSURE chip + 正文（amber 族，data-source 锚点）；
 * - source=progress → PROGRESS chip（cyan 族）；
 * - steerState 两态小字（queued=已入队 / drained=已注入；缺省=无状态文）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import SystemInjectBar from "./SystemInjectBar";

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言）
localStorage.setItem("helix-lang", "zh-CN");

function ui(node: React.ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

describe("SystemInjectBar 系统注入细条", () => {
  it("source=closure → data-kind/data-source 锚点 + CLOSURE chip + 正文", () => {
    const { container } = ui(<SystemInjectBar source="closure" text="agent-3 closure: 收口摘要" />);
    const bar = container.querySelector('[data-kind="system-inject"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("data-source")).toBe("closure");
    expect(bar!.className).toContain("closure");
    expect(bar!.textContent).toContain("CLOSURE");
    expect(bar!.textContent).toContain("agent-3 closure: 收口摘要");
  });

  it("source=progress → PROGRESS chip", () => {
    const { container } = ui(<SystemInjectBar source="progress" text="进展报告中" />);
    const bar = container.querySelector('[data-kind="system-inject"]');
    expect(bar!.getAttribute("data-source")).toBe("progress");
    expect(bar!.className).toContain("progress");
    expect(bar!.textContent).toContain("PROGRESS");
    expect(bar!.textContent).toContain("进展报告中");
  });

  it("steerState=queued → 已入队；drained → 已注入；缺省 → 无状态文", () => {
    const { container, unmount } = ui(
      <SystemInjectBar source="closure" text="x" steerState="queued" />,
    );
    expect(container.querySelector(".si-state")!.textContent).toContain("已入队");
    unmount();
    const d = ui(<SystemInjectBar source="closure" text="x" steerState="drained" />);
    expect(d.container.querySelector(".si-state")!.textContent).toContain("已注入");
    d.unmount();
    const none = ui(<SystemInjectBar source="closure" text="x" />);
    expect(none.container.querySelector(".si-state")).toBeNull();
  });
});
