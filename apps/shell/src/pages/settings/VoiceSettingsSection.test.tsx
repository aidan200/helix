// @vitest-environment jsdom
/**
 * 语音设置分区测试（语音输入批 V1 + 语音播报批 V2 + 语音服务卡退役批）：
 * - 识别服务偏好（lang-switch 三选按钮）：默认 auto；点击写 localStorage
 *   （helix.stt.provider）+ aria-pressed 翻转；
 * - 配置态区分（语音服务卡退役批：状态卡整体移除）：具名服务未配 key →
 *   选择钮标灰（opt-nokey）+ 「未配置」后缀；已配 → 无标记；auto 恒无标记；
 *   密码输入框零残留（key 管理唯一入口归「模型」分区，不做第二入口）；
 * - 播报开关（checkbox 形态）：默认关；切换写 localStorage
 *   （helix.voice.broadcast）+ 即时订阅/退订；
 * - 音色选择写 localStorage（helix.voice.ttsVoice）+ 默认 Cherry 选中；
 * - 试听按钮 → sendVoiceSynthesize(固定短句, {voice, language:"zh"})；
 *   回执 ok → Audio 播放；回执 error → toast err；回执未 pending 不消费
 *   （单飞门控）；send false（未连接）→ toast err 不置 pending。
 *
 * vi.mock SessionContext 先例（SettingsPage.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import type { AuthProviderEntry } from "@/entities/session/model/state";

const requestAuthList = vi.fn();
const sendVoiceSynthesize = vi.fn(() => true);
const sendVoiceSubscribe = vi.fn(() => true);
const sendVoiceUnsubscribe = vi.fn(() => true);
let frameListener: ((e: EventEnvelope) => void) | null = null;
const subscribeVoiceFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  frameListener = cb;
  return () => {
    frameListener = null;
  };
});
// 配置态区分数据注入口（per-test 变更；工厂闭包渲染时求值，无 TDZ）
let mockAuth: Record<string, AuthProviderEntry> = {};

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { modelConfig: { auth: mockAuth }, active: { conn: "connected" } },
    requestAuthList,
    sendVoiceSynthesize,
    sendVoiceSubscribe,
    sendVoiceUnsubscribe,
    subscribeVoiceFrames,
  }),
}));

import VoiceSettingsSection from "./ui/VoiceSettingsSection";

/** 可控 Audio fake。 */
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  volume = 1;
  onended: (() => void) | null = null;
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
}

const AUDITION_OK: EventEnvelope = {
  v: "0.14",
  sessionId: "__system__",
  channel: "voice",
  type: "voice.synthesize.result",
  payload: { status: "ok", audio: "data:audio/wav;base64,QQ==", provider: "dashscope", voice: "Cherry" },
} as unknown as EventEnvelope;

const AUDITION_ERR: EventEnvelope = {
  v: "0.14",
  sessionId: "__system__",
  channel: "voice",
  type: "voice.synthesize.result",
  payload: { status: "error", reason: "无 key" },
} as unknown as EventEnvelope;

/** auth.list 行（配置态区分数据面）。 */
function authEntry(providerId: string, configured: boolean, keyMasked?: string): AuthProviderEntry {
  return { providerId, configured, verifyStatus: configured ? "ok" : "unverified", ...(keyMasked !== undefined ? { keyMasked } : {}) };
}

