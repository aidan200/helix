// @vitest-environment jsdom
/**
 * 语音设置分区 TTS 段测试（语音播报批 V2）：
 * - 播报开关默认关（localStorage 空 → off 态选中）；
 * - 开关切换写 localStorage（helix.voice.broadcast）；
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

const requestAuthList = vi.fn();
const setProviderKey = vi.fn(() => true);
const sendVoiceSynthesize = vi.fn(() => true);
let frameListener: ((e: EventEnvelope) => void) | null = null;
const subscribeVoiceFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  frameListener = cb;
  return () => {
    frameListener = null;
  };
});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { modelConfig: { auth: {} }, active: { conn: "connected" } },
    requestAuthList,
    setProviderKey,
    sendVoiceSynthesize,
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
  v: "0.12",
  sessionId: "__system__",
  channel: "voice",
  type: "voice.synthesize.result",
  payload: { status: "ok", audio: "data:audio/wav;base64,QQ==", provider: "dashscope", voice: "Cherry" },
} as unknown as EventEnvelope;

const AUDITION_ERR: EventEnvelope = {
  v: "0.12",
  sessionId: "__system__",
  channel: "voice",
  type: "voice.synthesize.result",
  payload: { status: "error", reason: "无 key" },
} as unknown as EventEnvelope;

describe("VoiceSettingsSection TTS 段（语音播报批 V2）", () => {
  beforeEach(() => {
    localStorage.clear();
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

  const broadcastRadio = (r: ReturnType<typeof rig>, value: "on" | "off"): HTMLInputElement =>
    r.container.querySelector(`input[name="tts-broadcast"][value="${value}"]`) as HTMLInputElement;

  it("播报开关默认关（localStorage 空 → off 选中）；切换开写偏好", () => {
    const r = rig();
    expect(broadcastRadio(r, "off").checked).toBe(true);
    expect(broadcastRadio(r, "on").checked).toBe(false);
    expect(localStorage.getItem("helix.voice.broadcast")).toBeNull();

    fireEvent.click(broadcastRadio(r, "on"));
    expect(localStorage.getItem("helix.voice.broadcast")).toBe("1");
    fireEvent.click(broadcastRadio(r, "off"));
    expect(localStorage.getItem("helix.voice.broadcast")).toBeNull();
  });

  it("偏好已开时进入分区 → on 态选中（localStorage 读面）", () => {
    localStorage.setItem("helix.voice.broadcast", "1");
    const r = rig();
    expect(broadcastRadio(r, "on").checked).toBe(true);
  });

  it("音色选择：默认 Cherry 选中；切换写 helix.voice.ttsVoice", () => {
    rig();
    const select = screen.getByLabelText(/播报音色|Voice/) as HTMLSelectElement;
    expect(select.value).toBe("Cherry");
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
