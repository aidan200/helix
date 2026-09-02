// @vitest-environment jsdom
/**
 * 模型设置分区显示逻辑改造测试：
 * - 全局默认模型只读展示（不下拉、不可改）；
 * - 展开的模型表内，非默认模型行带「设为默认」按钮（点击发 setDefaultModel）；
 * - 折叠的 provider 行若托管默认模型则显示默认模型标签；
 * - 工具卡两行收紧（行 1：默认模型 + 推理强度；行 2：刷新 + 更新时间）。
 *
 * vi.mock SessionContext 先例（SettingsPage.test.tsx）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { ModelConfigState } from "@/entities/session/model/state";
import type { CatalogModel } from "@helix/protocol";

const setDefaultModel = vi.fn();
const setThinkingDefault = vi.fn();

function model(id: string, providerId: string): CatalogModel {
  return {
    id,
    providerId,
    contextWindow: 200_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    source: "builtin",
    reasoning: false,
    thinkingLevels: [],
  };
}

const mc: ModelConfigState = {
  catalog: {
    models: [
      model("anthropic/claude-a", "anthropic"),
      model("anthropic/claude-b", "anthropic"),
      model("openai/gpt-x", "openai"),
    ],
    refreshedAt: Date.now(),
    source: "cache",
    degraded: [],
  },
  defaultModel: "anthropic/claude-a",
  defaultThinking: null,
  auth: {
    anthropic: { providerId: "anthropic", configured: true, keyMasked: "····7f3a", verifyStatus: "unverified" },
    openai: { providerId: "openai", configured: false, verifyStatus: "unverified" },
  },
  authLoaded: true,
  verifyInflight: null,
  setKeyInflight: null,
  deleteKeyInflight: null,
  setDefaultInflight: null,
  catalogRefreshing: false,
  compaction: null,
};

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      topology: { modelConfig: mc },
      requestModelConfig: vi.fn(),
      requestAuthList: vi.fn(),
      refreshModelCatalog: vi.fn(),
      setDefaultModel,
      setThinkingDefault,
      verifyProvider: vi.fn(),
      setProviderKey: vi.fn(),
      deleteProviderKey: vi.fn(),
    }),
  };
});

import ModelsSettingsSection from "./ui/ModelsSettingsSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <ModelsSettingsSection />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("模型设置分区：全局默认显示逻辑", () => {
  it("默认模型只读展示：无下拉选择器，直接显示当前默认模型", () => {
    ui();
    expect(document.querySelector("select#sel-default")).toBeNull();
    const el = document.querySelector("[data-default-model]")!;
    expect(el).not.toBeNull();
    expect(el.textContent).toBe("anthropic/claude-a");
  });

  it("折叠的 provider 行：托管默认模型的行显示默认模型标签，其余行无标签", () => {
    ui();
    const anthropic = document.querySelector('[data-prov="anthropic"]')!;
    const tag = anthropic.querySelector("[data-prov-default-tag]")!;
    expect(tag).not.toBeNull();
    expect(tag.textContent).toContain("anthropic/claude-a");
    expect(document.querySelector('[data-prov="openai"] [data-prov-default-tag]')).toBeNull();
  });

  it("展开的模型表：非默认行带「设为默认」按钮，默认行无按钮；点击发 setDefaultModel", () => {
    ui();
    fireEvent.click(document.querySelector('[data-prov="anthropic"] [data-prov-toggle]')!);
    const defaultRow = document.querySelector('[data-model-row="anthropic/claude-a"]')!;
    expect(defaultRow.querySelector("[data-set-default]")).toBeNull();
    const otherRow = document.querySelector('[data-model-row="anthropic/claude-b"]')!;
    const btn = otherRow.querySelector<HTMLButtonElement>('[data-set-default="anthropic/claude-b"]')!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("设为默认");
    fireEvent.click(btn);
    expect(setDefaultModel).toHaveBeenCalledWith("anthropic/claude-b");
  });

  it("工具卡两行收紧：行 1 = 默认模型 + 推理强度，行 2 = 刷新按钮 + 更新时间", () => {
    ui();
    const rows = document.querySelectorAll(".toolbar > .toolbar-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector("[data-default-model]")).not.toBeNull();
    expect(rows[0]!.querySelector("[data-global-thinking-unsupported]")).not.toBeNull();
    expect(rows[1]!.querySelector("#btn-refresh-catalog")).not.toBeNull();
    expect(rows[1]!.querySelector("[data-catalog-meta]")).not.toBeNull();
  });
});
