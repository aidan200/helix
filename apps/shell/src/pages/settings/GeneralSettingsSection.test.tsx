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
/** 动态主题批：config.topic 族命令面 mock（结果帧驱动，与沙箱同构）。 */
const requestTopicConfig = vi.fn();
const setTopicConfig = vi.fn(() => true);
let mockTopic: { enabled: boolean; model: string | null; classifyEndpointId: string | null; judgeEndpoints: { id: string; name: string }[] } | null = null;
/** 动态主题批：模型目录拉取 mock（主题模型下拉数据源）。 */
const requestModelConfig = vi.fn();
/** auth.list 拉取 mock（主题模型下拉可用性过滤——管家模型选择同款）。 */
const requestAuthList = vi.fn();
/** 主题模型下拉可用性过滤数据源可变位（catalog + provider 配置态）。 */
let mockCatalog: { models: { id: string; providerId: string }[] } | null = null;
let mockAuth: Record<string, { configured: boolean }> = {};
/** 沙箱开关状态（结果帧驱动回填用可变位）。 */
let mockSandbox: { enabled: boolean; extraRoots: string[] } | null = null;
/** stale-indicator 批：daemonFreshness 可变位（welcome 承接面——设置页人话时间数据源）。 */
let mockDaemonFreshness: { startedAt: number; stale: boolean } | null = null;
const setPortConfig = vi.fn();
/** M44/M46：压缩参数结果帧可变位（结果帧驱动回填 / 「已保存」对账）。 */
let mockCompaction: { reserveTokens: number; keepRecentTokens: number } | null = null;
/** M10 批②：config 族 connection.error 订阅听众（三卡 useConfigField 各挂一
 *  个；feed 全量回放——单飞门控由各卡 pending 自行判）。 */
let configListeners: ((e: EventEnvelope) => void)[] = [];
/** 管家配置并轨批：steward 命令面 mock（进入拉取 + 写面记录 + 回执听众）。 */
const sendStewardGetConfig = vi.fn(() => true);
const sendStewardSetConfig = vi.fn((_patch: { enabled?: boolean; model?: string }) => true);
let stewardListeners: ((e: EventEnvelope) => void)[] = [];
/** 管家记忆 B2：embedding 配置域命令/订阅面 mock。 */
const sendEmbeddingList = vi.fn(() => true);
let embeddingListeners: ((e: EventEnvelope) => void)[] = [];
/** B2 双入口回调 mock（管理记忆链接 / 引导链接）。 */
const onOpenMemory = vi.fn();
const onOpenModelsEmbeddingTab = vi.fn();

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { agentState: "idle", instances: [], daemonFreshness: mockDaemonFreshness },
      topology: { modelConfig: { compaction: mockCompaction, scheduling: null, port: null, sandbox: mockSandbox, topic: mockTopic, catalog: mockCatalog, auth: mockAuth, authLoaded: true }, list: [] },
      requestCompactionConfig,
      setCompactionConfig,
      requestSchedulingConfig,
      setSchedulingConfig,
      requestPortConfig,
      requestSandboxConfig,
      setSandboxConfig,
      requestTopicConfig,
      setTopicConfig,
      requestModelConfig,
      requestAuthList,
      setPortConfig,
      subscribeConfigFrames: (listener: (e: EventEnvelope) => void) => {
        configListeners.push(listener);
        return () => {
          configListeners = configListeners.filter((l) => l !== listener);
        };
      },
      sendStewardGetConfig,
      sendStewardSetConfig,
      subscribeStewardFrames: (listener: (e: EventEnvelope) => void) => {
        stewardListeners.push(listener);
        return () => {
          stewardListeners = stewardListeners.filter((l) => l !== listener);
        };
      },
      sendEmbeddingList,
      subscribeEmbeddingFrames: (listener: (e: EventEnvelope) => void) => {
        embeddingListeners.push(listener);
        return () => {
          embeddingListeners = embeddingListeners.filter((l) => l !== listener);
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
  mockDaemonFreshness = null;
  configListeners = [];
  stewardListeners = [];
  embeddingListeners = [];
  localStorage.removeItem("helix.steward.speakReply");
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
        <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
      </ToastProvider>
    </I18nProvider>,
  );
}

