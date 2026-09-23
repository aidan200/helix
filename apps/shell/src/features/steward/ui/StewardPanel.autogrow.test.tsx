// @vitest-environment jsdom
/**
 * StewardPanel 输入框自动长高测试（UI 显示优化批：底部一行显示不全修复）。
 *
 * 根因：textarea rows=2 钉死高度，输入超 2 行后最下面的行被裁进滚动区
 * （浏览器实测 clientHeight 48 / scrollHeight 84 / clipped）——用户体感
 * 「最下面的一行显示不全」。修复 = 主聊天 Composer 自动长高先例同构移植
 * （height:auto → min(scrollHeight, 上限)，超限内滚）。
 *
 * jsdom 无布局：textarea scrollHeight 以 own property 注入（StewardPanel.anchor
 * .test / MessageFlow.test 同法）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
const sendStewardHistory = vi.fn(() => true);
const stewardListeners = new Set<(e: EventEnvelope) => void>();
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  stewardListeners.add(cb);
  return () => {
    stewardListeners.delete(cb);
  };
});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    sendStewardHistory,
    subscribeStewardFrames,
  }),
}));

import StewardPanel from "../ui/StewardPanel";

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

function emitSteward(e: EventEnvelope): void {
  for (const l of stewardListeners) l(e);
}

const inputEl = () => document.querySelector<HTMLTextAreaElement>('[data-testid="steward-input"]')!;
const msgsEl = () => document.querySelector<HTMLElement>('[data-testid="steward-msgs"]')!;
/** textarea scrollHeight own-property 注入（configurable 可重注）。 */
const setTaScrollHeight = (h: number) =>
  Object.defineProperty(inputEl(), "scrollHeight", { value: h, configurable: true });

async function openPanel() {
  render(
    <I18nProvider>
      <StewardPanel onClose={() => undefined} active={true} />
    </I18nProvider>,
  );
  act(() => {
    emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
  });
  await vi.waitFor(() => expect(inputEl()).toBeTruthy());
}

describe("StewardPanel 输入框自动长高（Composer 先例同构）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stewardListeners.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it("多行输入随内容长高：height 落 min(scrollHeight)（不再钉 rows=2 裁行）", async () => {
    await openPanel();
    setTaScrollHeight(120); // 4 行内容的需求高度
    act(() => {
      fireEvent.change(inputEl(), { target: { value: "一\n二\n三\n四" } });
    });
    expect(inputEl().style.height).toBe("120px"); // 长到内容高度，末行完整可见
  });

  it("超上限内滚：scrollHeight 300 → height 封顶 160px（与主聊天 Composer 同上限）", async () => {
    await openPanel();
    setTaScrollHeight(300);
    act(() => {
      fireEvent.change(inputEl(), { target: { value: "x".repeat(50) } });
    });
    expect(inputEl().style.height).toBe("160px");
  });

  it("jsdom 无布局防御：scrollHeight=0 → 不落内联高度（交还 CSS rows 基线）", async () => {
    await openPanel();
    setTaScrollHeight(0);
    act(() => {
      fireEvent.change(inputEl(), { target: { value: "abc" } });
    });
    expect(inputEl().style.height).toBe("");
  });

  it("清空回基线：输入后清空 → 内联高度清除（高度回落 rows 基线）", async () => {
    await openPanel();
    setTaScrollHeight(120);
    act(() => {
      fireEvent.change(inputEl(), { target: { value: "一\n二\n三\n四" } });
    });
    expect(inputEl().style.height).toBe("120px");
    setTaScrollHeight(0); // 清空后 jsdom 无布局 → 防御分支
    act(() => {
      fireEvent.change(inputEl(), { target: { value: "" } });
    });
    expect(inputEl().style.height).toBe("");
    expect(msgsEl()).toBeTruthy(); // 面板结构仍健康
  });

  it("发送清草稿后长高复位（draft 归零 → 内联高度清除）", async () => {
    await openPanel();
    setTaScrollHeight(120);
    act(() => {
      fireEvent.change(inputEl(), { target: { value: "一\n二\n三\n四" } });
    });
    setTaScrollHeight(0);
    act(() => {
      fireEvent.keyDown(inputEl(), { key: "Enter", altKey: true }); // Alt+Enter 发送
    });
    expect(sendStewardAsk).toHaveBeenCalledTimes(1);
    expect(inputEl().value).toBe("");
    expect(inputEl().style.height).toBe("");
  });
});
