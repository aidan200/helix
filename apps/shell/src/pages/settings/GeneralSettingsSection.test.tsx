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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
/** 总结器独立化批①：config.summary 族命令面 mock（结果帧驱动，与沙箱同构）。 */
const requestSummaryConfig = vi.fn();
const setSummaryConfig = vi.fn(() => true);
type SummaryStateMock = { enabled: boolean; everyTurns: number; model: string | null; task: { enabled: boolean; model: string | null } };
let mockSummary: SummaryStateMock | null = null;
/** 批2 知识库组：config.kg 族命令面 mock（查重阈值——回执对账驱动）。 */
const requestKgConfig = vi.fn();
const setKgConfig = vi.fn(() => true);
let mockKg: { similarityWarn: number; similarityDup: number } | null = null;
/** 总结器批①：模型目录拉取 mock（总结模型下拉数据源）。 */
const requestModelConfig = vi.fn();
/** auth.list 拉取 mock（主题模型下拉可用性过滤——管家模型选择同款）。 */
const requestAuthList = vi.fn();
/** 主题模型下拉可用性过滤数据源可变位（catalog + provider 配置态）。 */
let mockCatalog: { models: { id: string; providerId: string }[] } | null = null;
let mockAuth: Record<string, { configured: boolean }> = {};
/** 沙箱开关状态（结果帧驱动回填用可变位）。 */
let mockSandbox: { enabled: boolean; extraRoots: string[]; autoApprove: boolean } | null = null;
/** 网络代理批：config.proxy 族命令面 mock（结果帧驱动，与沙箱同构）。 */
const requestProxyConfig = vi.fn();
const setProxyConfig = vi.fn(() => true);
let mockProxy: { enabled: boolean; url: string } | null = null;
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
const sendStewardSetConfig = vi.fn(
  (
    _patch: {
      enabled?: boolean;
      model?: string;
      memory?: Record<string, unknown>;
      triage?: Record<string, unknown>;
    },
  ) => true,
);
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
      state: { conn: "connected", agentState: "idle", instances: [], daemonFreshness: mockDaemonFreshness },
      topology: { modelConfig: { compaction: mockCompaction, scheduling: null, port: null, sandbox: mockSandbox, summary: mockSummary, kg: mockKg, proxy: mockProxy, proxyInflight: false, proxySaved: false, catalog: mockCatalog, auth: mockAuth, authLoaded: true }, list: [] },
      requestCompactionConfig,
      setCompactionConfig,
      requestSchedulingConfig,
      setSchedulingConfig,
      requestPortConfig,
      requestSandboxConfig,
      setSandboxConfig,
      requestProxyConfig,
      setProxyConfig,
      requestSummaryConfig,
      setSummaryConfig,
      requestKgConfig,
      setKgConfig,
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
  mockProxy = null;
  mockKg = null;
  mockDaemonFreshness = null;
  configListeners = [];
  stewardListeners = [];
  embeddingListeners = [];
  localStorage.removeItem("helix.steward.speakReply");
  localStorage.removeItem("helix.steward.wakeHotkey");
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

/** embedding.list.result 回执注入（管家记忆 B2：下拉数据源；批1 +
 *  defaultEndpointId——记忆开关准入判据）。 */
function feedEmbeddingList(
  endpoints: { id: string; name: string; model: string; hasApiKey?: boolean; kind?: "embedding" | "classifier" }[],
  defaultEndpointId: string | null = null,
) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "embedding",
    type: "embedding.list.result",
    ts: 1,
    payload: { endpoints, defaultEndpointId },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of embeddingListeners) l(frame);
  });
}

/** 管家 config.result 回执注入（steward 频道点对点帧；管家记忆 B1：
 *  memory 现态可选携带——缺省 = 未装配降级缺省；批B additive
 *  recallTopK/recallPool 生效值回显；分诊判官批 triage 组可选携带）。 */