/** embedding.list.result 回执注入（管家记忆 B2：下拉数据源）。 */
function feedEmbeddingList(endpoints: { id: string; name: string; model: string; hasApiKey?: boolean; kind?: "embedding" | "classifier" }[]) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "embedding",
    type: "embedding.list.result",
    ts: 1,
    payload: { endpoints },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of embeddingListeners) l(frame);
  });
}

/** 管家 config.result 回执注入（steward 频道点对点帧；管家记忆 B1：
 *  memory 现态可选携带——缺省 = 未装配降级缺省）。 */
function feedStewardConfig(
  enabled: boolean,
  memory?: {
    enabled: boolean;
    available: boolean;
    endpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
    entryCount: number;
    dim: number | null;
  },
) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "steward",
    type: "steward.config.result",
    ts: 1,
    payload: {
      enabled,
      model: "deepseek/deepseek-v4-flash",
      memory: memory ?? { enabled: false, available: false, endpoint: null, entryCount: 0, dim: null },
    },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of stewardListeners) l(frame);
  });
}

/** connection.error 注入（config 频道——命令尾缀归因面）。 */
function feedConnectionError(message: string) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    type: "connection.error",
    ts: 1,
    payload: { code: "command.invalid_payload", message },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of configListeners) l(frame);
  });
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

  it("code-review 低危：校验失败行内提示（空串/非整数/越界不再静默 return），输入变更即清", () => {
    ui();
    // 压缩卡：空串 → 行内提示
    const { reserve, keep, save } = inputs();
    fireEvent.change(reserve, { target: { value: "" } });
    fireEvent.click(save);
    expect(document.querySelector("[data-compaction-invalid]")!.textContent).toContain("非负整数");
    expect(setCompactionConfig).not.toHaveBeenCalled();
    // 输入变更 → 提示清（重新校验窗口交给下次保存）
    fireEvent.change(reserve, { target: { value: "96000" } });
    expect(document.querySelector("[data-compaction-invalid]")).toBeNull();
    // 非整数（小数）同样提示
    fireEvent.change(keep, { target: { value: "1.5" } });
    fireEvent.click(save);
    expect(document.querySelector("[data-compaction-invalid]")!.textContent).toContain("非负整数");

    // 调度卡：maxConcurrent=0 越下界 → 行内提示（需 ≥1）
    fireEvent.change(document.querySelector("[data-sched-max-concurrent]")!, { target: { value: "0" } });
    fireEvent.click(document.querySelector("[data-sched-save]")!);
    expect(document.querySelector("[data-sched-invalid]")!.textContent).toContain("≥1");
    expect(setSchedulingConfig).not.toHaveBeenCalled();

    // 端口卡：越上界（65536）→ 行内提示
    fireEvent.change(document.querySelector("[data-ws-port]")!, { target: { value: "65536" } });
    fireEvent.click(document.querySelector("[data-port-save]")!);
    expect(document.querySelector("[data-port-invalid]")!.textContent).toContain("0-65535");
    expect(setPortConfig).not.toHaveBeenCalled();
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
          <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
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
          <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
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
          <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
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
          <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
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

  it("点击开启 → setSandboxConfig({enabled:true})；回执驱动状态回填（aria-pressed 翻转）", () => {
    const view = ui();
    const container = view.container;
    const on = container.querySelector<HTMLElement>('[data-sandbox-option="on"]')!;
    fireEvent.click(on);
    expect(setSandboxConfig).toHaveBeenCalledWith({ enabled: true });
    // 结果帧驱动回填（无乐观更新——mock 态变更 + rerender 模拟回执落态）
    mockSandbox = { enabled: true, extraRoots: [] };
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLElement>('[data-sandbox-option="off"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("extraRoots：编辑 → 保存发部分更新 {extraRoots}；非绝对路径行 → 行内拒绝不发出", () => {
    mockSandbox = { enabled: true, extraRoots: ["/Users/x/.cache/uv"] };
    const { container } = ui();
    const ta = container.querySelector<HTMLTextAreaElement>("[data-sandbox-extra-roots]")!;
    // 未编辑态展示现值
    expect(ta.value).toBe("/Users/x/.cache/uv");
    const saveBtn = container.querySelector<HTMLButtonElement>("[data-sandbox-extra-roots-save]")!;
    expect(saveBtn.disabled).toBe(true); // 无编辑不可保存
    // 非绝对路径行 → 拒绝不发出
    fireEvent.change(ta, { target: { value: "/ok/path\nrelative/bad" } });
    fireEvent.click(saveBtn);
    expect(setSandboxConfig).not.toHaveBeenCalled();
    expect(container.querySelector("[data-sandbox-extra-roots-invalid]")).not.toBeNull();
    // 修正后保存 → 部分更新只携带 extraRoots（trim + 空行过滤）
    fireEvent.change(ta, { target: { value: " /Users/x/.cache/uv \n\n/opt/tools" } });
    fireEvent.click(saveBtn);
    expect(setSandboxConfig).toHaveBeenCalledWith({ extraRoots: ["/Users/x/.cache/uv", "/opt/tools"] });
  });
});

describe("code-review H8：send false（未发出）→ 不置在途 + 行内交代（不永锁、不假已保存）", () => {
  it("压缩卡：setCompactionConfig 返回 false → saveError 行内 + 无「已保存」+ 可立即重提", () => {
    mockCompaction = { reserveTokens: 96000, keepRecentTokens: 32000 };
    setCompactionConfig.mockReturnValue(false); // 断线窗口：命令未发出
    ui();
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-compaction-reserve]")!, {
      target: { value: "120000" },
    });
    fireEvent.click(document.querySelector("[data-compaction-save]")!);
    expect(setCompactionConfig).toHaveBeenCalledWith(120000, 32000);
    // 未发出 → 行内交代（非静默）+ 不假「已保存」
    expect(document.querySelector("[data-compaction-save-error]")!.textContent).toContain("未连接");
    expect(document.querySelector("[data-compaction-saved]")).toBeNull();
    // 不永锁：未置在途 → 修正后可立即重提（无 pending 残留误吞后续回执）
    setCompactionConfig.mockReturnValue(true);
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-compaction-reserve]")!, {
      target: { value: "96000" },
    });
    fireEvent.click(document.querySelector("[data-compaction-save]")!);
    expect(setCompactionConfig).toHaveBeenCalledTimes(2);
  });
});

