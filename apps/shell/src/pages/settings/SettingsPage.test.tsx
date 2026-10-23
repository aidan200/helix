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
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { ModelConfigState } from "@/entities/session/model/state";

const requestModelConfig = vi.fn();
const requestAuthList = vi.fn();

// 通用分区轻量替身（本文件只验壳/导航/指路信号；通用分区数据面另有专测）
vi.mock("./ui/GeneralSettingsSection", () => ({
  default: () => <div className="pg" data-general-section />,
}));

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      topology: {
        modelConfig: {
          catalog: null,
          defaultModel: "", defaultThinking: null,
          auth: {},
          authLoaded: false,
          verifyInflight: null,
          setKeyInflight: null,
          deleteKeyInflight: null,
          login: null,
          loginSucceeded: null,
          logoutInflight: null,
          setDefaultInflight: null,
          catalogRefreshing: false,
          writeError: null,
          compaction: null,
    scheduling: null,
    port: null,
    sandbox: null,
    summary: null,
    voiceModels: null,
    kg: null,
    proxy: null,
    proxyInflight: false,
    proxySaved: false,
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
import { peekPendingSection, requestSettingsSection } from "./settings-section-bus";

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
        <SettingsPage path="/settings" onOpenStewardMemory={vi.fn()} />
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
    expect(header.querySelector(".tb-title")!.textContent).toBe("设置");
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
    // W4：追加「工作空间」分区 + config 批：追加「通用」分区（有实内容才入列表）
    // 后裁决：工作空间撤项并入通用（单配置独占一页浪费）→ 两分区；
    // mcp 批：追加「MCP 服务」分区（server 配置面）→ 三分区；
    // skills 批：追加「技能管理」分区（用户级技能单源管理面）→ 四分区；
    // 语音输入批：追加「语音输入」分区（provider/key）→ 五分区；
    // V2.5 收官批：追加「管家」分区 → 六分区；
    // 管家配置并轨批：管家分区退役（启用/语音播报并通用、模型槽位并智能体页）→ 五分区
    expect(nav.querySelectorAll(".set-nav-item")).toHaveLength(5);
    expect(nav.querySelector('[data-section="steward"]')).toBeNull();
    expect(nav.querySelector('[data-section="general"]')!.textContent).toBe("通用设置");
    expect(nav.querySelector('[data-section="mcp"]')!.textContent).toBe("MCP 服务");
    expect(nav.querySelector('[data-section="skills"]')!.textContent).toBe("技能管理");
  });

  it("跨页指路信号：挂载时消费一次（分区 + 模型 tab）；清位后重挂载回缺省（一次性语义）", () => {
    requestSettingsSection("general");
    const first = ui();
    expect(document.querySelector("[data-settings-page]")).not.toBeNull();
    // 信号已清位（渲染期不再 consume——StrictMode 双渲染腿不丢信号）
    expect(peekPendingSection()).toBeNull();
    first.unmount();
    // 重挂载：无信号 → 回缺省分区（模型设置）
    ui();
    expect(document.querySelector("[data-models-section]")).not.toBeNull();
    cleanup();
  });

  it("StrictMode 双渲染腿不丢指路信号（渲染期 peek 只读 + 挂载 effect 清位）", () => {
    requestSettingsSection("general");
    render(
      <StrictMode>
        <I18nProvider>
          <ToastProvider>
            <SettingsPage path="/settings" onOpenStewardMemory={vi.fn()} />
          </ToastProvider>
        </I18nProvider>
      </StrictMode>,
    );
    // 旧实现：渲染期 consume → 第二腿得 null → 落缺省（models 分区）
    expect(document.querySelector(".pg[data-general-section]")).not.toBeNull();
    expect(document.querySelector("[data-models-section]")).toBeNull();
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
