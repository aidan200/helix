// @vitest-environment jsdom
/**
 * MessageBubble steer 徽标测试。
 *
 * 时间轴语义分层后（系统注入细条化）：source=closure/progress 条目不再进入
 * 气泡渲染面（MessageFlow EntryView 分发为 SystemInjectBar 细条），气泡徽标
 * 只剩用户 steer 两态（queued/drained）。本文件钉用户 steer 回归与
 * 「无 steerState 无徽标」边界。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { MessageEntryDto } from "@helix/protocol";
import MessageBubble from "./MessageBubble";

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言）
localStorage.setItem("helix-lang", "zh-CN");

function entry(over: Partial<MessageEntryDto> = {}): MessageEntryDto {
  return {
    kind: "message",
    id: "m1",
    role: "user",
    content: "注入内容",
    ts: 1_700_000_000_000,
    ...over,
  };
}

function ui(node: React.ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

describe("MessageBubble 用户 steer 徽标（两态）", () => {
  it("回归钉：source=user + steerState=queued → STEER 徽标（无 CLOSURE/PROGRESS）", () => {
    const { container } = ui(
      <MessageBubble entry={entry({ source: "user", steerState: "queued" })} />,
    );
    const badge = container.querySelector(".steer-badge");
    expect(badge).not.toBeNull();
    expect(badge!.className).not.toContain("closure");
    expect(badge!.className).not.toContain("progress");
    expect(badge!.textContent).toContain("STEER");
    expect(badge!.textContent).toContain("已入队");
  });

  it("回归钉：缺省 source（老数据）+ steerState=queued/drained → 与现状一致", () => {
    const { container } = ui(<MessageBubble entry={entry({ steerState: "queued" })} />);
    const badge = container.querySelector(".steer-badge");
    expect(badge!.textContent).toContain("STEER");
    expect(badge!.textContent).not.toContain("CLOSURE");
    cleanup();
    const drained = ui(<MessageBubble entry={entry({ steerState: "drained" })} />);
    const dbadge = drained.container.querySelector(".steer-badge");
    expect(dbadge!.textContent).toContain("已注入");
    expect(dbadge!.textContent).not.toContain("CLOSURE");
  });

  it("普通用户消息（无 source 无 steerState）→ 无徽标（现状不变）", () => {
    const { container } = ui(<MessageBubble entry={entry()} />);
    expect(container.querySelector(".steer-badge")).toBeNull();
  });
});