describe("code-review 族A：沙箱开关 daemon 拒绝交代（connection.error 尾缀归因）", () => {
  it("connection.error（尾缀 config.set_sandbox）→ 行内错误交代（现行红：不订阅零反馈）", () => {
    setSandboxConfig.mockReturnValueOnce(true); // 已发出
    const { container } = ui();
    fireEvent.click(container.querySelector<HTMLElement>('[data-sandbox-option="on"]')!);
    feedConnError("沙箱配置非法（命令 config.set_sandbox）");
    expect(container.querySelector("[data-sandbox-save-error]")!.textContent).toContain("沙箱配置非法");
  });

  it("尾缀非 sandbox 的 connection.error → 不误挂 sandbox 错误（其他卡写面不受影响）", () => {
    setSandboxConfig.mockReturnValueOnce(true);
    const { container } = ui();
    fireEvent.click(container.querySelector<HTMLElement>('[data-sandbox-option="on"]')!);
    feedConnError("端口配置非法（命令 config.set_port）");
    expect(container.querySelector("[data-sandbox-save-error]")).toBeNull();
  });
});

describe("管家配置并轨批：管家组（启用 + 语音播报从属项）", () => {
  it("进入分区 → sendStewardGetConfig 拉取；config.result(enabled=false) → 勾选关 + 语音播报不渲染", () => {
    const { container } = ui();
    expect(sendStewardGetConfig).toHaveBeenCalledTimes(1);
    feedStewardConfig(false);
    const toggle = container.querySelector<HTMLInputElement>("[data-steward-enabled] input")!;
    expect(toggle.checked).toBe(false);
    expect(container.querySelector("[data-steward-speak]")).toBeNull();
  });

  it("启用切换 → sendStewardSetConfig({enabled}) 不乐观翻转；config.result 回执回填", () => {
    const { container } = ui();
    feedStewardConfig(false);
    const toggle = container.querySelector<HTMLInputElement>("[data-steward-enabled] input")!;
    fireEvent.click(toggle);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ enabled: true });
    expect(toggle.checked).toBe(false); // 回执前不翻转（daemon 权威）
    feedStewardConfig(true);
    expect(toggle.checked).toBe(true);
  });

  it("语音播报从属项：仅启用后显示（层级缩进 fld-sub）；切换写本地偏好零 daemon 命令", () => {
    const { container } = ui();
    feedStewardConfig(true);
    const sub = container.querySelector("[data-steward-speak]")!;
    expect(sub).not.toBeNull();
    expect(sub.className).toContain("fld-sub");
    const speak = sub.querySelector<HTMLInputElement>("[data-steward-speak-reply] input")!;
    expect(speak.checked).toBe(true); // 缺省开
    const callsBefore = sendStewardSetConfig.mock.calls.length;
    fireEvent.click(speak);
    expect(speak.checked).toBe(false);
    expect(localStorage.getItem("helix.steward.speakReply")).toBe("0");
    expect(sendStewardSetConfig.mock.calls.length).toBe(callsBefore); // 本地偏好零 daemon 命令
  });

  it("send 失败（未连接）→ 行内错误交代，勾选不翻转", () => {
    sendStewardSetConfig.mockReturnValueOnce(false);
    const { container } = ui();
    feedStewardConfig(false);
    const toggle = container.querySelector<HTMLInputElement>("[data-steward-enabled] input")!;
    fireEvent.click(toggle);
    expect(container.querySelector("[data-steward-save-error]")!.textContent).toContain("未连接");
    expect(toggle.checked).toBe(false);
  });
});

