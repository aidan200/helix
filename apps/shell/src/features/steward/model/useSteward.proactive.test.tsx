// @vitest-environment jsdom
/**
 * M3-a 批：对话内主动汇报实时帧消费测试（CAND-601 闭环——steward.proactive
 * additive 事件帧到达，开着的面板 items 实时冒出汇报条目，不重开面板）。
 *
 * - 帧到达 → assistant 条目追加（【主动汇报】标题行 + 正文 + 建议行——与
 *   回放记录 recordsToItems 的渲染同构：面板开着实时见 = 重开后回放见）；
 * - 帧缺字段/坏形状 → 忽略零破坏（旧壳防御）；
 * - 与回放同源：history.result 整体替换后同形状可再现（权威面语义不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
const sendStewardHistory = vi.fn(() => true);
let frameListener: ((e: EventEnvelope) => void) | null = null;
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  frameListener = cb;
  return () => {
    frameListener = null;
  };
});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    sendStewardHistory,
    subscribeStewardFrames,
  }),
}));

import { useSteward } from "./useSteward";

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

function renderSteward() {
  return renderHook(() => useSteward(), {
    wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider>,
  });
}

describe("useSteward：steward.proactive 实时汇报帧（M3-a）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("帧到达 → items 实时追加 assistant 条目（不重开面板/不拉 history）", async () => {
    const { result } = renderSteward();
    expect(result.current.items.length).toBe(0);

    act(() => {
      frameListener?.(
        frame("steward.proactive", {
          title: "部署完成",
          text: "部署服务这轮跑完了，健康检查全部通过。",
          suggestions: [{ label: "看看报告" }],
          seq: 1,
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.items.length).toBe(1);
    });
    const item = result.current.items[0]!;
    expect(item.kind).toBe("assistant");
    if (item.kind !== "assistant") throw new Error("unreachable");
    // 与回放记录同构渲染：【主动汇报】标题行 + 正文 + 建议行
    expect(item.text).toContain("【主动汇报】部署完成");
    expect(item.text).toContain("健康检查全部通过");
    expect(item.text).toContain("建议：看看报告");
    // 零 history 重拉（实时帧独立于回放面）
    expect(sendStewardHistory).toHaveBeenCalledTimes(1); // 仅 mount 首拉
  });

  it("连续多条汇报帧按到达序追加", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(frame("steward.proactive", { title: "一", text: "t1", suggestions: [], seq: 1 }));
    });
    act(() => {
      frameListener?.(frame("steward.proactive", { title: "二", text: "t2", suggestions: [], seq: 2 }));
    });
    await waitFor(() => {
      expect(result.current.items.length).toBe(2);
    });
    const texts = result.current.items.map((i) => (i.kind === "assistant" ? i.text : ""));
    expect(texts[0]).toContain("【主动汇报】一");
    expect(texts[1]).toContain("【主动汇报】二");
  });

  it("帧缺字段/坏形状 → 忽略零破坏（旧壳防御——additive 帧纪律）", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(frame("steward.proactive", { text: "缺 title" }));
    });
    act(() => {
      frameListener?.(frame("steward.proactive", { title: "缺 text" }));
    });
    act(() => {
      frameListener?.(frame("steward.proactive", "不是对象"));
    });
    act(() => {
      frameListener?.(frame("steward.proactive", { title: "", text: "", seq: 3 }));
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.items.length).toBe(0); // 全部忽略——零脏条目零异常
  });

  it("回放权威面：history.result 整体替换后同形状再现（实时帧与回放同源）", async () => {
    const { result } = renderSteward();
    act(() => {
      frameListener?.(frame("steward.proactive", { title: "部署完成", text: "跑完了。", suggestions: [], seq: 1 }));
    });
    await waitFor(() => {
      expect(result.current.items.length).toBe(1);
    });
    // 重连回放：daemon KV 记录（reportProactive 落的 assistant 记录）整体替换
    act(() => {
      frameListener?.(
        frame("steward.history.result", {
          records: [{ kind: "assistant", text: "【主动汇报】部署完成\n跑完了。", at: 42 }],
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.items.length).toBe(1);
    });
    const item = result.current.items[0]!;
    expect(item.kind).toBe("assistant");
    if (item.kind !== "assistant") throw new Error("unreachable");
    expect(item.text).toContain("【主动汇报】部署完成"); // 回放与实时渲染同形
  });
});
