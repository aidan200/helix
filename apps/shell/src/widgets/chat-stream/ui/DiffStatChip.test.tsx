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
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current }) };
});

import DiffStatChip from "./DiffStatChip";

afterEach(cleanup);

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
