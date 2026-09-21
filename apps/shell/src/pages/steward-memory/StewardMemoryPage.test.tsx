// @vitest-environment jsdom
/**
 * 管家记忆独立页测试（B2-④）：
 * - 头部：搜索框（前端过滤）+ 统计「N 条 · dim 维」+ 端点徽标 + 新增入口
 *   （不可用态禁用 + 提示）；
 * - 列表（memory_list.result 驱动）：text/kind 徽标/来源轮次；
 * - 行内编辑：保存 → sendStewardMemoryUpdate（向量化中异步态）→ 新清单回执清态；
 * - armed 删除 + 新增弹窗（text + kind 下拉 → sendStewardMemoryAppend）。
 *
 * vi.mock SessionContext 先例（EmbeddingModelsTab.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

const sendStewardMemoryList = vi.fn(() => true);
const sendStewardMemoryAppend = vi.fn(() => true);
const sendStewardMemoryUpdate = vi.fn(() => true);
const sendStewardMemoryDelete = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
let stewardListeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      sendStewardMemoryList,
      sendStewardMemoryAppend,
      sendStewardMemoryUpdate,
      sendStewardMemoryDelete,
      sendStewardGetConfig,
      subscribeStewardFrames: (listener: (e: EventEnvelope) => void) => {
        stewardListeners.push(listener);
        return () => {
          stewardListeners = stewardListeners.filter((l) => l !== listener);
        };
      },
    }),
  };
});

vi.mock("@/widgets/app-layout/ui/AppLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import StewardMemoryPage from "./StewardMemoryPage";

beforeEach(() => {
  localStorage.setItem("helix-lang", "zh-CN");
});

afterEach(() => {
  cleanup();
  stewardListeners = [];
  vi.clearAllMocks();
});

const ENTRIES = [
  { id: 1, text: "用户偏好简洁回复", kind: "preference", createdAt: 1_760_000_000_000, sourceTurn: "manual" },
  { id: 2, text: "主技术栈：TypeScript + React", kind: "fact", createdAt: 1_760_001_000_000, sourceTurn: "steward-turn" },
];

function feedList(entries: typeof ENTRIES) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "steward",
    type: "steward.memory_list.result",
    ts: 1,
    payload: { entries },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of stewardListeners) l(frame);
  });
}

function feedConfig(available: boolean) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "steward",
    type: "steward.config.result",
    ts: 1,
    payload: {
      enabled: true,
      model: "deepseek/x",
      memory: {
        enabled: true,
        available,
        endpoint: available ? { id: "ep-1", name: "Ollama 本地", model: "bge-m3", hasApiKey: false } : null,
        entryCount: ENTRIES.length,
        dim: 1024,
      },
    },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of stewardListeners) l(frame);
  });
}

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <StewardMemoryPage path="/steward/memory" />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("管家记忆独立页（B2-④）", () => {
  it("进入拉取：memory_list + get_config；头部统计 + 端点徽标 + 条目渲染", () => {
    const { container } = ui();
    expect(sendStewardMemoryList).toHaveBeenCalledTimes(1);
    expect(sendStewardGetConfig).toHaveBeenCalledTimes(1);
    feedConfig(true);
    act(() => feedList(ENTRIES));
    expect(container.querySelector("[data-memory-stats]")!.textContent).toContain("1024");
    expect(container.querySelector("[data-memory-endpoint-badge]")!.textContent).toContain("bge-m3");
    expect(container.querySelector('[data-memory-item-text="1"]')!.textContent).toBe("用户偏好简洁回复");
    expect(container.querySelector('[data-memory-item-kind="1"]')!.textContent).toContain("偏好");
    expect(container.querySelector('[data-memory-item-kind="2"]')!.textContent).toContain("事实");
    expect(container.querySelector('[data-memory-item-meta="2"]')!.textContent).toContain("管家沉淀");
  });

  it("搜索过滤：前端子串过滤（大小写不敏感）", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-search]")!, { target: { value: "typescript" } });
    expect(container.querySelector('[data-memory-item="1"]')).toBeNull();
    expect(container.querySelector('[data-memory-item="2"]')).not.toBeNull();
  });

  it("不可用态：新增/编辑禁用 + 提示行（endpoint null → available false）", () => {
    const { container } = ui();
    feedConfig(false);
    act(() => feedList(ENTRIES));
    expect(container.querySelector<HTMLButtonElement>("[data-memory-add-open]")!.disabled).toBe(true);
    expect(container.querySelector("[data-memory-unavailable]")!).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-memory-edit-btn="1"]')!.disabled).toBe(true);
  });

  it("行内编辑：进入编辑态 → 保存 sendStewardMemoryUpdate + 向量化中态 → 新清单清态", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-memory-edit-btn="1"]')!);
    const input = container.querySelector<HTMLInputElement>("[data-memory-edit-input]")!;
    expect(input.value).toBe("用户偏好简洁回复");
    fireEvent.change(input, { target: { value: "改写后的记忆" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-edit-save]")!);
    expect(sendStewardMemoryUpdate).toHaveBeenCalledWith(1, "改写后的记忆");
    expect(container.querySelector("[data-memory-edit-input]")).toBeNull(); // 编辑态退出（在途）
    // 新清单回执到达 → 正常渲染新文本
    act(() => feedList([{ ...ENTRIES[0]!, text: "改写后的记忆" }, ENTRIES[1]!]));
    expect(container.querySelector('[data-memory-item-text="1"]')!.textContent).toBe("改写后的记忆");
  });

  it("armed 删除：首击 armed → 二击 sendStewardMemoryDelete", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    const del = container.querySelector<HTMLButtonElement>('[data-memory-delete-btn="1"]')!;
    fireEvent.click(del);
    expect(sendStewardMemoryDelete).not.toHaveBeenCalled();
    expect(del.dataset.armed).toBe("1");
    fireEvent.click(del);
    expect(sendStewardMemoryDelete).toHaveBeenCalledWith(1);
  });

  it("新增弹窗：空文本内联错误 → text + kind → sendStewardMemoryAppend", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList(ENTRIES));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-open]")!);
    expect(container.querySelector("[data-memory-add-input]")).not.toBeNull();
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-save]")!);
    expect(container.querySelector("[data-memory-add-err]")!.textContent).toContain("不得为空");
    expect(sendStewardMemoryAppend).not.toHaveBeenCalled();
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-memory-add-input]")!, { target: { value: "手动新增一条" } });
    fireEvent.change(container.querySelector<HTMLSelectElement>("[data-memory-add-kind]")!, { target: { value: "preference" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-add-save]")!);
    expect(sendStewardMemoryAppend).toHaveBeenCalledWith("手动新增一条", "preference");
    expect(container.querySelector("[data-memory-add-input]")).toBeNull(); // 弹窗关闭（向量化在途）
  });

  it("空列表空态提示", () => {
    const { container } = ui();
    feedConfig(true);
    act(() => feedList([]));
    expect(container.querySelector("[data-memory-list-empty]")!.textContent).toContain("暂无记忆条目");
  });
});
