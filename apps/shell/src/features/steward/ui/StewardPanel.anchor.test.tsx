// @vitest-environment jsdom
/**
 * StewardPanel 历史锚底测试（管家驾驶舱批①：对照 chat 页 MessageStream
 * 滚动语义同构复用）：
 * - 新内容（流式 delta / 条目追加）吸附态贴底；
 * - 用户上滚脱附 → 流式新内容不再拽回底部（scrollTop 保持）；
 * - 滚回底部 1s 驻留 → 恢复吸附（后续增长贴底）；驻留期滚离取消；
 * - 打开面板（active 升起）→ 强制贴底 + 吸附复位。
 *
 * jsdom 无布局：scrollHeight 以 own property 注入（MessageFlow.test 同法）。
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
function emitSteward(e: EventEnvelope): void {
  for (const l of stewardListeners) l(e);
}

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

const msgsEl = () => document.querySelector<HTMLElement>('[data-testid="steward-msgs"]')!;
const setScrollHeight = (h: number) =>
  Object.defineProperty(msgsEl(), "scrollHeight", { value: h, configurable: true });

function renderPanel(active = true) {
  return render(
    <I18nProvider>
      <StewardPanel onClose={() => undefined} active={active} />
    </I18nProvider>,
  );
}

/** 开启面板（config.result enabled）并等消息区挂载。 */
async function openPanel() {
  renderPanel();
  act(() => {
    emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
  });
  await vi.waitFor(() => expect(msgsEl()).toBeTruthy());
}

describe("StewardPanel 历史锚底（驾驶舱批①）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stewardListeners.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("流式增长贴底：吸附态下 ask.delta → scrollTop = scrollHeight", async () => {
    await openPanel();
    setScrollHeight(1000);
    // 触发流式在途：先 ask（user 气泡 + inFlight），再 delta
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "在吗" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    act(() => {
      emitSteward(frame("steward.ask.delta", { delta: "当前", seq: 1 }));
    });
    expect(msgsEl().scrollTop).toBe(1000);
  });

  it("上滚脱附：流式新内容不拽回底部（scrollTop 保持）", async () => {
    await openPanel();
    setScrollHeight(1000);
    msgsEl().scrollTop = 200; // 用户上滚离开底部
    fireEvent.scroll(msgsEl(), { target: { scrollTop: 200 } });
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "在吗" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    act(() => {
      emitSteward(frame("steward.ask.delta", { delta: "当前", seq: 1 }));
    });
    expect(msgsEl().scrollTop).toBe(200); // 脱附：不拽回
  });

  it("回底驻留 1s 恢复吸附：驻留期满后增长重新贴底；驻留期滚离取消", async () => {
    await openPanel();
    vi.useFakeTimers();
    setScrollHeight(1000);
    // ask 在途（delta 才会被采纳聚合——useSteward 防脏写）
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "在吗" } });
    fireEvent.click(screen.getByTestId("steward-send"));
    // 脱附
    msgsEl().scrollTop = 200;
    fireEvent.scroll(msgsEl(), { target: { scrollTop: 200 } });
    // 滚回底部（距底 ≤40 视为在底）→ 1s 驻留
    msgsEl().scrollTop = 970;
    fireEvent.scroll(msgsEl(), { target: { scrollTop: 970 } });
    // 驻留期内流式增长不贴底（仍未吸附）
    setScrollHeight(1200);
    act(() => {
      emitSteward(frame("steward.ask.delta", { delta: "x", seq: 1 }));
    });
    expect(msgsEl().scrollTop).toBe(970);
    // 驻留期满 → 吸附恢复并直设贴底
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(msgsEl().scrollTop).toBe(1200);
    // 吸附后新增长继续贴底
    setScrollHeight(1500);
    act(() => {
      emitSteward(frame("steward.ask.delta", { delta: "y", seq: 2 }));
    });
    expect(msgsEl().scrollTop).toBe(1500);
  });

  it("驻留期滚离取消：advance 未满 1s 先滚离 → 期满不吸附", async () => {
    await openPanel();
    vi.useFakeTimers();
    setScrollHeight(1000);
    msgsEl().scrollTop = 200;
    fireEvent.scroll(msgsEl(), { target: { scrollTop: 200 } });
    msgsEl().scrollTop = 980;
    fireEvent.scroll(msgsEl(), { target: { scrollTop: 980 } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    msgsEl().scrollTop = 300; // 驻留期主动滚离
    fireEvent.scroll(msgsEl(), { target: { scrollTop: 300 } });
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(msgsEl().scrollTop).toBe(300); // 期满不吸附（驻留已取消）
  });

  it("打开面板强制贴底：active 升起 → scrollTop = scrollHeight（即使先前脱附）", async () => {
    renderPanel(false);
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    await vi.waitFor(() => expect(msgsEl()).toBeTruthy());
    setScrollHeight(800);
    msgsEl().scrollTop = 100; // 隐藏期残留位置
    // 面板打开（active true）
    cleanup();
    vi.clearAllMocks();
    const { rerender } = render(
      <I18nProvider>
        <StewardPanel onClose={() => undefined} active={false} />
      </I18nProvider>,
    );
    act(() => {
      emitSteward(frame("steward.config.result", { enabled: true, model: "x/y" }));
    });
    await vi.waitFor(() => expect(msgsEl()).toBeTruthy());
    setScrollHeight(800);
    msgsEl().scrollTop = 100;
    rerender(
      <I18nProvider>
        <StewardPanel onClose={() => undefined} active={true} />
      </I18nProvider>,
    );
    expect(msgsEl().scrollTop).toBe(800);
  });

  it("回放重建贴底：steward.history.result 到达（吸附态）→ items 替换后贴底", async () => {
    await openPanel();
    setScrollHeight(500);
    act(() => {
      emitSteward(
        frame("steward.history.result", {
          records: [
            { kind: "user", text: "在吗", at: 1 },
            { kind: "assistant", text: "在的", at: 2 },
          ],
        }),
      );
    });
    expect(msgsEl().scrollTop).toBe(500);
  });
});
