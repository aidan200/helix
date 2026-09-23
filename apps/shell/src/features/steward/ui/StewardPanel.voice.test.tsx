// @vitest-environment jsdom
/**
 * StewardPanel 语音模式面测试（V3a；useStewardVoice 整面 mock——状态机本体
 * 归 useStewardVoice.test，本文件只钉面板接线与渲染面；Composer.voice.test
 * 先例同构）。
 *
 * - 打开默认语音模式：mic 面渲染、文本输入面不渲染（双模互斥）；mode 钮
 *   aria-pressed 互斥；
 * - 切文本模式：输入面出现、mic 面消失；
 * - 波形可视化：voice 容器 data-phase 反映 phase；listening 态 mic 按钮
 *   在录点击 → stopListening；
 * - 静音钮：speaking 态可见、点击 → stopSpeaking；非 speaking 不渲染；
 * - 阶段文案：phase caption 随 phase 切换；idle 显示引导 hint。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { UseStewardVoice } from "../model/useStewardVoice";
import type { StewardInputMode, StewardVoicePhase } from "../model/steward-voice-machine";

const startListening = vi.fn(async () => undefined);
const stopListening = vi.fn();
const stopSpeaking = vi.fn();
const setMode = vi.fn();
const ask = vi.fn(() => true);
const confirmPending = vi.fn(() => true);
const dismissPending = vi.fn();
const clearVoiceDraft = vi.fn();

let mode: StewardInputMode = "voice";
let phase: StewardVoicePhase = "idle";
/** useStewardVoice 收到的 open 入参（面板活跃态接线钉——A 修复：active 透传）。 */
let hookOpenCalls: boolean[] = [];
let level = 0;
let speaking = false;
let voiceError: string | null = null;
let interim: string | null = null;
let streamDegraded = false;

vi.mock("../model/useStewardVoice", () => ({
  useStewardVoice: (open: boolean): UseStewardVoice => {
    hookOpenCalls.push(open);
    return (
      ({
      items: [],
      streamingText: null,
      pending: null,
      feed: [],
      askInFlight: false,
      config: { enabled: true, model: "x/y" },
      ask,
      confirmPending,
      dismissPending,
      mode,
      setMode: (m: StewardInputMode) => {
        mode = m;
        setMode(m);
      },
      phase,
      level,
      interim,
      streamDegraded,
      speaking,
      voiceError,
      voiceDraft: null,
      startListening,
      stopListening,
      stopSpeaking,
      clearVoiceDraft,
    }) as unknown as UseStewardVoice);
  },
}));

import StewardPanel from "./StewardPanel";

// jsdom navigator.language 默认 en-US：钉 zh-CN（AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

function renderPanel(opts?: { active?: boolean }) {
  return render(
    <I18nProvider>
      <StewardPanel onClose={() => undefined} active={opts?.active} />
    </I18nProvider>,
  );
}