describe("VoiceSettingsSection 语音输入段（UX 重排批）", () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom navigator.language 默认 en-US：钉 zh-CN（AG-14 白名单键；clear 后重钉）
    localStorage.setItem("helix-lang", "zh-CN");
    mockAuth = {};
    FakeAudio.instances = [];
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    frameListener = null;
  });

  const rig = () =>
    render(
      <I18nProvider>
        <ToastProvider>
          <VoiceSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );

  it("识别服务偏好：默认自动（推荐）选中；点「只用 DashScope」写偏好 + aria-pressed 翻转", () => {
    const r = rig();
    const auto = r.container.querySelector('[data-stt-option="auto"]') as HTMLButtonElement;
    // 嵌套对象键解析（UX 重排批修复：旧点分字面量键经 t() 逐段下钻不解析，
    // 选项标签曾渲染裸 key）
    expect(auto.textContent).toBe("自动（推荐）");
    expect(auto.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("helix.stt.provider")).toBeNull();

    fireEvent.click(r.container.querySelector('[data-stt-option="dashscope"]') as HTMLButtonElement);
    expect(localStorage.getItem("helix.stt.provider")).toBe("dashscope");
    expect(auto.getAttribute("aria-pressed")).toBe("false");
    expect((r.container.querySelector('[data-stt-option="dashscope"]') as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");

    // 切回自动 = 移除偏好
    fireEvent.click(auto);
    expect(localStorage.getItem("helix.stt.provider")).toBeNull();
  });

  it("配置态区分（语音服务卡退役批）：未配 key 的服务钮标灰 + 后缀标记；已配/auto 无标记", () => {
    mockAuth = {
      dashscope: authEntry("dashscope", true, "sk-abcd1234"),
      siliconflow: authEntry("siliconflow", false),
    };
    const r = rig();
    const auto = r.container.querySelector('[data-stt-option="auto"]') as HTMLButtonElement;
    const ds = r.container.querySelector('[data-stt-option="dashscope"]') as HTMLButtonElement;
    const sf = r.container.querySelector('[data-stt-option="siliconflow"]') as HTMLButtonElement;
    // 已配 key 与 auto：无标记
    expect(auto.classList.contains("opt-nokey")).toBe(false);
    expect(ds.classList.contains("opt-nokey")).toBe(false);
    expect(ds.querySelector(".opt-nokey-tag")).toBeNull();
    // 未配 key：标灰 + 「未配置」后缀
    expect(sf.classList.contains("opt-nokey")).toBe(true);
    expect(sf.textContent).toContain("未配置");
    // 状态卡整体退役：零残留
    expect(r.container.querySelector("[data-voice-keys]")).toBeNull();
    expect(r.container.querySelectorAll(".voice-svc-row")).toHaveLength(0);
  });

  it("key 录入入口零残留：无密码输入框（key 管理归「模型」分区，不做第二入口）", () => {
    const r = rig();
    expect(r.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(r.container.querySelectorAll("button").length).toBe(4); // 3 偏好按钮 + 1 试听
  });
});

describe("VoiceSettingsSection TTS 段（语音播报批 V2 + checkbox 重排）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    mockAuth = {};
    FakeAudio.instances = [];
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    frameListener = null;
  });

  const rig = () =>
    render(
      <I18nProvider>
        <ToastProvider>
          <VoiceSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );

  const broadcastCheckbox = (r: ReturnType<typeof rig>): HTMLInputElement =>
    r.container.querySelector("[data-tts-enabled] input") as HTMLInputElement;

  it("播报开关默认关（checkbox 未勾）；勾选写偏好、取消移除", () => {
    const r = rig();
    expect(broadcastCheckbox(r).checked).toBe(false);
    expect(localStorage.getItem("helix.voice.broadcast")).toBeNull();

    fireEvent.click(broadcastCheckbox(r));
    expect(localStorage.getItem("helix.voice.broadcast")).toBe("1");
    fireEvent.click(broadcastCheckbox(r));
    expect(localStorage.getItem("helix.voice.broadcast")).toBeNull();
  });

  it("偏好已开时进入分区 → checkbox 勾选（localStorage 读面）", () => {
    localStorage.setItem("helix.voice.broadcast", "1");
    const r = rig();
    expect(broadcastCheckbox(r).checked).toBe(true);
  });

  it("播报开关切换即时订阅：勾 → sendVoiceSubscribe(当前音色)；取消 → sendVoiceUnsubscribe（V2 缺陷修复：不再等重连）", () => {
    const r = rig();
    fireEvent.click(broadcastCheckbox(r));
    expect(sendVoiceSubscribe).toHaveBeenCalledWith("Cherry"); // 默认音色随订阅上报
    fireEvent.click(broadcastCheckbox(r));
    expect(sendVoiceUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("订阅态下切音色 → sendVoiceSubscribe(新音色) 即时重报（音色随订阅上报）", () => {
    rig();
    const select = screen.getByLabelText(/播报音色|Voice/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Ethan" } });
    expect(sendVoiceSubscribe).toHaveBeenCalledWith("Ethan");
  });

  it("音色选择：默认 Cherry 选中；选项标签渲染真文案（非裸 key）；切换写 helix.voice.ttsVoice", () => {
    rig();
    const select = screen.getByLabelText(/播报音色|Voice/) as HTMLSelectElement;
    expect(select.value).toBe("Cherry");
    expect((select.options[0] as HTMLOptionElement).textContent).toContain("芊悦");
    fireEvent.change(select, { target: { value: "Ethan" } });
    expect(localStorage.getItem("helix.voice.ttsVoice")).toBe("Ethan");
  });

  it("试听：按钮 → sendVoiceSynthesize(固定短句+voice+zh) → 回执 ok Audio 播放", async () => {
    rig();
    const btn = screen.getByRole("button", { name: /试听|Audition/ });
    fireEvent.click(btn);
    expect(sendVoiceSynthesize).toHaveBeenCalledTimes(1);
    expect(sendVoiceSynthesize).toHaveBeenCalledWith(
      expect.stringMatching(/语音播报|Voice broadcast/),
      expect.objectContaining({ voice: "Cherry", language: "zh" }),
    );

    await act(async () => {
      frameListener!(AUDITION_OK);
    });
    await waitFor(() => expect(FakeAudio.instances.length).toBe(1));
    expect(FakeAudio.instances[0]!.src).toBe("data:audio/wav;base64,QQ==");
  });

  it("试听回执 error → toast err；未 pending 的回执不消费（单飞门控）", async () => {
    rig();
    // 未点试听先到一帧（陈旧回执）→ 不播放
    await act(async () => {
      frameListener!(AUDITION_OK);
    });
    expect(FakeAudio.instances.length).toBe(0);

    const btn = screen.getByRole("button", { name: /试听|Audition/ });
    fireEvent.click(btn);
    await act(async () => {
      frameListener!(AUDITION_ERR);
    });
    await waitFor(() => {
      expect(screen.getAllByText(/无 key/).length).toBeGreaterThan(0);
    });
    expect(FakeAudio.instances.length).toBe(0);
  });

  it("试听 send false（未连接）→ 不置 pending、toast err", async () => {
    sendVoiceSynthesize.mockReturnValueOnce(false);
    rig();
    fireEvent.click(screen.getByRole("button", { name: /试听|Audition/ }));
    // 未连接失败后，陈旧回执不被消费
    await act(async () => {
      frameListener!(AUDITION_OK);
    });
    expect(FakeAudio.instances.length).toBe(0);
  });
});