describe("管家记忆 B2：记忆从属项（开关 + 端点引用下拉 + 管理链接）", () => {
  const MEMORY_ON = {
    enabled: true,
    available: true,
    endpoint: { id: "ep-1", name: "Ollama 本地", model: "bge-m3", hasApiKey: false },
    judgeEndpoint: { id: "ep-9", name: "Jev", model: "jev-latest", hasApiKey: true },
    entryCount: 7,
    dim: 1024,
  };

  it("管家未启用 → 记忆项不渲染；启用 → 记忆项出现（fld-sub 缩进）+ 条目计数行", () => {
    const { container } = ui();
    feedStewardConfig(false, MEMORY_ON);
    expect(container.querySelector("[data-steward-memory]")).toBeNull();
    feedStewardConfig(true, MEMORY_ON);
    const mem = container.querySelector("[data-steward-memory]")!;
    expect(mem).not.toBeNull();
    expect(mem.className).toContain("fld-sub");
    expect(mem.querySelector<HTMLInputElement>("[data-steward-memory-enabled] input")!.checked).toBe(true);
    expect(container.querySelector("[data-steward-memory-count]")!.textContent).toContain("7");
  });

  it("记忆开关切换 → sendStewardSetConfig({memory:{enabled}}) 不乐观翻转；回执回填", () => {
    const { container } = ui();
    feedStewardConfig(true, { ...MEMORY_ON, enabled: false, available: false });
    const toggle = container.querySelector<HTMLInputElement>("[data-steward-memory-enabled] input")!;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { enabled: true } });
    expect(toggle.checked).toBe(false); // 回执前不翻转（daemon 权威）
    feedStewardConfig(true, MEMORY_ON);
    expect(toggle.checked).toBe(true);
  });

  it("端点从属展开：仅记忆开启后渲染向量模型下拉（embedding.list 驱动，现值选中）", () => {
    const { container } = ui();
    feedStewardConfig(true, { ...MEMORY_ON, enabled: false, available: false });
    expect(container.querySelector("[data-steward-memory-endpoint]")).toBeNull();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList([
      { id: "ep-1", name: "Ollama 本地", model: "bge-m3" },
      { id: "ep-2", name: "OpenAI", model: "text-embedding-3-small", hasApiKey: true },
    ]);
    const select = container.querySelector<HTMLSelectElement>("[data-steward-memory-endpoint-select]")!;
    expect(select).not.toBeNull();
    expect(select.value).toBe("ep-1"); // 现引用端点选中
    expect(select.options[1]!.textContent).toBe("Ollama 本地 (bge-m3)");
    expect(select.options[2]!.textContent).toBe("OpenAI (text-embedding-3-small)");
  });

  it("向量模型选择：切换下拉 → sendStewardSetConfig({memory:{endpointId}}) 引用写面", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList([
      { id: "ep-1", name: "Ollama 本地", model: "bge-m3" },
      { id: "ep-2", name: "OpenAI", model: "text-embedding-3-small" },
    ]);
    const select = container.querySelector<HTMLSelectElement>("[data-steward-memory-endpoint-select]")!;
    fireEvent.change(select, { target: { value: "ep-2" } });
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { endpointId: "ep-2" } });
  });

  it("B4a 判官下拉：仅列 kind=classifier 端点（embedding 端点不出现）；现引用回填", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList([
      { id: "ep-1", name: "Ollama 本地", model: "bge-m3" },
      { id: "ep-9", name: "Jev", model: "jev-latest", kind: "classifier", hasApiKey: true },
      { id: "ep-10", name: "OpenAI 判官", model: "jev-latest", kind: "classifier", hasApiKey: true },
    ]);
    const select = container.querySelector<HTMLSelectElement>("[data-steward-memory-judge-select]")!;
    expect(select).not.toBeNull();
    expect(select.value).toBe("ep-9"); // 现引用判官回填
    expect(select.options).toHaveLength(3); // 占位 + 两个 classifier（ep-1 embedding 端点被过滤）
    expect(select.options[1]!.textContent).toBe("Jev (jev-latest)");
    expect(select.options[2]!.textContent).toBe("OpenAI 判官 (jev-latest)");
  });

  it("B4a 判官选择：切换下拉 → sendStewardSetConfig({memory:{judgeEndpointId}}) 引用写面", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList([
      { id: "ep-9", name: "Jev", model: "jev-latest", kind: "classifier", hasApiKey: true },
      { id: "ep-10", name: "OpenAI 判官", model: "jev-latest", kind: "classifier", hasApiKey: true },
    ]);
    const select = container.querySelector<HTMLSelectElement>("[data-steward-memory-judge-select]")!;
    fireEvent.change(select, { target: { value: "ep-10" } });
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { judgeEndpointId: "ep-10" } });
  });

  it("空端点列表：显示引导链接（跳模型页向量 tab）——B1 三字段形态退役", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList([]);
    expect(container.querySelector("[data-steward-memory-endpoint-select]")).toBeNull();
    const goConfig = container.querySelector<HTMLButtonElement>("[data-steward-memory-go-config]")!;
    expect(goConfig.textContent).toMatch(/去模型页|models page/);
    fireEvent.click(goConfig);
    expect(onOpenModelsEmbeddingTab).toHaveBeenCalledTimes(1);
  });

  it("管理记忆链接（入口②）：点击 → onOpenMemory（跳记忆独立页）", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList([]);
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-steward-memory-manage-link]")!);
    expect(onOpenMemory).toHaveBeenCalledTimes(1);
  });

  it("daemon 校验失败（connection.error 命令 steward.set_config 尾缀）→ 行内错误交代", () => {
    const { container } = ui();
    feedStewardConfig(true, { ...MEMORY_ON, enabled: false, available: false, endpoint: null });
    const toggle = container.querySelector<HTMLInputElement>("[data-steward-memory-enabled] input")!;
    fireEvent.click(toggle);
    feedConnectionError("嵌入端点不可达（命令 steward.set_config）");
    expect(container.querySelector("[data-steward-save-error]")!.textContent).toContain("不可达");
  });

  it("待命态：已开启但端点未配置 → 提示行（不阻开关，daemon 权威回 available）", () => {
    const { container } = ui();
    feedStewardConfig(true, { ...MEMORY_ON, available: false, endpoint: null, entryCount: 0 });
    expect(container.querySelector("[data-steward-memory-pending]")!.textContent).toContain("暂未生效");
    feedStewardConfig(true, MEMORY_ON);
    expect(container.querySelector("[data-steward-memory-pending]")).toBeNull();
  });

});

