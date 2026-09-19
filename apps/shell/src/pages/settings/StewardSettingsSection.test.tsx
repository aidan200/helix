// @vitest-environment jsdom
/**
 * 管家设置分区测试（V2.5 收官批：启用开关 + 模型槽位选择；V2.5 补丁：
 * 模型下拉「已配置过滤」口径——与 P-3 菜单 / AgentPage S3a / 语音区同源）。
 *
 * - mount → sendStewardGetConfig（幂等读）+ requestModelConfig（目录）+
 *   requestAuthList（configured 过滤数据源，V2.5 补丁）；
 *   steward.config.result 帧 → 本地态（开关/select 值）；
 * - mount → sendStewardGetConfig（幂等读）+ requestModelConfig（目录）+
 *   requestAuthList（configured 过滤数据源，V2.5 补丁）；
 *   steward.config.result 帧 → 本地态（开关/select 值）；
 * - 开关切换（checkbox 形态，UX 重排批：语音 TTS 播报开关同构）→
 *   sendStewardSetConfig {enabled}；回执 config.result 新态同步本地勾选；
 * - 模型选择（select，过滤后目录 provider/model 全 id）→ sendStewardSetConfig
 *   {model}；回执帧同步 select 值；
 * - configured 过滤（V2.5 补丁）：authLoaded=true 时仅 configured provider 的
 *   模型进下拉；现值兑底保留（provider 未配置也在，防 select 找不到现值）；
 *   authLoaded=false 不过滤（防加载期空态）；
 * - 现值不在目录 → 仍作为选项显示（select 不说谎）；
 * - 零可用（无 configured 且现值不在目录/空串）→ 现值占位 + hidden 空占位；
 * - send false（未连接）→ err toast，零乐观态。
 *
 * vi.mock SessionContext 先例（VoiceSettingsSection.test.tsx）；工厂闭包
 * 渲染时求值——模块级可变 mockAuth/mockAuthLoaded per-test 注入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import type { AuthProviderEntry, ModelConfigState } from "@/entities/session/model/state";

const sendStewardGetConfig = vi.fn(() => true);
const sendStewardSetConfig = vi.fn(() => true);
const requestModelConfig = vi.fn();
const requestAuthList = vi.fn();
// configured 过滤注入口（per-test 变更；工厂闭包渲染时求值，无 TDZ）
let mockAuth: Record<string, AuthProviderEntry> = {};
let mockAuthLoaded = false;
let frameListener: ((e: EventEnvelope) => void) | null = null;
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  frameListener = cb;
  return () => {
    frameListener = null;
  };
});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: {
      modelConfig: {
        catalog: {
          models: [
            {
              id: "deepseek/deepseek-v4-flash",
              providerId: "deepseek",
              contextWindow: 128000,
              cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.14 },
              source: "builtin",
              reasoning: false,
              thinkingLevels: [],
            },
            {
              id: "openai/gpt-5.2-mini",
              providerId: "openai",
              contextWindow: 400000,
              cost: { input: 0.25, output: 2, cacheRead: 0.125, cacheWrite: 2.5 },
              source: "builtin",
              reasoning: true,
              thinkingLevels: [],
            },
          ],
          refreshedAt: 0,
          source: "builtin",
          degraded: [],
        },
        defaultModel: "deepseek/deepseek-v4-flash",
        defaultThinking: null,
        auth: mockAuth,
        authLoaded: mockAuthLoaded,
        verifyInflight: null,
        setKeyInflight: null,
        deleteKeyInflight: null,
        setDefaultInflight: null,
        catalogRefreshing: false,
        writeError: null,
        compaction: null,
        scheduling: null,
        port: null,
        sandbox: null,
      } satisfies ModelConfigState,
      active: { conn: "connected" },
    },
    requestModelConfig,
    requestAuthList,
    sendStewardGetConfig,
    sendStewardSetConfig,
    subscribeStewardFrames,
  }),
}));

import StewardSettingsSection from "./ui/StewardSettingsSection";

function frame(payload: unknown): EventEnvelope {
  return { v: "0.13", sessionId: "__system__", channel: "steward", type: "steward.config.result", payload } as EventEnvelope;
}

/** auth.list 行（configured 过滤测试面；verifyStatus 不参与过滤口径）。 */
function authEntry(providerId: string, configured: boolean): AuthProviderEntry {
  return { providerId, configured, verifyStatus: configured ? "ok" : "unverified" };
}

