// @vitest-environment jsdom
/**
 * 智能体页组件测试（M6 T4；TracePage.test.tsx 先例：vi.mock SessionContext，
 * 帧注入 = 捕获的订阅回调直接回放）。
 *
 * 机械判据：
 * ① 进页拉取：mount → agent.config.list（全 kind）+ requestModelConfig +
 *    requestAuthList（S3a 可用性过滤数据源）；list.result 双块 → 双卡片渲染
 *    （工具行含 snippet；技能行来源 chip + 诊断警示；模型下拉缺省项
 *    「跟随全局默认」+ catalog optgroup）；AppLayout 壳（S3a：页名进
 *    header 槽，ag-page/ag-head/页内 scanline 退役）；
 * ② 开关流：点击工具开关 → agent.config.set_enabled 命令（payload 四字段）→
 *    pending 态（开关禁用）→ applied 回执 + changed 广播（revision 递增）→
 *    重拉 list → 开关态翻转（事件驱动，非乐观更新）；
 * ③ skipped 回执：toast 呈现原因 + 在途清（开关回可用、态不翻转）；
 * ④ 模型槽位：下拉选模型 → set_enabled(model,true)；选缺省项 → clear
 *    （enabled=false）；changed 广播 → 重拉 → 下拉值随新块刷新；
 * ⑤ 模型下拉可用性口径（S3a，与 chat P-3 同一 filterAvailableModels）
 *    ——configured 过滤（未 configured provider 整组隐藏）+ 当前槽位模型
 *    兑底（provider 未 configured 仍保留）+ authLoaded=false 不过滤；
 * ⑥ a11y：开关 role=switch + aria-checked；下拉 label 关联。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CatalogModel, EventEnvelope } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { AgentConfigProfileBlock } from "@helix/protocol";

const MAIN_BLOCK: AgentConfigProfileBlock = {
  profileKind: "main-session",
  tools: [
    { name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" },
    { name: "grep", enabled: true, snippet: "跨文件正则检索并列出匹配行" },
  ],
  skills: [
    {
      name: "hello-skill",
      description: "问候技能",
      filePath: "/home/dev/.helix/skills/hello-skill/SKILL.md",
      source: "user",
      enabled: true,
    },
    {
      name: "ws-skill",
      description: "工作区技能",
      filePath: "/ws/.helix/skills/ws-skill/SKILL.md",
      source: "project",
      enabled: false,
    },
    {
      // T5 builtin 第三源：内置技能行（不可禁用——开关恒禁用态）
      name: "web-access",
      description: "联网操作指引",
      filePath: "/daemon/resources/skills/web-access/SKILL.md",
      source: "builtin",
      enabled: true,
    },
  ],
  diagnostics: [
    { code: "invalid_metadata", message: "SKILL.md 缺少 description", path: "/ws/.helix/skills/broken/SKILL.md", source: "project" },
  ],
  model: null,
};

const SUB_BLOCK: AgentConfigProfileBlock = {
  profileKind: "subagent-worker",
  tools: [{ name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" }],
  skills: [],
  diagnostics: [],
  model: null,
};

const CATALOG: CatalogModel[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    providerId: "anthropic",
    contextWindow: 200_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    source: "builtin",
    reasoning: true, // v0.11 additive（thinking 批② 能力位）
    thinkingLevels: ["low", "medium", "high"],
  },
  {
    id: "openai/gpt-5.2",
    providerId: "openai",
    contextWindow: 400_000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
    source: "builtin",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high"],
  },
];

interface SetEnabledCall {
  profileKind: "main-session" | "subagent-worker";
  resourceType: "tool" | "skill" | "model";
  name: string;
  enabled: boolean;
}

const mock = {
  conn: "connected" as const,
  revision: 0,
  catalog: null as CatalogModel[] | null,
  auth: {} as Record<string, { providerId: string; configured: boolean; verifyStatus: "unverified" }>,
  authLoaded: false,
  sentList: 0,
  sendOk: true,
  sentSetEnabled: [] as SetEnabledCall[],
  listeners: [] as ((e: EventEnvelope) => void)[],
};
const requestModelConfig = vi.fn();
const requestAuthList = vi.fn();

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { conn: mock.conn, sessionId: null },
      topology: {
        active: { conn: mock.conn, sessionId: null },
        background: {},
        list: [],
        agentConfig: { revision: mock.revision },
        modelConfig: {
          catalog: mock.catalog === null ? null : { models: mock.catalog, refreshedAt: 1, source: "cache" as const, degraded: [] },
          auth: mock.auth,
          authLoaded: mock.authLoaded,
        },
      },
      requestModelConfig,
      requestAuthList,
      sendAgentConfigList: () => {
        mock.sentList += 1;
        return mock.sendOk;
      },
      sendAgentConfigSetEnabled: (call: SetEnabledCall) => {
        mock.sentSetEnabled.push(call);
        return mock.sendOk;
      },
      subscribeAgentConfigFrames: (cb: (e: EventEnvelope) => void) => {
        mock.listeners.push(cb);
        return () => {
          mock.listeners = mock.listeners.filter((l) => l !== cb);
        };
      },
    }),
  };
});

import AgentPage from "./AgentPage";

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言）
localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AgentPage path="/skills" />
      </ToastProvider>
    </I18nProvider>,
  );
}

function feed(frame: EventEnvelope): void {
  for (const l of mock.listeners) l(frame);
}

function feedList(mainOver: Partial<AgentConfigProfileBlock> = {}, subOver: Partial<AgentConfigProfileBlock> = {}): void {
  feed({
    v: "0.11",
    sessionId: "__system__",
    channel: "agent",
    type: "agent.config.list.result",
    payload: { profiles: [{ ...MAIN_BLOCK, ...mainOver }, { ...SUB_BLOCK, ...subOver }] },
  } as EventEnvelope);
}

function feedSetResult(payload: { status: "applied" } | { status: "skipped"; reason: string }): void {
  feed({
    v: "0.11",
    sessionId: "__system__",
    channel: "agent",
    type: "agent.config.set_enabled.result",
    payload,
  } as EventEnvelope);
}

function bumpRevision(rerender: (ui: React.ReactNode) => void): void {
  mock.revision += 1;
  rerender(
    <I18nProvider>
      <ToastProvider>
        <AgentPage path="/skills" />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("智能体页组件（M6 T4）", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mock.revision = 0;
    mock.catalog = null;
    mock.auth = {};
    mock.authLoaded = false;
    mock.sentList = 0;
    mock.sendOk = true;
    mock.sentSetEnabled = [];
  });

  it("① 进页拉取 + AppLayout 壳 + 双卡片渲染：工具 snippet / 技能来源分组与诊断 / 模型下拉缺省项与 optgroup", async () => {
    mock.catalog = CATALOG;
    const { rerender } = ui();
    // 进页：list（全 kind）+ 目录拉取 + auth.list（S3a 可用性过滤数据源）
    expect(mock.sentList).toBe(1);
    expect(requestModelConfig).toHaveBeenCalled();
    expect(requestAuthList).toHaveBeenCalled();
    // S3a AppLayout 壳：页名进 header 槽；自建壳/页内 scanline 退役；
    // 断言锚 data-agents-page 挂 main 内容根
    expect(document.querySelector(".app-layout")).toBeTruthy();
    expect(document.querySelector(".app-header .ag-title")!.textContent).toBe("智能体");
    expect(document.querySelector(".ag-page")).toBeNull();
    expect(document.querySelector(".ag-head")).toBeNull();
    expect(document.querySelectorAll(".scanline-overlay").length).toBe(0);
    expect(document.querySelector('[data-agents-page="/skills"]')!.className).toContain("pg");
    act(() => feedList());
    // 双卡片锚
    expect(await screen.findByText("主会话助手")).toBeTruthy();
    expect(screen.getByText("SubAgent worker")).toBeTruthy();
    // 工具行：名称 + snippet + 开关（a11y role/aria-checked）
    const grepSwitch = document.querySelector('[data-switch="grep"]') as HTMLButtonElement;
    expect(grepSwitch.getAttribute("role")).toBe("switch");
    expect(grepSwitch.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[data-tool-row="bash"]')!.textContent).toContain(
      "在沙箱工作目录执行 shell 命令并返回输出",
    );
    // 技能行：来源 chip + 禁用态 aria-checked=false
    expect(document.querySelector('[data-skill-row="hello-skill"] [data-source-chip]')!.textContent).toBe("user");
    expect(document.querySelector('[data-skill-row="ws-skill"]')!.textContent).toContain("project");
    expect(
      (document.querySelector('[data-switch="ws-skill"]') as HTMLButtonElement).getAttribute("aria-checked"),
    ).toBe("false");
    // builtin 组（T5）：「内置」组标签 + 来源 chip + 开关恒禁用（不可禁用语义）
    const builtinGroup = document.querySelector('[data-source-group="builtin"]')!;
    expect(builtinGroup).toBeTruthy();
    expect(builtinGroup.querySelector(".ag-src-label")!.textContent).toBe("内置");
    expect(document.querySelector('[data-skill-row="web-access"] [data-source-chip]')!.textContent).toBe("builtin");
    const builtinSwitch = document.querySelector('[data-switch="web-access"]') as HTMLButtonElement;
    expect(builtinSwitch.disabled).toBe(true);
    expect(builtinSwitch.getAttribute("aria-checked")).toBe("true");
    // 诊断警示（invalid_metadata + 文案 + 路径）
    const diag = document.querySelector("[data-diag-row]")!;
    expect(diag.textContent).toContain("invalid_metadata");
    expect(diag.textContent).toContain("SKILL.md 缺少 description");
    // 模型下拉：缺省项「跟随全局默认」+ provider optgroup
    const sel = document.getElementById("sel-model-main-session") as HTMLSelectElement;
    expect(sel).toBeTruthy();
    expect(sel.options[0]!.textContent).toBe("跟随全局默认");
    expect(sel.value).toBe(""); // 槽位未设
    expect(sel.querySelectorAll("optgroup").length).toBe(2);
    // subagent 卡缺省项文案（三级链语义）
    const subSel = document.getElementById("sel-model-subagent-worker") as HTMLSelectElement;
    expect(subSel.options[0]!.textContent).toBe("跟随会话与全局默认");
    // 两级关系说明注解在场
    expect(document.querySelector('[data-note="main"]')!.textContent).toContain("已手动切换的会话不受影响");
    expect(document.querySelector('[data-note="sub"]')!.textContent).toContain("运行中实例不受影响");
    void rerender;
  });

  it("② 开关流：点击 → set_enabled 命令 → pending 禁用 → applied + changed → 重拉 → 态翻转", async () => {
    const view = ui();
    act(() => feedList());
    const grepSwitch = (await screen.findByText("主会话助手")) && (document.querySelector('[data-switch="grep"]') as HTMLButtonElement);
    fireEvent.click(grepSwitch);
    // 命令 payload 四字段（关闭 grep）
    expect(mock.sentSetEnabled).toEqual([
      { profileKind: "main-session", resourceType: "tool", name: "grep", enabled: false },
    ]);
    // pending：开关禁用 + 态未翻转（事件驱动非乐观）
    expect(grepSwitch.disabled).toBe(true);
    expect(grepSwitch.getAttribute("aria-checked")).toBe("true");
    act(() => feedSetResult({ status: "applied" }));
    // changed 广播（revision 递增）→ 重拉
    const listBefore = mock.sentList;
    act(() => bumpRevision(view.rerender));
    act(() => feedList({ tools: MAIN_BLOCK.tools.map((t) => (t.name === "grep" ? { ...t, enabled: false } : t)) }));
    expect(mock.sentList).toBe(listBefore + 1);
    const fresh = document.querySelector('[data-switch="grep"]') as HTMLButtonElement;
    expect(fresh.getAttribute("aria-checked")).toBe("false");
    expect(fresh.disabled).toBe(false);
  });

  it("③ skipped 回执：toast 呈现原因 + 在途清（开关回可用、态不翻转）", async () => {
    const view = ui();
    act(() => feedList());
    await screen.findByText("主会话助手");
    const bashSwitch = document.querySelector('[data-switch="bash"]') as HTMLButtonElement;
    fireEvent.click(bashSwitch);
    expect(bashSwitch.disabled).toBe(true);
    act(() => feedSetResult({ status: "skipped", reason: "unknown-name" }));
    // toast：未生效 + 原因
    const toast = await screen.findByText(/未生效/);
    expect(toast.textContent).toContain("unknown-name");
    // 在途清：开关回可用，态保持旧值（skipped 不落库）
    const fresh = document.querySelector('[data-switch="bash"]') as HTMLButtonElement;
    expect(fresh.disabled).toBe(false);
    expect(fresh.getAttribute("aria-checked")).toBe("true");
    void view;
  });

  it("④ 模型槽位：选模型 → set(model,true)；选缺省 → clear(model,false)；changed 重拉后下拉刷新", async () => {
    mock.catalog = CATALOG;
    const view = ui();
    act(() => feedList());
    await screen.findByText("主会话助手");
    const sel = document.getElementById("sel-model-main-session") as HTMLSelectElement;
    // 选模型 → set 槽位
    fireEvent.change(sel, { target: { value: "anthropic/claude-sonnet-4-5" } });
    expect(mock.sentSetEnabled).toEqual([
      { profileKind: "main-session", resourceType: "model", name: "anthropic/claude-sonnet-4-5", enabled: true },
    ]);
    // applied + changed → 重拉（槽位已设）
    act(() => feedSetResult({ status: "applied" }));
    act(() => bumpRevision(view.rerender));
    act(() => feedList({ model: "anthropic/claude-sonnet-4-5" }));
    const selFresh = document.getElementById("sel-model-main-session") as HTMLSelectElement;
    expect(selFresh.value).toBe("anthropic/claude-sonnet-4-5");
    // 选回缺省项 → clear 槽位
    fireEvent.change(selFresh, { target: { value: "" } });
    expect(mock.sentSetEnabled[1]).toEqual({
      profileKind: "main-session",
      resourceType: "model",
      name: "-",
      enabled: false,
    });
    void within;
  });

  it("⑤ 模型下拉可用性口径（S3a）：configured 过滤 + 当前槽位兑底 + authLoaded=false 不过滤", async () => {
    mock.catalog = CATALOG;
    mock.authLoaded = true;
    mock.auth = {
      anthropic: { providerId: "anthropic", configured: true, verifyStatus: "unverified" },
      openai: { providerId: "openai", configured: false, verifyStatus: "unverified" },
    };
    const view = ui();
    act(() => feedList());
    await screen.findByText("主会话助手");
    const sel = document.getElementById("sel-model-main-session") as HTMLSelectElement;
    // ① configured 过滤：anthropic 组在场，openai 组整体隐藏（子卡同步）
    expect(sel.querySelectorAll("optgroup").length).toBe(1);
    expect(sel.querySelector("optgroup")!.getAttribute("label")).toBe("anthropic");
    expect(sel.querySelectorAll("option[value='openai/gpt-5.2']").length).toBe(0);
    const subSel = document.getElementById("sel-model-subagent-worker") as HTMLSelectElement;
    expect(subSel.querySelectorAll("option[value='openai/gpt-5.2']").length).toBe(0);

    // ② 当前槽位兑底：agent 已配 openai 模型但 provider 未 configured → 仍可见
    act(() => feedList({ model: "openai/gpt-5.2" }));
    const selFresh = document.getElementById("sel-model-main-session") as HTMLSelectElement;
    expect(selFresh.querySelectorAll("option[value='openai/gpt-5.2']").length).toBe(1);
    expect(selFresh.value).toBe("openai/gpt-5.2");
    // 兑底只护当前项：未 configured 组回场仅因当前项，configured 组正常在场
    expect(selFresh.querySelectorAll("optgroup").length).toBe(2);

    // ③ authLoaded=false 不过滤（首帧未到不闪空列表）
    mock.authLoaded = false;
    act(() => view.rerender(
      <I18nProvider>
        <ToastProvider>
          <AgentPage path="/skills" />
        </ToastProvider>
      </I18nProvider>,
    ));
    act(() => feedList());
    const selNoAuth = document.getElementById("sel-model-main-session") as HTMLSelectElement;
    expect(selNoAuth.querySelectorAll("optgroup").length).toBe(2);
    expect(selNoAuth.querySelectorAll("option[value='openai/gpt-5.2']").length).toBe(1);
  });
});
