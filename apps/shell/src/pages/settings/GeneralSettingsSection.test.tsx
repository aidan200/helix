// @vitest-environment jsdom
/**
 * 通用配置分区测试：
 * - 语言切换入口：中文/English 两选项，当前语言 aria-pressed 激活；
 *   点击切换 → localStorage helix-lang 持久化 + 词条即时切换（标题双语验证）；
 * - 压缩参数卡保留（进入拉 requestCompactionConfig）。
 *
 * vi.mock SessionContext 先例（SettingsPage.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";

const requestCompactionConfig = vi.fn();
const setCompactionConfig = vi.fn();
/** M44/M46：压缩参数结果帧可变位（结果帧驱动回填 / 「已保存」对账）。 */
let mockCompaction: { reserveTokens: number; keepRecentTokens: number } | null = null;

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { agentState: "idle", instances: [] },
      topology: { modelConfig: { compaction: mockCompaction }, list: [] },
      requestCompactionConfig,
      setCompactionConfig,
    }),
  };
});

vi.mock("@/entities/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({
    state: {
      phase: "main",
      current: { root: "/ws/helix" },
      recents: [],
      notice: null,
      opening: false,
      openError: null,
      switching: false,
    },
    startSwitch: vi.fn(),
  }),
}));

import GeneralSettingsSection from "./ui/GeneralSettingsSection";

beforeEach(() => {
  localStorage.setItem("helix-lang", "zh-CN");
});

afterEach(() => {
  cleanup();
  mockCompaction = null;
  vi.clearAllMocks();
});

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <GeneralSettingsSection />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("通用配置分区：语言切换", () => {
  it("语言切换入口在场：中文/English 两选项，当前语言激活（aria-pressed）", () => {
    ui();
    const switchEl = document.querySelector("[data-lang-switch]")!;
    expect(switchEl).not.toBeNull();
    const zh = switchEl.querySelector<HTMLButtonElement>('[data-lang-option="zh-CN"]')!;
    const en = switchEl.querySelector<HTMLButtonElement>('[data-lang-option="en-US"]')!;
    expect(zh.textContent).toBe("中文");
    expect(en.textContent).toBe("English");
    expect(zh.getAttribute("aria-pressed")).toBe("true");
    expect(en.getAttribute("aria-pressed")).toBe("false");
  });

  it("点击 English → localStorage 持久化 en-US + 词条即时切换（标题 General）", () => {
    ui();
    expect(document.querySelector(".pg-title")!.textContent).toBe("通用配置");
    fireEvent.click(document.querySelector('[data-lang-option="en-US"]')!);
    expect(localStorage.getItem("helix-lang")).toBe("en-US");
    expect(document.querySelector(".pg-title")!.textContent).toBe("General");
    expect(
      document.querySelector('[data-lang-option="en-US"]')!.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("压缩参数卡保留：进入分区拉取现值（requestCompactionConfig）", () => {
    ui();
    expect(requestCompactionConfig).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-compaction-save]")).not.toBeNull();
  });

  it("工作空间卡并入通用分区（独立分区撤项）：绑定路径与切换按钮在场", () => {
    ui();
    const card = document.querySelector("[data-workspace-section]")!;
    expect(card).not.toBeNull();
    expect(card.querySelector("[data-ws-set-root]")!.textContent).toBe("/ws/helix");
    expect(card.querySelector("[data-ws-set-switch]")).not.toBeNull();
  });
});

describe("M44/M45/M46 压缩参数保存链路", () => {
  const inputs = () => ({
    reserve: document.querySelector<HTMLInputElement>("[data-compaction-reserve]")!,
    keep: document.querySelector<HTMLInputElement>("[data-compaction-keep-recent]")!,
    save: document.querySelector<HTMLButtonElement>("[data-compaction-save]")!,
  });

  it("M45：空串显式拦截（Number(\"\")===0 不再静默写 0）", () => {
    ui();
    const { reserve, keep, save } = inputs();
    fireEvent.change(reserve, { target: { value: "" } });
    fireEvent.change(keep, { target: { value: "32000" } });
    fireEvent.click(save);
    expect(setCompactionConfig).not.toHaveBeenCalled();
  });

  it("M44：「已保存」由 set_compaction.result 结果帧驱动（非乐观置位）", () => {
    const view = ui();
    const { reserve, keep, save } = inputs();
    fireEvent.change(reserve, { target: { value: "96000" } });
    fireEvent.change(keep, { target: { value: "32000" } });
    fireEvent.click(save);
    expect(setCompactionConfig).toHaveBeenCalledWith(96000, 32000);
    // 结果帧未达：不出现「已保存」（不假反馈）
    expect(document.querySelector("[data-compaction-saved]")).toBeNull();
    // 结果帧到达（compaction 更新）→ 「已保存」出现
    mockCompaction = { reserveTokens: 96000, keepRecentTokens: 32000 };
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <GeneralSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(document.querySelector("[data-compaction-saved]")!.textContent).toContain("已保存");
  });

  it("M46：用户有未保存编辑时结果帧不回填覆盖（dirty 门控）", () => {
    mockCompaction = { reserveTokens: 96000, keepRecentTokens: 32000 };
    const view = ui();
    const { reserve } = inputs();
    expect(reserve.value).toBe("96000"); // 初始回填
    // 用户编辑（未保存）→ 脏态
    fireEvent.change(reserve, { target: { value: "50000" } });
    // 新的结果帧到达（如他人/他端变更）→ 不覆盖未保存编辑
    mockCompaction = { reserveTokens: 120000, keepRecentTokens: 40000 };
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <GeneralSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
    expect((document.querySelector<HTMLInputElement>("[data-compaction-reserve]")!).value).toBe("50000");
    expect((document.querySelector<HTMLInputElement>("[data-compaction-keep-recent]")!).value).toBe("32000");
  });
});