describe("StewardPanel 语音模式面（V3a）", () => {
  beforeEach(() => {
    interim = null;
    streamDegraded = false;
    mode = "voice";
    phase = "idle";
    level = 0;
    speaking = false;
    voiceError = null;
    hookOpenCalls = [];
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("active 透传 hook：active=false 时 useStewardVoice 收 open=false（面板隐藏期耳麦关）；默认收 true", async () => {
    renderPanel({ active: false });
    await waitFor(() => expect(hookOpenCalls.length).toBeGreaterThan(0));
    expect(hookOpenCalls.every((v) => v === false)).toBe(true);

    cleanup();
    hookOpenCalls = [];
    renderPanel();
    await waitFor(() => expect(hookOpenCalls.length).toBeGreaterThan(0));
    expect(hookOpenCalls.every((v) => v === true)).toBe(true);
  });

  it("打开默认语音模式：mic 面在、文本输入面不在（双模互斥）；mode 钮 aria-pressed 互斥", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-mic")).toBeTruthy());
    expect(screen.queryByTestId("steward-input")).toBeNull();
    const voiceBtn = screen.getByTestId("steward-mode-voice");
    const textBtn = screen.getByTestId("steward-mode-text");
    expect(voiceBtn.getAttribute("aria-pressed")).toBe("true");
    expect(textBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("切文本模式：输入面出现、mic 面消失", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-mic")).toBeTruthy());
    fireEvent.click(screen.getByTestId("steward-mode-text"));
    expect(setMode).toHaveBeenCalledWith("text");
    mode = "text";
    // mode 已由 mock 侧翻转（受控重渲）：文本面在、mic 面不在
    fireEvent.click(screen.getByTestId("steward-mode-voice")); // 触发一次重渲（mode 已改）
    cleanup();
    mode = "text";
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    expect(screen.queryByTestId("steward-mic")).toBeNull();
  });

  it("波形可视化：voice 容器 data-phase 反映 phase；idle 显示引导 hint；listening 点击 mic → stopListening", async () => {
    phase = "listening";
    level = 0.7;
    renderPanel();
    const voiceFace = await waitFor(() => screen.getByTestId("steward-voice"));
    expect(voiceFace.getAttribute("data-phase")).toBe("listening");
    // 在录点击 mic = 强制停
    fireEvent.click(screen.getByTestId("steward-mic"));
    expect(stopListening).toHaveBeenCalledTimes(1);
    expect(startListening).not.toHaveBeenCalled();
  });

  it("idle 点击 mic → startListening；transcribing/asking 态 mic 禁用", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-mic")).toBeTruthy());
    fireEvent.click(screen.getByTestId("steward-mic"));
    expect(startListening).toHaveBeenCalledTimes(1);

    cleanup();
    vi.clearAllMocks();
    phase = "transcribing";
    renderPanel();
    await waitFor(() => expect((screen.getByTestId("steward-mic") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("steward-voice").getAttribute("data-phase")).toBe("transcribing");

    cleanup();
    vi.clearAllMocks();
    phase = "asking";
    renderPanel();
    await waitFor(() => expect((screen.getByTestId("steward-mic") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("steward-voice-phase").textContent).toBe("思考中…");
  });

  it("静音钮：speaking 态可见、点击 → stopSpeaking；非 speaking 不渲染", async () => {
    speaking = true;
    phase = "speaking";
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-mute")).toBeTruthy());
    expect(screen.getByTestId("steward-voice-phase").textContent).toBe("朗读中…");
    fireEvent.click(screen.getByTestId("steward-mute"));
    expect(stopSpeaking).toHaveBeenCalledTimes(1);

    cleanup();
    vi.clearAllMocks();
    speaking = false;
    phase = "idle";
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-mic")).toBeTruthy());
    expect(screen.queryByTestId("steward-mute")).toBeNull();
  });

  it("idle 阶段文案 + 引导 hint；转写失败错误行内呈现", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-voice-phase").textContent).toBe("点击麦克风，跟管家说话"));
    expect(screen.getByTestId("steward-voice-hint").textContent).toContain("1.8 秒");

    cleanup();
    vi.clearAllMocks();
    voiceError = 'provider "dashscope" 未录入 API key';
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-voice-err").textContent).toContain("API key"));
  });
});

// ── V3b-1 流式面渲染：interim 浮字 + 降级提示 ────────────────────

describe("StewardPanel 耳机提示（B2 随附：扬声器场景一次性明示）", () => {
  beforeEach(() => {
    mode = "voice";
    interim = null;
    streamDegraded = false;
    phase = "idle";
    level = 0;
    speaking = false;
    voiceError = null;
    localStorage.removeItem("helix.steward.headsetHintSeen");
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mode = "voice"; // 模块态复位（防 text 泄漏进后续 describe）
  });

  it("语音模式首次进入一次性明示「戴耳机」；关闭后持久不再现", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-headset-hint")).toBeTruthy());
    fireEvent.click(screen.getByTestId("steward-headset-hint-dismiss"));
    expect(screen.queryByTestId("steward-headset-hint")).toBeNull();
    expect(localStorage.getItem("helix.steward.headsetHintSeen")).toBe("1");
    // 一次性语义：重挂面板不再现（持久 flag 已消费）
    cleanup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-mic")).toBeTruthy());
    expect(screen.queryByTestId("steward-headset-hint")).toBeNull();
  });

  it("文本模式不显示耳机提示（仅语音模式面）", async () => {
    mode = "text";
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    expect(screen.queryByTestId("steward-headset-hint")).toBeNull();
  });
});

describe("StewardPanel 流式转写面（V3b-1）", () => {
  const startListening2 = startListening;
  const stopListening2 = stopListening;

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    interim = null;
    streamDegraded = false;
    phase = "idle";
  });

  it("listening 态 interim 非空 → 浮字呈现（steward-interim）；idle 态不渲染", async () => {
    phase = "listening";
    interim = "帮我把Paraformer";
    render(
      <I18nProvider>
        <StewardPanel onClose={() => undefined} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("steward-interim").textContent).toBe("帮我把Paraformer");
    cleanup();
    phase = "idle";
    interim = "残留文本";
    render(
      <I18nProvider>
        <StewardPanel onClose={() => undefined} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId("steward-interim")).toBeNull(); // 非 listening/transcribing 不渲染
  });

  it("transcribing 态 interim 短暂保留（final 转正前闪现）", async () => {
    phase = "transcribing";
    interim = "终帧前的最后浮字";
    render(
      <I18nProvider>
        <StewardPanel onClose={() => undefined} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("steward-interim").textContent).toBe("终帧前的最后浮字");
  });

  it("streamDegraded + listening → 不显眼降级提示一行（不弹错误卡）", async () => {
    phase = "listening";
    streamDegraded = true;
    render(
      <I18nProvider>
        <StewardPanel onClose={() => undefined} />
      </I18nProvider>,
    );
    const hint = screen.getByTestId("steward-stream-degraded");
    expect(hint.textContent).toContain("整段转写");
  });
});