function feedStewardConfig(
  enabled: boolean,
  memory?: {
    enabled: boolean;
    available: boolean;
    judgeEndpoint?: { id: string; name: string; model: string; hasApiKey: boolean } | null;
    entryCount: number;
    dim: number | null;
    recallTopK?: number;
    recallPool?: number;
    recallMinScore?: number;
  },
  triage?: { judgeEnabled: boolean; judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null },
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
      ...(triage !== undefined ? { triage } : {}),
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

  it("族B 尾缀归因：本卡在途时他命令 connection.error 不误收口（在途不丢、不误显示他卡错误，本卡结果帧仍落「已保存」）", () => {
    mockCompaction = { reserveTokens: 96000, keepRecentTokens: 32000 };
    const view = ui();
    const reserve = document.querySelector<HTMLInputElement>("[data-compaction-reserve]")!;
    fireEvent.change(reserve, { target: { value: "120000" } });
    fireEvent.click(document.querySelector("[data-compaction-save]")!);
    // 本卡在途时他写面命令被拒（config.set_sandbox 属另一张卡/页面外命令族）
    feedConnError("沙箱配置非法（命令 config.set_sandbox）");
    // 不误清本卡在途、不误显示他卡错误
    expect(document.querySelector("[data-compaction-save-error]")).toBeNull();
    // 本卡真实结果帧随后到达 → 「已保存」（在途未被误摘，dirty 门控不吞回执）
    mockCompaction = { reserveTokens: 120000, keepRecentTokens: 32000 };
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(document.querySelector("[data-compaction-saved]")!.textContent).toContain("已保存");
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
    mockSandbox = { enabled: true, extraRoots: [], autoApprove: false };
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

  it("提权自动通过双按钮：点击开启发部分更新 {autoApprove:true}；回执驱动 aria-pressed 翻转（无乐观更新）", () => {
    mockSandbox = { enabled: true, extraRoots: [], autoApprove: false };
    const view = ui();
    const container = view.container;
    const on = container.querySelector<HTMLElement>('[data-sandbox-auto-approve-option="on"]')!;
    const off = container.querySelector<HTMLElement>('[data-sandbox-auto-approve-option="off"]')!;
    expect(on.getAttribute("aria-pressed")).toBe("false");
    expect(off.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(on);
    expect(setSandboxConfig).toHaveBeenCalledWith({ autoApprove: true });
    // 结果帧驱动回填（mock 态变更 + rerender 模拟回执落态）
    mockSandbox = { enabled: true, extraRoots: [], autoApprove: true };
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(off.getAttribute("aria-pressed")).toBe("false");
    // 关闭回写同样只携带 autoApprove（部分更新）
    fireEvent.click(off);
    expect(setSandboxConfig).toHaveBeenCalledWith({ autoApprove: false });
  });

  it("extraRoots：编辑 → 保存发部分更新 {extraRoots}；非绝对路径行 → 行内拒绝不发出", () => {
    mockSandbox = { enabled: true, extraRoots: ["/Users/x/.cache/uv"], autoApprove: false };
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

describe("总结组（会话总结器独立化批①：三产物开关 + 轮次 + 总结模型 + 任务总结）", () => {
  it("进入分区拉取现值：requestSummaryConfig 在场调用（模型目录 + auth 顺带拉取）", () => {
    ui();
    expect(requestSummaryConfig).toHaveBeenCalled();
    expect(requestModelConfig).toHaveBeenCalled();
    expect(requestAuthList).toHaveBeenCalled();
  });

  it("总结开关双按钮在场（未请求态均不激活）；点击开启 → setSummaryConfig({enabled:true}) 不乐观翻转", () => {
    const { container } = ui();
    expect(container.querySelector("[data-summary-switch]")).not.toBeNull();
    expect(container.querySelector('[data-summary-option="on"]')!.getAttribute("aria-pressed")).toBe("false");
    container.querySelector<HTMLElement>('[data-summary-option="on"]')!.click();
    expect(setSummaryConfig).toHaveBeenCalledWith({ enabled: true });
    expect(container.querySelector('[data-summary-option="on"]')!.getAttribute("aria-pressed")).toBe("false"); // 回执前不翻转
  });

  it("enabled=true → 轮次输入 + 总结模型下拉渲染；false → 不渲染从属两行", () => {
    mockSummary = { enabled: false, everyTurns: 3, model: null, task: { enabled: false, model: null } };
    try {
      const { container } = ui();
      expect(container.querySelector("[data-summary-turns]")).toBeNull();
      expect(container.querySelector("[data-summary-model]")).toBeNull();
    } finally {
      mockSummary = null;
    }
    mockSummary = { enabled: true, everyTurns: 3, model: null, task: { enabled: false, model: null } };
    try {
      const { container } = ui();
      expect(container.querySelector("[data-summary-turns]")).not.toBeNull();
      expect(container.querySelector("[data-summary-model]")).not.toBeNull();
    } finally {
      mockSummary = null;
    }
  });

  it("总结模型下拉：现值兑底选中 + 未配置 provider 过滤；选择写 {model}；空选项 = 清空（null）", () => {
    mockSummary = { enabled: true, everyTurns: 3, model: "deepseek/deepseek-v4-flash", task: { enabled: false, model: null } };
    mockCatalog = {
      models: [
        { id: "openai/gpt-x", providerId: "openai" },
        { id: "local/llm-y", providerId: "local" },
      ],
    };
    mockAuth = { openai: { configured: true } };
    try {
      const { container } = ui();
      const select = container.querySelector<HTMLSelectElement>("[data-summary-model-select]")!;
      expect(select.value).toBe("deepseek/deepseek-v4-flash"); // 现值兑底（不在目录仍保留）
      const optionIds = [...select.options].map((o) => o.value);
      expect(optionIds).toContain("openai/gpt-x");
      expect(optionIds).not.toContain("local/llm-y"); // 未配置 provider 过滤
      fireEvent.change(select, { target: { value: "openai/gpt-x" } });
      expect(setSummaryConfig).toHaveBeenCalledWith({ model: "openai/gpt-x" });
      fireEvent.change(select, { target: { value: "" } });
      expect(setSummaryConfig).toHaveBeenCalledWith({ model: null }); // 空选项 = 清空槽位
    } finally {
      mockSummary = null;
      mockCatalog = null;
      mockAuth = {};
    }
  });

  it("轮次输入：现值回填；改值失焦/回车提交 {everyTurns}；非法值（0/99）回落最近已提交值零命令", () => {
    mockSummary = { enabled: true, everyTurns: 3, model: null, task: { enabled: false, model: null } };
    try {
      const { container } = ui();
      const input = container.querySelector<HTMLInputElement>("[data-summary-turns-input]")!;
      expect(input.value).toBe("3");
      fireEvent.change(input, { target: { value: "5" } });
      fireEvent.blur(input);
      expect(setSummaryConfig).toHaveBeenCalledWith({ everyTurns: 5 });
      setSummaryConfig.mockClear();
      fireEvent.change(input, { target: { value: "0" } });
      fireEvent.blur(input);
      expect(setSummaryConfig).not.toHaveBeenCalled();
      expect(input.value).toBe("5"); // 非法回落最近已提交值
      fireEvent.change(input, { target: { value: "99" } });
      fireEvent.blur(input);
      expect(setSummaryConfig).not.toHaveBeenCalled();
      expect(input.value).toBe("5");
      fireEvent.change(input, { target: { value: "7" } });
      fireEvent.keyDown(input, { key: "Enter" }); // 回车也提交
      expect(setSummaryConfig).toHaveBeenCalledWith({ everyTurns: 7 });
    } finally {
      mockSummary = null;
    }
  });

  it("任务总结两项：开关写 {task:{enabled}} 不乐观；开启后模型下拉渲染，选择写 {task:{model}}", () => {
    mockSummary = { enabled: false, everyTurns: 3, model: null, task: { enabled: false, model: null } };
    mockCatalog = { models: [{ id: "openai/gpt-x", providerId: "openai" }] };
    mockAuth = { openai: { configured: true } };
    try {
      const { container } = ui();
      const toggle = container.querySelector<HTMLInputElement>("[data-summary-task-enabled] input")!;
      expect(toggle.checked).toBe(false);
      fireEvent.click(toggle);
      expect(setSummaryConfig).toHaveBeenCalledWith({ task: { enabled: true } });
      expect(toggle.checked).toBe(false); // 回执前不翻转（daemon 权威）
      expect(container.querySelector("[data-summary-task-model]")).toBeNull(); // 未开不展开下拉
    } finally {
      mockSummary = null;
    }
    mockSummary = { enabled: false, everyTurns: 3, model: null, task: { enabled: true, model: "openai/gpt-x" } };
    try {
      const { container } = ui();
      const select = container.querySelector<HTMLSelectElement>("[data-summary-task-model-select]")!;
      expect(select.value).toBe("openai/gpt-x");
      fireEvent.change(select, { target: { value: "" } });
      expect(setSummaryConfig).toHaveBeenCalledWith({ task: { model: null } });
    } finally {
      mockSummary = null;
      mockCatalog = null;
      mockAuth = {};
    }
  });

  it("send 失败（setSummaryConfig false）→ 行内错误交代（data-summary-save-error）", () => {
    setSummaryConfig.mockReturnValueOnce(false);
    const { container } = ui();
    fireEvent.click(container.querySelector<HTMLElement>('[data-summary-option="on"]')!);
    expect(container.querySelector("[data-summary-save-error]")).not.toBeNull();
  });

  // code-review task-91e2e2f9 B22 #1：send 失败不前移 committed（重试通道不被吞）
  it("everyTurns 提交 send 失败不前移 committed：再失焦仍重发（草稿看似已存实则从未落盘 → 重试通道修复）", () => {
    mockSummary = { enabled: true, everyTurns: 3, model: null, task: { enabled: false, model: null } };
    try {
      const { container } = ui();
      const input = container.querySelector<HTMLInputElement>("[data-summary-turns-input]")!;
      setSummaryConfig.mockReturnValueOnce(false); // 断线窗口：命令未发出
      fireEvent.change(input, { target: { value: "5" } });
      fireEvent.blur(input);
      expect(setSummaryConfig).toHaveBeenCalledWith({ everyTurns: 5 });
      expect(container.querySelector("[data-summary-save-error]")).not.toBeNull(); // 行内错误（既有行为）
      setSummaryConfig.mockClear();
      fireEvent.blur(input); // 草稿仍 5：再失焦 = 重试
      // 旧代码：committed 已乐观前移至 5 → 判「未变零命令」不再发（重试被吞）
      expect(setSummaryConfig).toHaveBeenCalledWith({ everyTurns: 5 });
    } finally {
      mockSummary = null;
    }
  });
});

describe("管家组瘦身（设置页长期记忆组批：记忆区迁出管家组）", () => {
  const MEMORY_ON = {
    enabled: true,
    available: true,
    judgeEndpoint: { id: "ep-9", name: "Jev", model: "jev-latest", hasApiKey: true },
    entryCount: 7,
    dim: 1024,
    recallTopK: 8,
    recallPool: 32,
    recallMinScore: 0.5,
  };

  it("管家卡不再携带记忆区：启用前后 data-steward-memory* 全不在场（配置归通用分区「长期记忆」组）", () => {
    const { container } = ui();
    feedStewardConfig(false, MEMORY_ON);
    expect(container.querySelector("[data-steward-memory]")).toBeNull();
    expect(container.querySelector("[data-steward-memory-endpoint]")).toBeNull();
    expect(container.querySelector("[data-steward-memory-judge]")).toBeNull();
    expect(container.querySelector("[data-steward-memory-manage]")).toBeNull();
    feedStewardConfig(true, MEMORY_ON);
    expect(container.querySelector("[data-steward-memory]")).toBeNull(); // 启用后也不回（已迁出）
    expect(container.querySelector("[data-steward-memory-endpoint]")).toBeNull();
    expect(container.querySelector("[data-steward-memory-judge]")).toBeNull();
    expect(container.querySelector("[data-steward-memory-manage]")).toBeNull();
  });

  it("管家卡保留本体面：启用开关 + 语音播报从属项照旧", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    expect(container.querySelector("[data-steward-enabled]")).not.toBeNull();
    expect(container.querySelector("[data-steward-speak]")).not.toBeNull();
  });
});

describe("长期记忆组（设置页 memory.* 六键：开关 + 端点 + 判官 + 召回量两键 + 资格阈值）", () => {
  const MEMORY_ON = {
    enabled: true,
    available: true,
    judgeEndpoint: { id: "ep-9", name: "Jev", model: "jev-latest", hasApiKey: true },
    entryCount: 7,
    dim: 1024,
    recallTopK: 8,
    recallPool: 32,
    recallMinScore: 0.5,
  };

  it("组常驻设置页（不依赖管家启用）：组卡 + 开关双按钮在场；enabled=false 从属五项不渲染", () => {
    const { container } = ui();
    feedStewardConfig(false, { ...MEMORY_ON, enabled: false, available: false });
    const card = container.querySelector("[data-memory-card]")!;
    expect(card).not.toBeNull();
    expect(card.querySelector("[data-memory-switch]")).not.toBeNull();
    expect(card.querySelector('[data-memory-option="on"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(card.querySelector("[data-memory-endpoint]")).toBeNull();
    expect(card.querySelector("[data-memory-judge]")).toBeNull();
    expect(card.querySelector("[data-memory-topk]")).toBeNull();
    expect(card.querySelector("[data-memory-pool]")).toBeNull();
    expect(card.querySelector("[data-memory-score]")).toBeNull();
  });

  it("开关双按钮：点击 → sendStewardSetConfig({memory:{enabled}}) 不乐观翻转；回执回填", () => {
    const { container } = ui();
    feedEmbeddingList([{ id: "ep-1", name: "Ollama 本地", model: "bge-m3" }], "ep-1"); // 默认端点在场 → on 可点
    feedStewardConfig(true, { ...MEMORY_ON, enabled: false, available: false });
    const on = container.querySelector<HTMLElement>('[data-memory-option="on"]')!;
    on.click();
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { enabled: true } });
    expect(on.getAttribute("aria-pressed")).toBe("false"); // 回执前不翻转（daemon 权威）
    feedStewardConfig(true, MEMORY_ON);
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLElement>('[data-memory-option="off"]')!.getAttribute("aria-pressed")).toBe("false");
  });

  it("enabled=true → 从属四项展开：判官下拉 + 召回量两输入框 + 资格阈值输入框（fld-sub 缩进；批1 向量端点下拉已删）", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    for (const sel of ["[data-memory-judge]", "[data-memory-topk]", "[data-memory-pool]", "[data-memory-score]"]) {
      const el = container.querySelector(sel)!;
      expect(el).not.toBeNull();
      expect(el.className).toContain("fld-sub");
    }
  });

  it("向量端点下拉已删（批1 收编）：data-memory-endpoint 全不在场——向量端点恒用全局默认（向量 tab「设为默认」）", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList(
      [
        { id: "ep-1", name: "Ollama 本地", model: "bge-m3" },
        { id: "ep-2", name: "OpenAI", model: "text-embedding-3-small", hasApiKey: true },
        { id: "ep-9", name: "Jev", model: "jev-latest", kind: "classifier", hasApiKey: true },
      ],
      "ep-1",
    );
    expect(container.querySelector("[data-memory-endpoint]")).toBeNull();
    expect(container.querySelector("[data-memory-endpoint-select]")).toBeNull();
    // set_config memory 组不再发 endpointId（写面退役）
    expect(sendStewardSetConfig).not.toHaveBeenCalledWith({ memory: { endpointId: expect.anything() } });
  });

  it("无默认 embedding 端点 → 开关置灰 + 引导提示（记忆不可开启，批1 服务闸同判据）", () => {
    const { container } = ui();
    feedEmbeddingList([], null);
    feedStewardConfig(true, { ...MEMORY_ON, enabled: false, available: false });
    const on = container.querySelector<HTMLButtonElement>('[data-memory-option="on"]')!;
    expect(on.disabled).toBe(true);
    const hint = container.querySelector("[data-memory-no-default]")!;
    expect(hint.textContent).toMatch(/默认 embedding 端点|default embedding endpoint/);
  });

  it("判官端点下拉：仅 kind=classifier 端点可选（embedding 过滤），现引用回填；切换写 {memory:{judgeEndpointId}}", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList([
      { id: "ep-1", name: "Ollama 本地", model: "bge-m3" },
      { id: "ep-9", name: "Jev", model: "jev-latest", kind: "classifier", hasApiKey: true },
      { id: "ep-10", name: "OpenAI 判官", model: "jev-latest", kind: "classifier", hasApiKey: true },
    ]);
    const select = container.querySelector<HTMLSelectElement>("[data-memory-judge-select]")!;
    expect(select.value).toBe("ep-9"); // 现引用判官回填
    expect(select.options).toHaveLength(3); // 占位 + 两个 classifier（ep-1 embedding 被过滤）
    fireEvent.change(select, { target: { value: "ep-10" } });
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { judgeEndpointId: "ep-10" } });
  });

  it("判官下拉现值兑底：引用态端点不在已配分类清单时仍显示真值（不静默落 placeholder）", () => {
    const { container } = ui();
    // 引用态指向 ep-88（他处已删/未同步），清单里只有 ep-9
    feedStewardConfig(true, {
      ...MEMORY_ON,
      judgeEndpoint: { id: "ep-88", name: "已下架判官", model: "jev-old", hasApiKey: true },
    });
    feedEmbeddingList([{ id: "ep-9", name: "Jev", model: "jev-latest", kind: "classifier", hasApiKey: true }], "ep-9");
    const select = container.querySelector<HTMLSelectElement>("[data-memory-judge-select]")!;
    expect(select.value).toBe("ep-88"); // 不说谎：显示已配真值
    expect(select.selectedOptions[0]!.textContent).toBe("已下架判官 (jev-old)");
  });

  it("清单未到前不误判「无默认端点」：开关不禁 + 无引导条；回执无默认后才置灰引引导", () => {
    const { container } = ui();
    feedStewardConfig(true, { ...MEMORY_ON, enabled: false, available: false });
    // embedding.list.result 尚未到达：不能把「未拉取」当「确实无默认」
    const on = container.querySelector<HTMLButtonElement>('[data-memory-option="on"]')!;
    expect(on.disabled).toBe(false);
    expect(container.querySelector("[data-memory-no-default]")).toBeNull();
    // 回执确实无默认 → 判据成立
    feedEmbeddingList([], null);
    expect(container.querySelector<HTMLButtonElement>('[data-memory-option="on"]')!.disabled).toBe(true);
    expect(container.querySelector("[data-memory-no-default]")).not.toBeNull();
  });

  it("召回量现值回填：回执 recallTopK/recallPool 生效值 → 两输入框；旧 daemon 缺席（additive）→ 缺省 5/24 兑底", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    expect((container.querySelector<HTMLInputElement>("[data-memory-topk-input]")!).value).toBe("8");
    expect((container.querySelector<HTMLInputElement>("[data-memory-pool-input]")!).value).toBe("32");
    feedStewardConfig(true, { ...MEMORY_ON, recallTopK: undefined, recallPool: undefined });
    expect((container.querySelector<HTMLInputElement>("[data-memory-topk-input]")!).value).toBe("5");
    expect((container.querySelector<HTMLInputElement>("[data-memory-pool-input]")!).value).toBe("24");
  });

  it("recallTopK 输入：改值失焦/回车提交 {memory:{recallTopK}}；非法值（0/2.5/999）回落最近已提交值零命令", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    const input = container.querySelector<HTMLInputElement>("[data-memory-topk-input]")!;
    expect(input.value).toBe("8");
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { recallTopK: 12 } });
    sendStewardSetConfig.mockClear();
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(sendStewardSetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe("12"); // 非法回落最近已提交值
    fireEvent.change(input, { target: { value: "2.5" } });
    fireEvent.blur(input);
    expect(sendStewardSetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe("12");
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.blur(input);
    expect(sendStewardSetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe("12");
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.keyDown(input, { key: "Enter" }); // 回车也提交
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { recallTopK: 10 } });
  });

  it("recallPool 输入：改值失焦提交 {memory:{recallPool}}；非法值（0/201）回落零命令", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    const input = container.querySelector<HTMLInputElement>("[data-memory-pool-input]")!;
    expect(input.value).toBe("32");
    fireEvent.change(input, { target: { value: "48" } });
    fireEvent.blur(input);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { recallPool: 48 } });
    sendStewardSetConfig.mockClear();
    fireEvent.change(input, { target: { value: "201" } }); // 超上界（MEMORY_RECALL_POOL_MAX=200）
    fireEvent.blur(input);
    expect(sendStewardSetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe("48");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(sendStewardSetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe("48");
  });

  it("资格阈值现值回填：回执 recallMinScore 生效值 → 阈值输入框；旧 daemon 缺席（additive）→ 缺省 0.3 兑底", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    expect((container.querySelector<HTMLInputElement>("[data-memory-score-input]")!).value).toBe("0.5");
    feedStewardConfig(true, { ...MEMORY_ON, recallMinScore: undefined });
    expect((container.querySelector<HTMLInputElement>("[data-memory-score-input]")!).value).toBe("0.3");
  });

  it("recallMinScore 输入：改值失焦/回车提交 {memory:{recallMinScore}}；非法值（-0.1/1.5/非数）回落最近已提交值零命令", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    const input = container.querySelector<HTMLInputElement>("[data-memory-score-input]")!;
    expect(input.value).toBe("0.5");
    fireEvent.change(input, { target: { value: "0.8" } });
    fireEvent.blur(input);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { recallMinScore: 0.8 } });
    sendStewardSetConfig.mockClear();
    for (const bad of ["-0.1", "1.5", "abc"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.blur(input);
      expect(sendStewardSetConfig).not.toHaveBeenCalled();
      expect(input.value).toBe("0.8"); // 非法回落最近已提交值（非数在 number 输入被清洗为空串——同判回落）
    }
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" }); // 回车也提交；0 = 关闸全放行（值域下界合法）
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { recallMinScore: 0 } });
  });

  // code-review task-91e2e2f9 B22 #1：send 失败不前移 committed（重试通道不被吞）
  it("recallTopK 提交 send 失败不前移 committed：再失焦仍重发（对照正确形态 commitKgThreshold 从配置现值取 committed）", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    const input = container.querySelector<HTMLInputElement>("[data-memory-topk-input]")!;
    sendStewardSetConfig.mockReturnValueOnce(false); // 断线窗口：命令未发出
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { recallTopK: 12 } });
    expect(container.querySelector("[data-memory-save-error]")).not.toBeNull(); // 行内错误（既有行为）
    sendStewardSetConfig.mockClear();
    fireEvent.blur(input); // 草稿仍 12：再失焦 = 重试
    // 旧代码：topKCommitted 已乐观前移至 12 → 判「未变零命令」不再发（重试被吞）
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ memory: { recallTopK: 12 } });
  });

  it("观测与入口迁入：条目计数行 + 待命提示（enabled ∧ !available）+ 管理记忆链接", () => {
    const { container } = ui();
    feedStewardConfig(true, { ...MEMORY_ON, available: false, entryCount: 0 });
    expect(container.querySelector("[data-memory-pending]")!.textContent).toContain("暂未生效");
    expect(container.querySelector("[data-memory-count]")).toBeNull(); // 零条目不显示计数
    feedStewardConfig(true, MEMORY_ON);
    expect(container.querySelector("[data-memory-pending]")).toBeNull();
    expect(container.querySelector("[data-memory-count]")!.textContent).toContain("7");
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-memory-manage-link]")!);
    expect(onOpenMemory).toHaveBeenCalledTimes(1);
  });

  it("空端点列表（判官）：显示引导链接（跳模型页向量 tab）——judgeEndpointId 下拉不动（D1）", () => {
    const { container } = ui();
    feedStewardConfig(true, MEMORY_ON);
    feedEmbeddingList([], "ep-1");
    expect(container.querySelector("[data-memory-judge-select]")).toBeNull();
    const goConfig = container.querySelector<HTMLButtonElement>("[data-memory-judge-go-config]")!;
    expect(goConfig.textContent).toMatch(/去模型页|models page/);
    fireEvent.click(goConfig);
    expect(onOpenModelsEmbeddingTab).toHaveBeenCalledTimes(1);
  });

  it("send 失败（未连接）→ 行内错误交代（data-memory-save-error）", () => {
    sendStewardSetConfig.mockReturnValueOnce(false);
    const { container } = ui();
    feedEmbeddingList([{ id: "ep-1", name: "Ollama 本地", model: "bge-m3" }], "ep-1");
    feedStewardConfig(true, { ...MEMORY_ON, enabled: false, available: false });
    fireEvent.click(container.querySelector<HTMLElement>('[data-memory-option="on"]')!);
    expect(container.querySelector("[data-memory-save-error]")!.textContent).toContain("未连接");
  });

  it("daemon 拒答（connection.error 尾缀 steward.set_config）→ 记忆组行内错误交代", () => {
    const { container } = ui();
    feedEmbeddingList([{ id: "ep-1", name: "Ollama 本地", model: "bge-m3" }], "ep-1");
    feedStewardConfig(true, { ...MEMORY_ON, enabled: false, available: false });
    fireEvent.click(container.querySelector<HTMLElement>('[data-memory-option="on"]')!);
    feedConnectionError("记忆配置非法（命令 steward.set_config）");
    expect(container.querySelector("[data-memory-save-error]")!.textContent).toContain("记忆配置非法");
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


describe("B4 唤醒链设置（管家组：快捷键（组合键）本地偏好——唤醒词已随「热键直通双工」退役）", () => {
  it("管家启用后渲染从属项；管家未启用：从属项不渲染（从属项形态同 speakReply）", () => {
    ui();
    feedStewardConfig(true);
    expect(screen.getByTestId("hotkey-record")).toBeTruthy();
    feedStewardConfig(false);
    expect(screen.queryByTestId("hotkey-record")).toBeNull();
  });
});

describe("管家组分诊判官（管家分诊判官接入批：开关 + 分类端点下拉）", () => {
  const TRIAGE_ON = {
    judgeEnabled: true,
    judgeEndpoint: { id: "ep-9", name: "Jev", model: "jev-latest", hasApiKey: true },
  };
  const CLASSIFIER_LIST = [
    { id: "ep-1", name: "Ollama 本地", model: "bge-m3" }, // embedding：不进下拉
    { id: "ep-9", name: "Jev", model: "jev-latest", kind: "classifier" as const, hasApiKey: true },
    { id: "ep-10", name: "判官二", model: "typesafe/jev-latest", kind: "classifier" as const, hasApiKey: true },
  ];

  it("管家启用后渲染判官行（从属项）：开关在场；judgeEnabled=false 下拉不渲染；未启用管家全行不渲染", () => {
    const { container } = ui();
    feedStewardConfig(true, undefined, { judgeEnabled: false, judgeEndpoint: null });
    const row = container.querySelector("[data-steward-triage]")!;
    expect(row).not.toBeNull();
    expect(row.className).toContain("fld-sub"); // 从属项缩进同 speak/wake
    const check = container.querySelector<HTMLInputElement>("[data-steward-triage-enabled] > input")!;
    expect(check.checked).toBe(false);
    expect(container.querySelector("[data-steward-triage-endpoint]")).toBeNull(); // 开关关：下拉不渲染
    feedStewardConfig(false, undefined, { judgeEnabled: false, judgeEndpoint: null });
    expect(container.querySelector("[data-steward-triage]")).toBeNull(); // 管家未启用：全行不渲染
  });

  it("开关写面：勾选 → sendStewardSetConfig({triage:{judgeEnabled}}) 不乐观翻转；回执回填", () => {
    const { container } = ui();
    feedStewardConfig(true, undefined, { judgeEnabled: false, judgeEndpoint: null });
    const check = container.querySelector<HTMLInputElement>("[data-steward-triage-enabled] > input")!;
    fireEvent.click(check);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ triage: { judgeEnabled: true } });
    expect(check.checked).toBe(false); // 回执前不乐观（daemon 权威）
    feedStewardConfig(true, undefined, TRIAGE_ON);
    expect(container.querySelector<HTMLInputElement>("[data-steward-triage-enabled] > input")!.checked).toBe(true);
  });

  it("下拉渲染：仅 kind=classifier 端点可选，现引用选中；切换写 {triage:{judgeEndpointId}}；空选项 = 清除引用", () => {
    const { container } = ui();
    feedStewardConfig(true, undefined, TRIAGE_ON);
    feedEmbeddingList(CLASSIFIER_LIST);
    const select = container.querySelector<HTMLSelectElement>("[data-steward-triage-endpoint-select]")!;
    expect(select).not.toBeNull();
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("ep-9"); // 现引用选中
    expect([...select.options].map((o) => o.value)).not.toContain("ep-1"); // embedding 过滤
    expect(select.options).toHaveLength(3); // 占位 + 两 classifier
    fireEvent.change(select, { target: { value: "ep-10" } });
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ triage: { judgeEndpointId: "ep-10" } });
    fireEvent.change(select, { target: { value: "" } });
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ triage: { judgeEndpointId: "" } }); // 空选项 = 清除
  });

  it("无分类端点：下拉禁用 + 引导提示（先在模型页-分类模型配置）；列表到达前同样禁用", () => {
    const { container } = ui();
    feedStewardConfig(true, undefined, TRIAGE_ON);
    feedEmbeddingList([{ id: "ep-1", name: "Ollama", model: "bge-m3" }]); // 只有 embedding 端点
    const select = container.querySelector<HTMLSelectElement>("[data-steward-triage-endpoint-select]")!;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("");
    expect(container.querySelector("[data-steward-triage-empty]")!.textContent).toContain("分类模型");
  });

  it("端点删除（回执 judgeEndpoint=null）→ 下拉显示未选择（占位选中）", () => {
    const { container } = ui();
    feedStewardConfig(true, undefined, { judgeEnabled: true, judgeEndpoint: null });
    feedEmbeddingList(CLASSIFIER_LIST);
    const select = container.querySelector<HTMLSelectElement>("[data-steward-triage-endpoint-select]")!;
    expect(select.value).toBe(""); // 未选择占位（读面视为未配）
  });

  it("双语键：切 en-US 后标签/提示切英文", () => {
    const { container } = ui();
    feedStewardConfig(true, undefined, { judgeEnabled: false, judgeEndpoint: null });
    const label = container.querySelector("[data-steward-triage] > .hud-label")!;
    expect(label.textContent).toContain("判官");
    fireEvent.click(document.querySelector('[data-lang-option="en-US"]')!);
    expect(label.textContent).toContain("Judge");
  });

  it("send 失败（未连接）→ 管家组行内错误交代（与启用开关同卡共享错误位）", () => {
    sendStewardSetConfig.mockReturnValueOnce(false);
    const { container } = ui();
    feedStewardConfig(true, undefined, { judgeEnabled: false, judgeEndpoint: null });
    fireEvent.click(container.querySelector<HTMLInputElement>("[data-steward-triage-enabled] > input")!);
    expect(container.querySelector("[data-steward-save-error]")!.textContent).toContain("未连接");
  });
});

