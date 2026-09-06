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

const setDefaultModel = vi.fn(() => true);
const setThinkingDefault = vi.fn();
const refreshModelCatalog = vi.fn(() => true);
const verifyProvider = vi.fn(() => true);
const setProviderKey = vi.fn(() => true);
const deleteProviderKey = vi.fn(() => true);
const consumeModelConfigError = vi.fn();
/** M47：目录刷新在途可变位（结果帧驱动 toast 测试）。 */
let mockRefreshing = false;
/** F5 批 #3：写面失败交代可变位（connection.error 清在途 → err toast 测试）。 */
let mockWriteError: { message: string; ts: number } | null = null;

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
  writeError: null,
  compaction: null,
    scheduling: null,
    port: null,
};

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      topology: { modelConfig: { ...mc, catalogRefreshing: mockRefreshing, writeError: mockWriteError } },
      requestModelConfig: vi.fn(),
      requestAuthList: vi.fn(),
      refreshModelCatalog,
      setDefaultModel,
      setThinkingDefault,
      verifyProvider,
      setProviderKey,
      deleteProviderKey,
      consumeModelConfigError,
    }),
  };
});

import ModelsSettingsSection from "./ui/ModelsSettingsSection";

afterEach(() => {
  cleanup();
  mockRefreshing = false;
  mockWriteError = null;
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

function element() {
  return (
    <I18nProvider>
      <ToastProvider>
        <ModelsSettingsSection />
      </ToastProvider>
    </I18nProvider>
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

describe("M47：目录刷新 toast 结果帧驱动", () => {
  it("点击不即弹；catalogRefreshing true→false 转换（结果帧到达）才弹「模型目录已刷新」", () => {
    const view = ui();
    fireEvent.click(document.querySelector("#btn-refresh-catalog")!);
    expect(refreshModelCatalog).toHaveBeenCalledTimes(1);
    // 点击即时：不弹（不假反馈）
    expect(document.querySelector(".toast-zone")!.textContent).not.toContain("模型目录已刷新");
    // 在途中：不弹
    mockRefreshing = true;
    view.rerender(element());
    expect(document.querySelector(".toast-zone")!.textContent).not.toContain("模型目录已刷新");
    // 结果帧到达（refreshing 复位）→ 弹
    mockRefreshing = false;
    view.rerender(element());
    expect(document.querySelector(".toast-zone")!.textContent).toContain("模型目录已刷新");
  });
});

describe("F5 批 #1/#3：send 失败 err 交代 + connection.error 失败交代", () => {
  it("刷新 send 失败（返回 false）→ err toast + M47 锚灭（后续 true→false 不误弹 ok）", () => {
    refreshModelCatalog.mockReturnValueOnce(false);
    const view = ui();
    fireEvent.click(document.querySelector("#btn-refresh-catalog")!);
    expect(document.querySelector(".toast-zone")!.textContent).toContain("未连接 daemon，操作未发出");
    // in-flight 已回滚：后续 catalogRefreshing true→false 转换不得弹 ok 假反馈
    mockRefreshing = true;
    view.rerender(element());
    mockRefreshing = false;
    view.rerender(element());
    expect(document.querySelector(".toast-zone")!.textContent).not.toContain("模型目录已刷新");
  });

  it("设为默认 send 失败 → err toast 且不弹「已更新」假反馈", () => {
    setDefaultModel.mockReturnValueOnce(false);
    ui();
    fireEvent.click(document.querySelector('[data-prov="anthropic"] [data-prov-toggle]')!);
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-set-default="anthropic/claude-b"]')!);
    expect(document.querySelector(".toast-zone")!.textContent).toContain("未连接 daemon，操作未发出");
    expect(document.querySelector(".toast-zone")!.textContent).not.toContain("已更新");
  });

  it("测试连通 send 失败 → err toast", () => {
    verifyProvider.mockReturnValueOnce(false);
    ui();
    fireEvent.click(document.querySelector('[data-prov="anthropic"] [data-prov-toggle]')!);
    fireEvent.click(document.querySelector('[data-prov="anthropic"] [data-prov-test]')!);
    expect(document.querySelector(".toast-zone")!.textContent).toContain("未连接 daemon，操作未发出");
  });

  it("writeError 置位（connection.error 清在途后）→ err toast 带 daemon 信息 + 一次性消费", () => {
    mockWriteError = { message: "key 无效", ts: 1 };
    ui();
    expect(document.querySelector(".toast-zone")!.textContent).toContain("操作失败 · key 无效");
    expect(consumeModelConfigError).toHaveBeenCalledTimes(1);
  });

  it("writeError 与刷新在途同帧清位 → 失败交代优先，ok 假反馈被抑制", () => {
    const view = ui();
    fireEvent.click(document.querySelector("#btn-refresh-catalog")!);
    // connection.error 到达：catalogRefreshing 清位 + writeError 置位（同帧）
    mockRefreshing = false;
    mockWriteError = { message: "refresh failed", ts: 2 };
    view.rerender(element());
    const zone = document.querySelector(".toast-zone")!.textContent!;
    expect(zone).toContain("操作失败 · refresh failed");
    expect(zone).not.toContain("模型目录已刷新");
  });
});
