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

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { agentState: "idle", instances: [] },
      topology: { modelConfig: { compaction: null }, list: [] },
      requestCompactionConfig,
      setCompactionConfig: vi.fn(),
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