describe("知识库组（批2 WP-C：查重阈值两输入——config.get/set_kg，回执对账驱动）", () => {
  const kgInputs = () => ({
    warn: document.querySelector<HTMLInputElement>("[data-kg-warn-input]")!,
    dup: document.querySelector<HTMLInputElement>("[data-kg-dup-input]")!,
  });

  it("进入分区拉取现值：requestKgConfig 在场调用；两阈值输入框在场", () => {
    const { container } = ui();
    expect(requestKgConfig).toHaveBeenCalled();
    expect(container.querySelector("[data-kg-card]")).not.toBeNull();
    expect(kgInputs().warn).not.toBeNull();
    expect(kgInputs().dup).not.toBeNull();
  });

  it("现值回填；改值失焦/回车提交部分更新 {similarityWarn}/{similarityDup}", () => {
    mockKg = { similarityWarn: 0.8, similarityDup: 0.92 };
    try {
      const { container } = ui();
      const { warn, dup } = kgInputs();
      expect(warn.value).toBe("0.8");
      expect(dup.value).toBe("0.92");
      fireEvent.change(warn, { target: { value: "0.75" } });
      fireEvent.blur(warn);
      expect(setKgConfig).toHaveBeenCalledWith({ similarityWarn: 0.75 });
      fireEvent.change(dup, { target: { value: "0.95" } });
      fireEvent.keyDown(dup, { key: "Enter" }); // 回车也提交
      expect(setKgConfig).toHaveBeenCalledWith({ similarityDup: 0.95 });
    } finally {
      mockKg = null;
    }
  });

  it("非法值（1.5/-0.1/空串）回落最近已提交值零命令", () => {
    mockKg = { similarityWarn: 0.8, similarityDup: 0.92 };
    try {
      const view = ui();
      const { warn } = kgInputs();
      for (const bad of ["1.5", "-0.1", ""]) {
        setKgConfig.mockClear();
        fireEvent.change(warn, { target: { value: bad } });
        fireEvent.blur(warn);
        expect(setKgConfig).not.toHaveBeenCalled();
        view.rerender(
          <I18nProvider>
            <ToastProvider>
              <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
            </ToastProvider>
          </I18nProvider>,
        );
        expect(kgInputs().warn.value).toBe("0.8"); // 回落最近已提交值
      }
    } finally {
      mockKg = null;
    }
  });

  it("「已保存」由 config.set_kg.result 回执对账驱动（非乐观置位）", () => {
    mockKg = { similarityWarn: 0.8, similarityDup: 0.92 };
    try {
      const view = ui();
      const { warn } = kgInputs();
      fireEvent.change(warn, { target: { value: "0.7" } });
      fireEvent.blur(warn);
      expect(setKgConfig).toHaveBeenCalledWith({ similarityWarn: 0.7 });
      // 结果帧未达：不出现「已保存」（禁乐观假反馈，TR-84）
      expect(document.querySelector("[data-kg-saved]")).toBeNull();
      mockKg = { similarityWarn: 0.7, similarityDup: 0.92 };
      view.rerender(
        <I18nProvider>
          <ToastProvider>
            <GeneralSettingsSection onOpenMemory={onOpenMemory} onOpenModelsEmbeddingTab={onOpenModelsEmbeddingTab} />
          </ToastProvider>
        </I18nProvider>,
      );
      expect(document.querySelector("[data-kg-saved]")!.textContent).toContain("已保存");
    } finally {
      mockKg = null;
    }
  });

  it("send false（未发出）→ 行内错误交代 + 不置「已保存」（send 返回值必消费，TR-84）", () => {
    mockKg = { similarityWarn: 0.8, similarityDup: 0.92 };
    setKgConfig.mockReturnValueOnce(false);
    try {
      const { container } = ui();
      const { warn } = kgInputs();
      fireEvent.change(warn, { target: { value: "0.7" } });
      fireEvent.blur(warn);
      expect(container.querySelector("[data-kg-save-error]")).not.toBeNull();
      expect(container.querySelector("[data-kg-saved]")).toBeNull();
    } finally {
      mockKg = null;
    }
  });

  it("在途 connection.error 收口：行内错误交代 + 不假「已保存」（M10-② 通道）", () => {
    mockKg = { similarityWarn: 0.8, similarityDup: 0.92 };
    try {
      const { container } = ui();
      const { warn } = kgInputs();
      fireEvent.change(warn, { target: { value: "0.7" } });
      fireEvent.blur(warn);
      feedConnError("config.set_kg: 阈值非法（命令 config.set_kg）");
      expect(container.querySelector("[data-kg-save-error]")).not.toBeNull();
      expect(container.querySelector("[data-kg-saved]")).toBeNull();
    } finally {
      mockKg = null;
    }
  });
});

// ── 网络代理批：通用分区原位挂载网络代理组（独立组件一行插入）──
describe("通用分区「网络代理」组（网络代理批）", () => {
  it("组在场（标题 + 开关 + 地址输入），且进入分区拉取现值", () => {
    mockProxy = { enabled: false, url: "http://127.0.0.1:7890" };
    try {
      const { container } = ui();
      expect(container.querySelector("[data-network-proxy]")).not.toBeNull();
      expect(container.querySelector('[data-proxy-option="on"]')).not.toBeNull();
      expect(container.querySelector("[data-proxy-url]")).not.toBeNull();
      expect(requestProxyConfig).toHaveBeenCalled();
    } finally {
      mockProxy = null;
    }
  });
});