function rig() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <StewardSettingsSection />
      </ToastProvider>
    </I18nProvider>,
  );
}

// jsdom navigator.language 默认 en-US：钉 zh-CN（AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("StewardSettingsSection 管家设置段（V2.5 收官批）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth = {};
    mockAuthLoaded = false;
  });
  afterEach(() => {
    cleanup();
    frameListener = null;
  });

  it("mount 拉取：sendStewardGetConfig + requestModelConfig + requestAuthList（V2.5 补丁，configured 过滤数据源）；config.result → 开关默认关 + select 现值", async () => {
    rig();
    expect(sendStewardGetConfig).toHaveBeenCalled();
    expect(requestModelConfig).toHaveBeenCalled();
    expect(requestAuthList).toHaveBeenCalled();
    // 现态到达前：开关段渲染（默认关未勾），select 未定态
    const off = document.querySelector("[data-steward-enabled] input") as HTMLInputElement;
    expect(off).not.toBeNull();
    expect(off.checked).toBe(false);
    act(() => {
      frameListener?.(frame({ enabled: false, model: "deepseek/deepseek-v4-flash" }));
    });
    await waitFor(() => {
      expect((screen.getByTestId("steward-model-select") as HTMLSelectElement).value).toBe("deepseek/deepseek-v4-flash");
    });
  });

  it("开关切换：勾选 → sendStewardSetConfig({enabled:true})；回执新态同步本地勾选；取消勾 → {enabled:false}", async () => {
    rig();
    act(() => {
      frameListener?.(frame({ enabled: false, model: "deepseek/deepseek-v4-flash" }));
    });
    const cb = document.querySelector("[data-steward-enabled] input") as HTMLInputElement;
    fireEvent.click(cb);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ enabled: true });
    // 回执驱动本地态（不乐观）
    act(() => {
      frameListener?.(frame({ enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    await waitFor(() => {
      expect((document.querySelector("[data-steward-enabled] input") as HTMLInputElement).checked).toBe(true);
    });
    // 关回去（checkbox 取消勾选）
    fireEvent.click(document.querySelector("[data-steward-enabled] input") as HTMLInputElement);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ enabled: false });
  });

  it("模型选择：select 换值 → sendStewardSetConfig({model})；回执帧同步 select 值", async () => {
    rig();
    act(() => {
      frameListener?.(frame({ enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    const select = (await waitFor(() => screen.getByTestId("steward-model-select"))) as HTMLSelectElement;
    // 目录两模型均为选项
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("deepseek/deepseek-v4-flash");
    expect(options).toContain("openai/gpt-5.2-mini");
    fireEvent.change(select, { target: { value: "openai/gpt-5.2-mini" } });
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ model: "openai/gpt-5.2-mini" });
    act(() => {
      frameListener?.(frame({ enabled: true, model: "openai/gpt-5.2-mini" }));
    });
    await waitFor(() => {
      expect((screen.getByTestId("steward-model-select") as HTMLSelectElement).value).toBe("openai/gpt-5.2-mini");
    });
  });

  it("现值不在目录（daemon 默认 flash 模型）→ 仍作为选项显示", async () => {
    rig();
    act(() => {
      frameListener?.(frame({ enabled: false, model: "zhipu/glm-5-flash" }));
    });
    const select = (await waitFor(() => screen.getByTestId("steward-model-select"))) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("zhipu/glm-5-flash");
    expect(select.value).toBe("zhipu/glm-5-flash");
  });

  it("send false（未连接）→ err toast，开关不乐观翻转", async () => {
    sendStewardSetConfig.mockReturnValueOnce(false);
    const r = rig();
    act(() => {
      frameListener?.(frame({ enabled: false, model: "deepseek/deepseek-v4-flash" }));
    });
    const on = (await waitFor(() =>
      document.querySelector("[data-steward-enabled] input"),
    )) as HTMLInputElement;
    fireEvent.click(on);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ enabled: true });
    // 无回执：本地仍未勾（结果帧驱动，TR-84 禁乐观假反馈）
    expect((document.querySelector("[data-steward-enabled] input") as HTMLInputElement).checked).toBe(false);
    await waitFor(() => {
      expect(r.container.textContent).toContain("未连接");
    });
  });

  // ── V2.5 补丁：模型下拉「已配置过滤」口径（P-3 / AgentPage S3a / 语音区同源）──

  it("configured 过滤：authLoaded=true 时仅 configured provider 的模型进下拉", async () => {
    mockAuth = { deepseek: authEntry("deepseek", true), openai: authEntry("openai", false) };
    mockAuthLoaded = true;
    rig();
    act(() => {
      frameListener?.(frame({ enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    const select = (await waitFor(() => screen.getByTestId("steward-model-select"))) as HTMLSelectElement;
    // openai 未配置 key：整体不进下拉（未配置分组隐藏，同 P-3 口径）
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["deepseek/deepseek-v4-flash"]);
    expect(select.value).toBe("deepseek/deepseek-v4-flash");
  });

  it("现值兑底：现值 provider 未 configured（模型在目录内）→ 该项仍在下拉", async () => {
    mockAuth = { deepseek: authEntry("deepseek", false), openai: authEntry("openai", true) };
    mockAuthLoaded = true;
    rig();
    act(() => {
      frameListener?.(frame({ enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    const select = (await waitFor(() => screen.getByTestId("steward-model-select"))) as HTMLSelectElement;
    // deepseek 未配置但为现值：兑底保留（防 select 找不到现值）；openai configured 正常在列
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "deepseek/deepseek-v4-flash",
      "openai/gpt-5.2-mini",
    ]);
    expect(select.value).toBe("deepseek/deepseek-v4-flash");
  });

  it("零可用态：无 configured 且现值不在目录 → 现值占位保底 + modelHint 如实交代", async () => {
    mockAuth = { deepseek: authEntry("deepseek", false), openai: authEntry("openai", false) };
    mockAuthLoaded = true;
    const r = rig();
    act(() => {
      frameListener?.(frame({ enabled: false, model: "zhipu/glm-5-flash" }));
    });
    const select = (await waitFor(() => screen.getByTestId("steward-model-select"))) as HTMLSelectElement;
    // 目录零 configured：目录项全隐；现值兑底为唯一选项（select 不说谎）
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["zhipu/glm-5-flash"]);
    expect(select.value).toBe("zhipu/glm-5-flash");
    // hint 文案如实反映过滤口径（指向模型分区配置）
    expect(r.container.textContent).toContain("已配置");
  });

  it("零可用态（现值空串）：无 configured 且现值为空 → hidden 空占位，select 值稳空", async () => {
    mockAuth = { deepseek: authEntry("deepseek", false), openai: authEntry("openai", false) };
    mockAuthLoaded = true;
    rig();
    act(() => {
      frameListener?.(frame({ enabled: false, model: "" }));
    });
    const select = (await waitFor(() => screen.getByTestId("steward-model-select"))) as HTMLSelectElement;
    // options 集合空 → hidden 空占位兑底（受控 select 无匹配项防护，L127 机制延展）
    expect(Array.from(select.options).map((o) => o.value)).toEqual([""]);
    expect(select.value).toBe("");
  });

  it("authLoaded=false：不过滤（防加载期空态），目录全量在", async () => {
    mockAuth = { deepseek: authEntry("deepseek", false) }; // 即使有未配置行——首批未到不过滤
    mockAuthLoaded = false;
    rig();
    act(() => {
      frameListener?.(frame({ enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    const select = (await waitFor(() => screen.getByTestId("steward-model-select"))) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "deepseek/deepseek-v4-flash",
      "openai/gpt-5.2-mini",
    ]);
  });
});
