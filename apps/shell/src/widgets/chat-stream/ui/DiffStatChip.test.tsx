// @vitest-environment jsdom
/**
 * DiffStatChip 测试（T3+T4 diff 批）——ChatStatusBar 中槽两 chip 统计件。
 *
 * 钉纪律：
 * - 空态隐藏：diff = null 或全零 → 不渲染（常驻行高度不受影响——槽位占位
 *   纪律由 ChatStatusBar 保，chip 自身零占位）；
 * - 两 chip 口径：+N（新增行）/ −N（删除行，U+2212）——无第三统计（口径已裁）；
 * - data-phase：active（主题色）/ frozen（灰态定格——仍可点击开详情）；
 * - 数值累计：帧重放（adds 变化）后数字更新；
 * - 点击 → onOpen（详情窗展开由 pages 层承接）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { createInitialSessionState, type SessionState } from "@/entities/session/model/session-reducer";

const stateRef: { current: SessionState } = { current: createInitialSessionState() };
const sendDiffGet = vi.fn().mockReturnValue(true);
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current, sendDiffGet }) };
});

import DiffStatChip from "./DiffStatChip";

afterEach(() => {
  cleanup();
  sendDiffGet.mockClear();
});

const active = (adds: number, dels: number): SessionState => ({
  ...createInitialSessionState(),
  sessionId: "s1",
  diff: { turnId: "t-1", phase: "active", adds, dels, fileCount: 2 },
});
const frozen = (adds: number, dels: number): SessionState => ({
  ...createInitialSessionState(),
  sessionId: "s1",
  diff: { turnId: "t-1", phase: "frozen", adds, dels, fileCount: 2 },
});

describe("DiffStatChip 空态", () => {
  it("diff = null → 不渲染（daemon 无记录如实呈现）", () => {
    stateRef.current = createInitialSessionState();
    const { container } = render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(container.querySelector('[data-testid="diff-stat-chips"]')).toBeNull();
  });

  it("全零（开轮后未记账）→ 不渲染", () => {
    stateRef.current = {
      ...createInitialSessionState(),
      diff: { turnId: "t-1", phase: "active", adds: 0, dels: 0, fileCount: 0 },
    };
    const { container } = render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(container.querySelector('[data-testid="diff-stat-chips"]')).toBeNull();
  });
});

describe("DiffStatChip 两 chip 统计", () => {
  it("active → +12 / −4 两 chip、data-phase=active", () => {
    stateRef.current = active(12, 4);
    const { container } = render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    const group = container.querySelector('[data-testid="diff-stat-chips"]')!;
    expect(group).not.toBeNull();
    expect(group.getAttribute("data-phase")).toBe("active");
    const add = group.querySelector(".diff-chip.add")!;
    const del = group.querySelector(".diff-chip.del")!;
    expect(add.textContent).toBe("+12");
    expect(del.textContent).toBe("−4");
  });

  it("数值累计：帧重放（adds 12 → 30）后数字更新", () => {
    stateRef.current = active(12, 4);
    const { container, rerender } = render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(container.querySelector(".diff-chip.add")!.textContent).toBe("+12");
    stateRef.current = active(30, 4);
    rerender(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(container.querySelector(".diff-chip.add")!.textContent).toBe("+30");
  });

  it("frozen → data-phase=frozen（灰态定格仍渲染可点击）", () => {
    stateRef.current = frozen(9, 2);
    const { container } = render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    const group = container.querySelector('[data-testid="diff-stat-chips"]')!;
    expect(group.getAttribute("data-phase")).toBe("frozen");
    expect(group.querySelector(".diff-chip.add")!.textContent).toBe("+9");
  });
});

describe("DiffStatChip 交互", () => {
  it("点击 chip 组 → onOpen 回调（详情窗展开）", () => {
    stateRef.current = active(12, 4);
    const onOpen = vi.fn();
    const { container } = render(
      <I18nProvider>
        <DiffStatChip onOpen={onOpen} />
      </I18nProvider>,
    );
    fireEvent.click(container.querySelector('[data-testid="diff-stat-chips"]')!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("DiffStatChip rehydrate（v0.3.1 §29：会话切回补拉）", () => {
  it("空态 + 会话确立 + 已连接 → 发 diff.get{live:true}（切回单查询即得进行中或最近轮）", () => {
    stateRef.current = { ...createInitialSessionState(), sessionId: "s1", conn: "connected" };
    render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).toHaveBeenCalledWith({ live: true });
    expect(sendDiffGet).toHaveBeenCalledTimes(1);
  });

  it("连接未就绪 → 不拉（ready 后 effect 重触发补拉）", () => {
    stateRef.current = { ...createInitialSessionState(), sessionId: "s1", conn: "connecting" };
    render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).not.toHaveBeenCalled();
  });

  it("草稿态（sessionId=null）→ 不拉", () => {
    stateRef.current = { ...createInitialSessionState(), conn: "connected" };
    render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).not.toHaveBeenCalled();
  });

  it("已有数据（diff 非空）→ 不拉（活跃期间广播帧驱动，无需补拉）", () => {
    stateRef.current = active(12, 4);
    render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).not.toHaveBeenCalled();
  });

  // v0.12 §43 空态回执容错（会话复水双修复）：daemon 重启后冷会话回
  // phase="empty"（consumers/diff 不落切片）→ diff 保持 null、chip 隐藏；
  // 重拉门控仅随 conn/sid 变化重试（无轮询风暴、无错误面）
  it("空态回执（phase=empty 不落切片）→ chip 隐藏 + 不重拉（deps 未变零重发）", () => {
    // 连接就绪 + 会话确立：发一次补拉（daemon 冷会话——回执不落切片，store diff 仍 null）
    stateRef.current = { ...createInitialSessionState(), sessionId: "s1", conn: "connected" };
    const { rerender, container } = render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="diff-stat-chips"]')).toBeNull(); // 空态不渲染
    // 同 deps 重渲染（空态回执后 diff 仍 null）→ 不重复发（无轮询风暴）
    rerender(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).toHaveBeenCalledTimes(1);
  });

  // code-review 低危组9 / TR-168：send 返回值必消费——false 一次性失败态，
  // conn 腿变化清标记重试（不重复发、不静默吞）
  it("sendDiffGet 返回 false（断线窗口）→ 一次性失败态停拉；conn 变化重试", async () => {
    sendDiffGet.mockReturnValue(false);
    stateRef.current = { ...createInitialSessionState(), sessionId: "s1", conn: "connected" };
    const { rerender } = render(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).toHaveBeenCalledTimes(1); // 发了一次，返回 false
    // 同条件重渲染（非 conn 变化）→ 失败标记停拉，不重复发
    rerender(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).toHaveBeenCalledTimes(1);
    // conn 腿变化（断连→重连）→ 清失败标记重试
    stateRef.current = { ...createInitialSessionState(), sessionId: "s1", conn: "disconnected" };
    rerender(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    stateRef.current = { ...createInitialSessionState(), sessionId: "s1", conn: "connected" };
    sendDiffGet.mockReturnValue(true);
    rerender(
      <I18nProvider>
        <DiffStatChip onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(sendDiffGet).toHaveBeenCalledTimes(2); // 重连后补拉一次
  });
});
