// @vitest-environment jsdom
/**
 * 通用配置分区测试：
 * - 语言切换入口：中文/English 两选项，当前语言 aria-pressed 激活；
 *   点击切换 → localStorage helix-lang 持久化 + 词条即时切换（标题双语验证）；
 * - 压缩参数卡保留（进入拉 requestCompactionConfig）；
 * - M10 批②：config 族在途错误经 connection.error 收口——清 pending +
 *   行内错误交代，不假「已保存」、后续读帧不被误当保存回执（单飞门控）。
 *
 * vi.mock SessionContext 先例（SettingsPage.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

const requestCompactionConfig = vi.fn();
const setCompactionConfig = vi.fn();
const requestSchedulingConfig = vi.fn();
const setSchedulingConfig = vi.fn();
const requestPortConfig = vi.fn();
const requestSandboxConfig = vi.fn();
const setSandboxConfig = vi.fn();
/** 沙箱开关状态（结果帧驱动回填用可变位）。 */
let mockSandbox: { enabled: boolean } | null = null;
const setPortConfig = vi.fn();
/** M44/M46：压缩参数结果帧可变位（结果帧驱动回填 / 「已保存」对账）。 */
let mockCompaction: { reserveTokens: number; keepRecentTokens: number } | null = null;
/** M10 批②：config 族 connection.error 订阅听众（三卡 useConfigField 各挂一
 *  个；feed 全量回放——单飞门控由各卡 pending 自行判）。 */
let configListeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { agentState: "idle", instances: [] },
      topology: { modelConfig: { compaction: mockCompaction, scheduling: null, port: null, sandbox: mockSandbox }, list: [] },
      requestCompactionConfig,
      setCompactionConfig,
      requestSchedulingConfig,
      setSchedulingConfig,
      requestPortConfig,
      requestSandboxConfig,
      setSandboxConfig,
      setPortConfig,
      subscribeConfigFrames: (listener: (e: EventEnvelope) => void) => {
        configListeners.push(listener);
        return () => {
          configListeners = configListeners.filter((l) => l !== listener);
        };
      },
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
  mockSandbox = null;
  configListeners = [];
  vi.clearAllMocks();
});

/** config 族错误回执注入（connection.error——daemon commandError 无结果帧路径）。 */
function feedConnError(message: string) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "notification",
    type: "connection.error",
    ts: 1,
    payload: { code: "command.invalid_payload", message },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of configListeners) l(frame);
  });
}

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

describe("M10 批②：config 族在途错误经 connection.error 收口（不假「已保存」）", () => {
  it("保存在途收 connection.error → 清 pending + 行内错误交代；后续读帧不被误当保存回执", () => {
    mockCompaction = { reserveTokens: 96000, keepRecentTokens: 32000 };
    const view = ui();
    const reserve = document.querySelector<HTMLInputElement>("[data-compaction-reserve]")!;
    fireEvent.change(reserve, { target: { value: "120000" } });
    fireEvent.click(document.querySelector("[data-compaction-save]")!);
    expect(setCompactionConfig).toHaveBeenCalledWith(120000, 32000);
    // daemon 失败回执（config.set_compaction 无结果帧路径）→ 行内错误 + 无「已保存」
    feedConnError("config.set_compaction: 参数越界（命令 config.set_compaction）");
    expect(document.querySelector("[data-compaction-save-error]")).not.toBeNull();
    expect(document.querySelector("[data-compaction-save-error]")!.textContent).toContain("参数越界");
    expect(document.querySelector("[data-compaction-saved]")).toBeNull();
    // pending 已清：后续 config.get 结果帧（拉取回值）不被误当保存回执——
    // 无「已保存」假反馈；用户未保存编辑不被读帧覆盖（M46 门控仍在）
    mockCompaction = { reserveTokens: 96000, keepRecentTokens: 32000 };
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <GeneralSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(document.querySelector("[data-compaction-saved]")).toBeNull();
    // 用户未保存编辑不被读帧覆盖（M46 门控仍在）
    expect(document.querySelector<HTMLInputElement>("[data-compaction-reserve]")!.value).toBe("120000");
  });

  it("单飞门控：无在途时 connection.error 不消费（无错误面、无状态扰动）", () => {
    mockCompaction = { reserveTokens: 96000, keepRecentTokens: 32000 };
    ui();
    feedConnError("task.list: job 不存在（命令 task.list）");
    expect(document.querySelector("[data-compaction-save-error]")).toBeNull();
    expect(document.querySelector("[data-sched-save-error]")).toBeNull();
    expect(document.querySelector("[data-port-save-error]")).toBeNull();
  });

  it("错误交代后再输入即清（可修正重试）；再保存成功结果帧正常落「已保存」", () => {
    mockCompaction = { reserveTokens: 96000, keepRecentTokens: 32000 };
    const view = ui();
    const reserve = document.querySelector<HTMLInputElement>("[data-compaction-reserve]")!;
    fireEvent.change(reserve, { target: { value: "120000" } });
    fireEvent.click(document.querySelector("[data-compaction-save]")!);
    feedConnError("config.set_compaction: 参数越界（命令 config.set_compaction）");
    expect(document.querySelector("[data-compaction-save-error]")).not.toBeNull();
    // 再输入 → 错误交代清
    fireEvent.change(reserve, { target: { value: "110000" } });
    expect(document.querySelector("[data-compaction-save-error]")).toBeNull();
    // 再保存 → 结果帧到达 → 「已保存」
    fireEvent.click(document.querySelector("[data-compaction-save]")!);
    expect(setCompactionConfig).toHaveBeenLastCalledWith(110000, 32000);
    mockCompaction = { reserveTokens: 110000, keepRecentTokens: 32000 };
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <GeneralSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(document.querySelector("[data-compaction-saved]")!.textContent).toContain("已保存");
  });
});


describe("沙箱开关卡（沙箱开关批）", () => {
  it("进入分区拉取现值：requestSandboxConfig 在场调用", () => {
    ui();
    expect(requestSandboxConfig).toHaveBeenCalled();
  });

  it("开关双按钮组在场：开启/关闭两态（未请求态均不激活）", () => {
    const { container } = ui();
    const group = container.querySelector<HTMLElement>("[data-sandbox-switch]");
    expect(group).not.toBeNull();
    const on = container.querySelector<HTMLElement>('[data-sandbox-option="on"]');
    const off = container.querySelector<HTMLElement>('[data-sandbox-option="off"]');
    expect(on?.getAttribute("aria-pressed")).toBe("false");
    expect(off?.getAttribute("aria-pressed")).toBe("false");
  });

  it("点击开启 → setSandboxConfig(true)；回执驱动状态回填（aria-pressed 翻转）", () => {
    const view = ui();
    const container = view.container;
    const on = container.querySelector<HTMLElement>('[data-sandbox-option="on"]')!;
    fireEvent.click(on);
    expect(setSandboxConfig).toHaveBeenCalledWith(true);
    // 结果帧驱动回填（无乐观更新——mock 态变更 + rerender 模拟回执落态）
    mockSandbox = { enabled: true };
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <GeneralSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLElement>('[data-sandbox-option="off"]')?.getAttribute("aria-pressed")).toBe("false");
  });
});
