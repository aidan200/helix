// @vitest-environment jsdom
/**
 * MessageBubble steer/closure 徽标变体测试（T11b：closure/steer source 显示区分⑤）。
 *
 * 钉四态：
 * - source="closure" → CLOSURE 徽标（amber 新族，与用户 steer violet 脉冲视觉分离）；
 *   idle 注入（无 steerState）也带 CLOSURE 标记（实时帧 MessageCompletedPayload.source
 *   透传后即时可见）。
 * - source="progress" → PROGRESS 徽标。
 * - source="user" / 缺省（老数据）→ 既有 STEER 徽标两态不变（回归钉）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

describe("MessageBubble 徽标 source 变体（T11b）", () => {
  it("source=closure 且 idle 注入（无 steerState）→ CLOSURE 徽标（无 STEER 字样）", () => {
    const { container } = ui(<MessageBubble entry={entry({ source: "closure" })} />);
    const badge = container.querySelector(".steer-badge");
    expect(badge).not.toBeNull();
    expect(badge!.className).toContain("closure");
    expect(badge!.textContent).toContain("CLOSURE");
    expect(badge!.textContent).not.toContain("STEER");
  });

  it("source=closure + steerState=queued（running 注入）→ CLOSURE 徽标 + 已入队", () => {
    const { container } = ui(
      <MessageBubble entry={entry({ source: "closure", steerState: "queued" })} />,
    );
    const badge = container.querySelector(".steer-badge");
    expect(badge!.className).toContain("closure");
    expect(badge!.textContent).toContain("CLOSURE");
    expect(badge!.textContent).toContain("已入队");
  });

  it("source=closure + steerState=drained → CLOSURE 徽标 + 已注入", () => {
    const { container } = ui(
      <MessageBubble entry={entry({ source: "closure", steerState: "drained" })} />,
    );
    const badge = container.querySelector(".steer-badge");
    expect(badge!.className).toContain("closure");
    expect(badge!.className).toContain("drained");
    expect(badge!.textContent).toContain("CLOSURE");
    expect(badge!.textContent).toContain("已注入");
  });

  it("source=progress + steerState=queued → PROGRESS 徽标", () => {
    const { container } = ui(
      <MessageBubble entry={entry({ source: "progress", steerState: "queued" })} />,
    );
    const badge = container.querySelector(".steer-badge");
    expect(badge!.className).toContain("progress");
    expect(badge!.textContent).toContain("PROGRESS");
    expect(badge!.textContent).toContain("已入队");
  });

  it("回归钉：source=user + steerState=queued → 既有 STEER 徽标不变（无 CLOSURE/PROGRESS）", () => {
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
