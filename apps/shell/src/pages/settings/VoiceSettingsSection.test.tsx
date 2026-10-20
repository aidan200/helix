// @vitest-environment jsdom
/**
 * 语音设置分区测试（语音输入批 V1 + 语音播报批 V2 + 语音服务卡退役批）：
 * - 识别服务偏好（lang-switch 三选按钮）：默认 auto；点击写 localStorage
 *   （helix.stt.provider）+ aria-pressed 翻转；
 * - 配置态区分（语音服务卡退役批：状态卡整体移除）：具名服务未配 key →
 *   选择钮禁选（disabled）+ 「未配置」后缀；已配 → 可选无标记；auto 恒可选；
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
const requestVoiceModelConfig = vi.fn();
const setVoiceModelConfig = vi.fn((_patch: Partial<Record<string, string>>) => true);
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
// ASR/TTS 模型配置注入口（模型配置接入 P0；null = 未请求态）
let mockVoiceModels: Record<string, string> | null = null;

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { modelConfig: { auth: mockAuth, voiceModels: mockVoiceModels }, active: { conn: "connected" } },
    requestAuthList,
    requestVoiceModelConfig,
    setVoiceModelConfig,
    sendVoiceSynthesize,
    sendVoiceSubscribe,
    sendVoiceUnsubscribe,
    subscribeVoiceFrames,
  }),
}));

import VoiceSettingsSection from "./ui/VoiceSettingsSection";
import { zhCN } from "@/shared/i18n/lang/zh-CN";
import { enUS } from "@/shared/i18n/lang/en-US";

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
    // 点击而要生效的前置：dashscope 已配 key（未配的钮禁选，点不动）
    mockAuth = { dashscope: authEntry("dashscope", true, "sk-abcd1234") };
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

  it("配置态区分（语音服务卡退役批）：未配 key 的服务钮禁选 + 后缀标记；已配/auto 可选无标记", () => {
    mockAuth = {
      dashscope: authEntry("dashscope", true, "sk-abcd1234"),
      siliconflow: authEntry("siliconflow", false),
    };
    const r = rig();
    const auto = r.container.querySelector('[data-stt-option="auto"]') as HTMLButtonElement;
    const ds = r.container.querySelector('[data-stt-option="dashscope"]') as HTMLButtonElement;
    const sf = r.container.querySelector('[data-stt-option="siliconflow"]') as HTMLButtonElement;
    // 已配 key 与 auto：可选、无标记
    expect(auto.disabled).toBe(false);
    expect(ds.disabled).toBe(false);
    expect(ds.classList.contains("opt-nokey")).toBe(false);
    expect(ds.querySelector(".opt-nokey-tag")).toBeNull();
    // 未配 key：禁选（浏览器不派发 click，偏好写不进去）+ 「未配置」后缀
    expect(sf.disabled).toBe(true);
    expect(sf.classList.contains("opt-nokey")).toBe(true);
    expect(sf.textContent).toContain("未配置");
    // 状态卡整体退役：零残留
    expect(r.container.querySelector("[data-voice-keys]")).toBeNull();
    expect(r.container.querySelectorAll(".voice-svc-row")).toHaveLength(0);
  });

  it("key 录入入口零残留：无密码输入框（key 管理归「模型」分区，不做第二入口）", () => {
    const r = rig();
    expect(r.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    // 11 = 3 偏好按钮 + 1 试听 + 3 欢迎词工坊 + 2 声纹（注册/导入——声纹 v2 迁入语音页）+ 2 模型配置（保存/恢复默认——模型配置接入 P0）
    expect(r.container.querySelectorAll("button").length).toBe(11);
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

  it("订阅 send false（断线窗口）→ toast 交代（TR-84 返回值必消费；偏好保留由重连重放自愈）", () => {
    sendVoiceSubscribe.mockImplementationOnce(() => false);
    const r = rig();
    fireEvent.click(broadcastCheckbox(r));
    expect(r.container.textContent).toContain("未连接 daemon");
    expect(localStorage.getItem("helix.voice.broadcast")).toBe("1"); // 偏好照写（重连重放补订阅）
  });

  it("订阅态下切音色 → sendVoiceSubscribe(新音色) 即时重报（音色随订阅上报）", () => {
    // B22 #3 后前提为真：播报开关 on（订阅态）才随订阅上报；off 态选音色
    // 只写偏好（旧测试依赖的「无条件订阅」正是被修的绕开关缺陷）
    localStorage.setItem("helix.voice.broadcast", "1");
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
    const btn = screen.getByRole("button", { name: "试听" });
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

    const btn = screen.getByRole("button", { name: "试听" });
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
    fireEvent.click(screen.getByRole("button", { name: "试听" }));
    // 未连接失败后，陈旧回执不被消费
    await act(async () => {
      frameListener!(AUDITION_OK);
    });
    expect(FakeAudio.instances.length).toBe(0);
  });
});

describe("VoiceSettingsSection B3 插话检测参数组（回声防线）", () => {
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

  const input = (r: ReturnType<typeof rig>, sel: string): HTMLInputElement =>
    r.container.querySelector(sel) as HTMLInputElement;

  it("四参数控件渲染：灵敏度/最短发声/静默窗滑条 + 双参 checkbox + 容忍带滑条，默认值回显", () => {
    const r = rig();
    const sens = input(r, "[data-gate-sensitivity]");
    const minDur = input(r, "[data-gate-min-duration]");
    const silence = input(r, "[data-gate-silence-window]");
    const check = input(r, "[data-gate-voice-check]");
    const tol = input(r, "[data-gate-tolerance]");
    expect(sens.type).toBe("range");
    expect(minDur.type).toBe("range");
    expect(silence.type).toBe("range");
    expect(check.type).toBe("checkbox");
    expect(check.checked).toBe(true); // 双参判定缺省开
    expect(tol.type).toBe("range");
    expect(sens.value).toBe("50");
    expect(minDur.value).toBe("300");
    expect(silence.value).toBe("300");
    expect(tol.value).toBe("50");
    // 数值展示（防溢出：定宽 + 等宽数字类在场）
    const chip = r.container.querySelector("[data-gate-min-duration-value]") as HTMLElement;
    expect(chip.textContent).toContain("300");
    expect(chip.classList.contains("tabular-nums")).toBe(true);
  });

  it("滑条改动即时写偏好 + chip 数值跟随", () => {
    const r = rig();
    fireEvent.change(input(r, "[data-gate-sensitivity]"), { target: { value: "80" } });
    expect(localStorage.getItem("helix.voice.vadSensitivity")).toBe("80");
    fireEvent.change(input(r, "[data-gate-min-duration]"), { target: { value: "550" } });
    expect(localStorage.getItem("helix.voice.minDuration")).toBe("550");
    expect((r.container.querySelector("[data-gate-min-duration-value]") as HTMLElement).textContent).toContain("550");
    fireEvent.change(input(r, "[data-gate-silence-window]"), { target: { value: "800" } });
    expect(localStorage.getItem("helix.voice.silenceWindow")).toBe("800");
    fireEvent.change(input(r, "[data-gate-tolerance]"), { target: { value: "20" } });
    expect(localStorage.getItem("helix.voice.zcrTolerance")).toBe("20");
  });

  it("偏好已写时进入分区 → 控件回显（localStorage 读面）", () => {
    localStorage.setItem("helix.voice.vadSensitivity", "25");
    localStorage.setItem("helix.voice.minDuration", "700");
    localStorage.setItem("helix.voice.silenceWindow", "150");
    localStorage.setItem("helix.voice.voiceCheck", "0");
    localStorage.setItem("helix.voice.zcrTolerance", "90");
    const r = rig();
    expect(input(r, "[data-gate-sensitivity]").value).toBe("25");
    expect(input(r, "[data-gate-min-duration]").value).toBe("700");
    expect(input(r, "[data-gate-silence-window]").value).toBe("150");
    expect(input(r, "[data-gate-voice-check]").checked).toBe(false);
    expect(input(r, "[data-gate-tolerance]").value).toBe("90");
  });

  it("双参开关 checkbox 写偏好（关=落键 0 / 开=移除）+ 容忍带滑条 disabled 联动", () => {
    const r = rig();
    const check = input(r, "[data-gate-voice-check]");
    const tol = input(r, "[data-gate-tolerance]");
    expect(tol.disabled).toBe(false);
    fireEvent.click(check);
    expect(localStorage.getItem("helix.voice.voiceCheck")).toBe("0");
    expect(tol.disabled).toBe(true);
    fireEvent.click(check);
    expect(localStorage.getItem("helix.voice.voiceCheck")).toBeNull();
    expect(tol.disabled).toBe(false);
  });

  it("文案键齐备（i18n 双语）：zh/en 词条都有插话检测组全键且非空；界面渲染真文案非裸 key", () => {
    const r = rig();
    for (const dict of [zhCN, enUS]) {
      const gate = dict.chat.settings.voice.gate;
      for (const v of [gate.note, gate.sensitivity, gate.minDuration, gate.silenceWindow, gate.voiceCheck, gate.tolerance, gate.hint]) {
        expect(v.length).toBeGreaterThan(0);
      }
      expect(dict.chat.settings.voice.groupGate.length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/插话检测/)).toBeTruthy();
    expect(screen.getByText("最短发声时长", { selector: "label" })).toBeTruthy();
    expect(r.container.textContent).not.toContain("chat.settings.voice.gate");
  });
});

// ── ASR/TTS 模型配置组（模型配置接入 P0）────────────────────────
describe("VoiceSettingsSection 模型配置组（config.get/set_voice_models）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    mockAuth = {};
    mockVoiceModels = null;
    vi.clearAllMocks();
    setVoiceModelConfig.mockImplementation(() => true);
  });

  const rig = () =>
    render(
      <I18nProvider>
        <ToastProvider>
          <VoiceSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );

  it("进入分区拉取一次；未请求态输入为空 + placeholder = 默认值", () => {
    const r = rig();
    expect(requestVoiceModelConfig).toHaveBeenCalled();
    const input = r.container.querySelector('[data-voice-model="sttModel"]') as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("qwen-audio-3.0-asr-flash");
    expect(r.container.textContent).toContain("转写/合成模型");
  });

  it("帧驱动回填不乐观：voiceModels 现态落入输入框", () => {
    mockVoiceModels = {
      sttModel: "custom-asr-v2",
      sttSiliconflowModel: "FunAudioLLM/SenseVoiceSmall",
      sttRealtimeModel: "qwen3-asr-flash-realtime",
      ttsModel: "qwen3-tts-flash",
      ttsStreamModel: "qwen-audio-3.0-tts-flash",
    };
    const r = rig();
    expect((r.container.querySelector('[data-voice-model="sttModel"]') as HTMLInputElement).value).toBe("custom-asr-v2");
    expect((r.container.querySelector('[data-voice-model="ttsModel"]') as HTMLInputElement).value).toBe("qwen3-tts-flash");
  });

  it("保存只发改动项（未改动字段不携带）", () => {
    mockVoiceModels = {
      sttModel: "custom-asr-v2",
      sttSiliconflowModel: "FunAudioLLM/SenseVoiceSmall",
      sttRealtimeModel: "qwen3-asr-flash-realtime",
      ttsModel: "qwen3-tts-flash",
      ttsStreamModel: "qwen-audio-3.0-tts-flash",
    };
    const r = rig();
    const input = r.container.querySelector('[data-voice-model="sttModel"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "another-asr" } });
    fireEvent.click(r.container.querySelector("[data-voice-models-save]") as HTMLButtonElement);
    expect(setVoiceModelConfig).toHaveBeenCalledTimes(1);
    expect(setVoiceModelConfig.mock.calls[0]![0]).toEqual({ sttModel: "another-asr" });
  });

  it("无改动点保存 → 不发（空 patch 零请求）", () => {
    mockVoiceModels = {
      sttModel: "custom-asr-v2",
      sttSiliconflowModel: "FunAudioLLM/SenseVoiceSmall",
      sttRealtimeModel: "qwen3-asr-flash-realtime",
      ttsModel: "qwen3-tts-flash",
      ttsStreamModel: "qwen-audio-3.0-tts-flash",
    };
    const r = rig();
    fireEvent.click(r.container.querySelector("[data-voice-models-save]") as HTMLButtonElement);
    expect(setVoiceModelConfig).not.toHaveBeenCalled();
  });

  it("清空字段保存 = 发空串（回落默认协议语义）", () => {
    mockVoiceModels = {
      sttModel: "custom-asr-v2",
      sttSiliconflowModel: "FunAudioLLM/SenseVoiceSmall",
      sttRealtimeModel: "qwen3-asr-flash-realtime",
      ttsModel: "qwen3-tts-flash",
      ttsStreamModel: "qwen-audio-3.0-tts-flash",
    };
    const r = rig();
    fireEvent.change(r.container.querySelector('[data-voice-model="sttModel"]') as HTMLInputElement, { target: { value: "" } });
    fireEvent.click(r.container.querySelector("[data-voice-models-save]") as HTMLButtonElement);
    expect(setVoiceModelConfig.mock.calls[0]![0]).toEqual({ sttModel: "" });
  });

  it("恢复默认：五槽位全量空串", () => {
    const r = rig();
    fireEvent.click(r.container.querySelector("[data-voice-models-reset]") as HTMLButtonElement);
    expect(setVoiceModelConfig.mock.calls[0]![0]).toEqual({
      sttModel: "",
      sttSiliconflowModel: "",
      sttRealtimeModel: "",
      ttsModel: "",
      ttsStreamModel: "",
    });
  });

  it("脏态门控（M46）：编辑中回执到达不覆写草稿；保存后回执落值并清脏（后续回执再同步）", () => {
    const base = {
      sttModel: "custom-asr-v2",
      sttSiliconflowModel: "FunAudioLLM/SenseVoiceSmall",
      sttRealtimeModel: "qwen3-asr-flash-realtime",
      ttsModel: "qwen3-tts-flash",
      ttsStreamModel: "qwen-audio-3.0-tts-flash",
    };
    mockVoiceModels = { ...base };
    const r = rig();
    const stt = () => r.container.querySelector('[data-voice-model="sttModel"]') as HTMLInputElement;
    const tts = () => r.container.querySelector('[data-voice-model="ttsModel"]') as HTMLInputElement;
    fireEvent.change(stt(), { target: { value: "typing-asr" } });
    // 用户编辑期间他处触发的回执到达：不得吞掉用户草稿
    mockVoiceModels = { ...base, ttsModel: "server-tts" };
    r.rerender(
      <I18nProvider>
        <ToastProvider>
          <VoiceSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(stt().value).toBe("typing-asr");
    // 保存 → 在途 → 回执兑现（落值 + 清脏）
    fireEvent.click(r.container.querySelector("[data-voice-models-save]") as HTMLButtonElement);
    mockVoiceModels = { ...base, sttModel: "typing-asr", ttsModel: "server-tts" };
    r.rerender(
      <I18nProvider>
        <ToastProvider>
          <VoiceSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(stt().value).toBe("typing-asr");
    // 脏态已清：后续他处回执照常回填
    mockVoiceModels = { ...base, sttModel: "typing-asr", ttsModel: "external-tts" };
    r.rerender(
      <I18nProvider>
        <ToastProvider>
          <VoiceSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(tts().value).toBe("external-tts");
  });

  it("保存未发出（send false）→ toast 行内交代（TR-168）", () => {
    setVoiceModelConfig.mockImplementation(() => false);
    const r = rig();
    fireEvent.change(r.container.querySelector('[data-voice-model="ttsModel"]') as HTMLInputElement, { target: { value: "x" } });
    fireEvent.click(r.container.querySelector("[data-voice-models-save]") as HTMLButtonElement);
    expect(r.container.textContent).toContain("保存未发出");
  });
});
