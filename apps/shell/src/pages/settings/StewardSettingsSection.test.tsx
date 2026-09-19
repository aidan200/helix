// @vitest-environment jsdom
/**
 * 管家设置分区测试（V2.5 收官批：启用开关 + 模型槽位选择）。
 *
 * - mount → sendStewardGetConfig（幂等读）+ requestModelConfig（目录）；
 *   steward.config.result 帧 → 本地态（开关/select 值）；
 * - 开关切换（radio off/on，语音 TTS 播报开关同构）→ sendStewardSetConfig
 *   {enabled}；回执 config.result 新态同步本地选中；
 * - 模型选择（select，目录 provider/model 全 id）→ sendStewardSetConfig
 *   {model}；回执帧同步 select 值；
 * - 现值不在目录 → 仍作为选项显示（select 不说谎）；
 * - send false（未连接）→ err toast，零乐观态。
 *
 * vi.mock SessionContext 先例（VoiceSettingsSection.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import type { ModelConfigState } from "@/entities/session/model/state";

const sendStewardGetConfig = vi.fn(() => true);
const sendStewardSetConfig = vi.fn(() => true);
const requestModelConfig = vi.fn();
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
        auth: {},
        authLoaded: false,
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
    sendStewardGetConfig,
    sendStewardSetConfig,
    subscribeStewardFrames,
  }),
}));

import StewardSettingsSection from "./ui/StewardSettingsSection";

function frame(payload: unknown): EventEnvelope {
  return { v: "0.13", sessionId: "__system__", channel: "steward", type: "steward.config.result", payload } as EventEnvelope;
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
  });
  afterEach(() => {
    cleanup();
    frameListener = null;
  });

  it("mount 拉取：sendStewardGetConfig + requestModelConfig；config.result → 开关默认关 + select 现值", async () => {
    rig();
    expect(sendStewardGetConfig).toHaveBeenCalled();
    expect(requestModelConfig).toHaveBeenCalled();
    // 现态到达前：开关段渲染（默认关选中），select 未定态
    const off = document.querySelector('input[name="steward-enabled"][value="off"]') as HTMLInputElement;
    expect(off).not.toBeNull();
    expect(off.checked).toBe(true);
    act(() => {
      frameListener?.(frame({ enabled: false, model: "deepseek/deepseek-v4-flash" }));
    });
    await waitFor(() => {
      expect((screen.getByTestId("steward-model-select") as HTMLSelectElement).value).toBe("deepseek/deepseek-v4-flash");
    });
  });

  it("开关切换：radio on → sendStewardSetConfig({enabled:true})；回执新态同步本地选中", async () => {
    rig();
    act(() => {
      frameListener?.(frame({ enabled: false, model: "deepseek/deepseek-v4-flash" }));
    });
    const on = document.querySelector('input[name="steward-enabled"][value="on"]') as HTMLInputElement;
    fireEvent.click(on);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ enabled: true });
    // 回执驱动本地态（不乐观）
    act(() => {
      frameListener?.(frame({ enabled: true, model: "deepseek/deepseek-v4-flash" }));
    });
    await waitFor(() => {
      expect((document.querySelector('input[name="steward-enabled"][value="on"]') as HTMLInputElement).checked).toBe(true);
    });
    // 关回去
    fireEvent.click(document.querySelector('input[name="steward-enabled"][value="off"]') as HTMLInputElement);
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
      document.querySelector('input[name="steward-enabled"][value="on"]'),
    )) as HTMLInputElement;
    fireEvent.click(on);
    expect(sendStewardSetConfig).toHaveBeenCalledWith({ enabled: true });
    // 无回执：本地仍 off（结果帧驱动，TR-84 禁乐观假反馈）
    expect((document.querySelector('input[name="steward-enabled"][value="on"]') as HTMLInputElement).checked).toBe(false);
    await waitFor(() => {
      expect(r.container.textContent).toContain("未连接");
    });
  });
});