describe("stale-indicator 批：关于 daemon 卡（daemon 启动时间人话显示）", () => {
  it("daemonFreshness 在场 → daemon 启动时间人话显示（data-daemon-started-at）", () => {
    mockDaemonFreshness = { startedAt: 1_760_000_000_000, stale: true };
    const { container } = ui();
    const row = container.querySelector("[data-daemon-started-at]");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain(new Date(1_760_000_000_000).toLocaleString());
  });

  it("daemonFreshness 缺席（旧 daemon / 未握手）→ 兜底文案，不显示时间", () => {
    mockDaemonFreshness = null;
    const { container } = ui();
    const row = container.querySelector("[data-daemon-started-at]");
    expect(row).not.toBeNull();
    expect(row!.textContent).not.toContain("1975");
    expect(row!.textContent).toContain("未连接");
  });
});


describe("动态主题卡（动态主题批）", () => {
  it("进入分区拉取现值：requestTopicConfig 在场调用（模型目录 + auth 顺带拉取）", () => {
    ui();
    expect(requestTopicConfig).toHaveBeenCalled();
    expect(requestModelConfig).toHaveBeenCalled();
    expect(requestAuthList).toHaveBeenCalled();
  });

  it("开关双按钮组在场（未请求态均不激活）", () => {
    const { container } = ui();
    expect(container.querySelector("[data-topic-switch]")).not.toBeNull();
    expect(container.querySelector('[data-topic-option="on"]')).not.toBeNull();
    expect(container.querySelector('[data-topic-option="off"]')).not.toBeNull();
  });

  it("enabled=true 结果帧驱动：主题模型下拉 + 分类模型下拉恒显（judgeEndpoints 空 → 仅默认项 + 提示）", () => {
    mockTopic = { enabled: true, model: null, classifyEndpointId: null, judgeEndpoints: [] };
    try {
      const { container } = ui();
      expect(container.querySelector("[data-topic-model-select]")).not.toBeNull();
      const select = container.querySelector<HTMLSelectElement>("[data-topic-endpoint-select]");
      expect(select).not.toBeNull();
      expect(select!.value).toBe(""); // 默认项：主题生成模型兼任判断
      expect(select!.options.length).toBe(1);
      expect(container.querySelector("[data-topic-classify-empty]")).not.toBeNull();
    } finally {
      mockTopic = null;
    }
  });

  it("judgeEndpoints 非空：分类模型选项在场（判定恒开，选中态回显）", () => {
    mockTopic = {
      enabled: true,
      model: "deepseek/deepseek-v4-flash",
      classifyEndpointId: "jev-1",
      judgeEndpoints: [{ id: "jev-1", name: "Jev 分类模型" }],
    };
    try {
      const { container } = ui();
      const select = container.querySelector<HTMLSelectElement>("[data-topic-endpoint-select]");
      expect(select).not.toBeNull();
      expect(select!.value).toBe("jev-1");
      expect(select!.options.length).toBe(2); // 默认项 + 分类模型
      expect(container.querySelector("[data-topic-classify-empty]")).toBeNull();
    } finally {
      mockTopic = null;
    }
  });

  it("主题模型下拉只列已配置 provider 的模型（管家选择逻辑同款可用性过滤）", () => {
    mockTopic = { enabled: true, model: null, classifyEndpointId: null, judgeEndpoints: [] };
    mockCatalog = {
      models: [
        { id: "openai/gpt-x", providerId: "openai" },
        { id: "local/llm-y", providerId: "local" },
      ],
    };
    mockAuth = { openai: { configured: true } };
    try {
      const { container } = ui();
      const select = container.querySelector<HTMLSelectElement>("[data-topic-model-select]")!;
      const optionIds = [...select.options].map((o) => o.value);
      expect(optionIds).toContain("openai/gpt-x");
      expect(optionIds).not.toContain("local/llm-y");
    } finally {
      mockTopic = null;
      mockCatalog = null;
      mockAuth = {};
    }
  });

  it("点击开启 → setTopicConfig({enabled:true}) 部分更新（无乐观更新，结果帧驱动回填）", () => {
    const { container } = ui();
    container.querySelector<HTMLElement>('[data-topic-option="on"]')!.click();
    expect(setTopicConfig).toHaveBeenCalledWith({ enabled: true });
  });
});
