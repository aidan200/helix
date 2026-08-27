// @vitest-environment jsdom
/**
 * S2 设置页实页化装配测试（AppLayout 壳 + 分区导航 + 模型配置分区迁入）。
 *
 * 断言面（brief-S2 验收 3/4）：
 * - AppLayout 组装：.app-layout/.app-header 在场，headerLeft = 页名词条；
 * - SettingsNav：data-settings-nav 在场，首项 data-section="models" 且激活；
 * - main = 模型分区（data-models-section），进入发 requestModelConfig +
 *   requestAuthList（原 P-4 进入拉数据链零变更）。
 *
 * vi.mock SessionContext 先例（ChatPage.test.tsx / TracePage.test.tsx）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { ModelConfigState } from "@/entities/session/model/state";

const requestModelConfig = vi.fn();
const requestAuthList = vi.fn();

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      topology: {
        modelConfig: {
          catalog: null,
          defaultModel: "",
          auth: {},
          authLoaded: false,
          verifyInflight: null,
          setKeyInflight: null,
          deleteKeyInflight: null,
          setDefaultInflight: null,
          catalogRefreshing: false,
        } satisfies ModelConfigState,
      },
      requestModelConfig,
      requestAuthList,
      refreshModelCatalog: vi.fn(),
      setDefaultModel: vi.fn(),
      verifyProvider: vi.fn(),
      setProviderKey: vi.fn(),
      deleteProviderKey: vi.fn(),
    }),
  };
});

import SettingsPage from "./SettingsPage";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <SettingsPage path="/settings" />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("S2 设置页实页化", () => {
  it("AppLayout 组装：壳骨架在场 + headerLeft = 页名词条（chat.nav.pages.settings.label）", () => {
    ui();
    expect(document.querySelector(".app-layout")).not.toBeNull();
    const header = document.querySelector(".app-header")!;
    expect(header).not.toBeNull();
    expect(header.querySelector(".tb-title")!.textContent).toBe("设置 settings");
    // 根锚（沿 TracePage/AgentPage data-*-page 模式）
    expect(document.querySelector('[data-settings-page="/settings"]')).not.toBeNull();
  });

  it("SettingsNav 分区导航：首项 = 模型设置（data-section 锚）且激活（aria-selected）", () => {
    ui();
    const nav = document.querySelector("[data-settings-nav]")!;
    expect(nav).not.toBeNull();
    const item = nav.querySelector<HTMLButtonElement>('[data-section="models"]')!;
    expect(item).not.toBeNull();
    expect(item.textContent).toBe("模型设置");
    expect(item.getAttribute("aria-selected")).toBe("true");
    expect(item.className).toContain("on");
    // W4：追加「工作空间」分区（有实内容才入列表——S2 裁决口径）
    expect(nav.querySelectorAll(".set-nav-item")).toHaveLength(2);
    expect(nav.querySelector('[data-section="workspace"]')!.textContent).toBe("工作空间");
  });

  it("main = 模型分区（原 P-4 迁入）：进入拉数据链零变更（requestModelConfig + requestAuthList）", () => {
    ui();
    expect(document.querySelector("[data-models-section]")).not.toBeNull();
    // .pg 版心保留
    expect(document.querySelector(".pg[data-models-section]")).not.toBeNull();
    expect(requestModelConfig).toHaveBeenCalledTimes(1);
    expect(requestAuthList).toHaveBeenCalledTimes(1);
    // 页壳退役：无返回钮
    expect(document.querySelector("#btn-p4-back")).toBeNull();
  });
});
