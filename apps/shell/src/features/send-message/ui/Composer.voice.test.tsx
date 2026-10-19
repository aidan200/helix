// @vitest-environment jsdom
/**
 * Composer 麦克风钮交互测试（语音输入 V2：点击开始 / 录音中点击强制停 /
 * 三态可视化互斥；实时识别批：interim 灰字镜像层）。useComposerVoice 整面
 * mock（流式接线本体归 useComposerVoice.test——本文件只钉按钮接线、
 * 三态渲染面与镜像层结构）。
 *
 * - 待录：Mic 图标、无电平条；点击 → start()（点击开始，非按住）；
 * - 录音中：电平条渲染（level 驱动 per-bar scale）、recording 类、
 *   aria-label 切录音文案；点击 → stop()（强制停）；
 * - 转写中：spinner、disabled、点击 no-op（三态互斥——start 不再触发）；
 * - unsupported：恒隐藏（既有回归，Composer.test 已覆盖，此处不重复）；
 * - 镜像层（实时识别批）：录音/转写期 msg-interim-layer 同面渲染
 *   「草稿（正常色）+ interim（灰）」、voice-on 隐 textarea 自身文本；
 *   idle 期零镜像层；textarea value 恒为草稿（interim 不入正式输入）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "@/entities/session/model/session-reducer";
import type { EventEnvelope } from "@helix/protocol";
import type { VoiceState } from "@/shared/lib/useVoiceInput";
import type { UseComposerVoice } from "../model/useComposerVoice";

const start = vi.fn(async () => undefined);
const stop = vi.fn();
let voiceState: VoiceState = "idle";
let voiceLevel = 0;
let voiceInterim: string | null = null;
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      topology: {},
      setDraft: vi.fn(),
      submit: vi.fn(() => true),
      abort: vi.fn(),
      attachImages: vi.fn(),
      removeAttachment: vi.fn(),
    }),
  };
});
vi.mock("../model/useComposerVoice", () => ({
  useComposerVoice: (): UseComposerVoice => ({
    state: voiceState,
    level: voiceLevel,
    userSpeaking: false,
    error: null,
    interim: voiceInterim,
    start,
    stop,
  }),
}));

import Composer from "./Composer";

const stateRef: { current: SessionState } = { current: createInitialSessionState() };

function play(events: SessionAction[]): SessionState {
  return events.reduce(sessionReducer, createInitialSessionState());
}

/** connected + ready 基态（welcome 即就绪可发）。 */
beforeEach(() => {
  stateRef.current = play([
    {
      type: "event",
      event: {
        v: 0,
        type: "connection.welcome",
        payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
      } as EventEnvelope,
    },
  ]);
  voiceState = "idle";
  voiceLevel = 0;
  voiceInterim = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mic() {
  return document.querySelector("#btn-mic") as HTMLButtonElement;
}

describe("Composer 麦克风钮（语音输入 V2：点击 + 三态）", () => {
  it("待录：Mic 图标无电平条；点击 → start()（点击开始非按住）", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const btn = mic();
    expect(btn).not.toBeNull();
    expect(btn.querySelector("svg")).not.toBeNull(); // Mic 图标
    expect(btn.querySelector(".mic-level")).toBeNull(); // 无电平条
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(btn);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("录音中：电平条随 level 缩放 + recording 类；点击 → stop()（强制停）", () => {
    voiceState = "recording";
    voiceLevel = 0.6;
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const btn = mic();
    expect(btn.className).toContain("recording");
    const bars = btn.querySelectorAll(".mic-level i");
    expect(bars.length).toBe(5);
    // 电平数据面：容器 --lv3（中条因子 1.0；level 0.6 → 0.2+0.6 = 0.8）
    const meter = btn.querySelector(".mic-level") as HTMLElement;
    expect(meter.style.getPropertyValue("--lv3")).not.toBe("");
    expect(Number(meter.style.getPropertyValue("--lv3"))).toBeGreaterThanOrEqual(0.6);
    expect(screen.queryByTitle("recording", { exact: false })).toBeDefined();
    fireEvent.click(btn);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("转写中：spinner + disabled；点击 no-op（三态互斥）", () => {
    voiceState = "transcribing";
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const btn = mic();
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector(".mic-level")).toBeNull();
    fireEvent.click(btn);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("录音中断连（canSend=false）：mic 钮仍可点击强制停——本地停止动作不依赖连接（中危 F3a）", () => {
    voiceState = "recording";
    // 连接断开（welcome 后 disconnected）：canSend=false——录音中的强制停不押在连接态上
    stateRef.current = sessionReducer(stateRef.current, { type: "conn/disconnected" });
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const btn = mic();
    expect(btn.disabled).toBe(false); // 录音中恒不禁用（旧实现 !canSend 连带禁用 → stop 不可达悬挂录音）
    fireEvent.click(btn);
    expect(stop).toHaveBeenCalledTimes(1);
    // 发送钮仍禁用（canSend 语义不变——仅录音态豁免）
    expect((document.querySelector("#btn-send") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Composer 语音镜像层（实时识别批：interim 灰字上屏）", () => {
  it("录音中：镜像层同面渲染「草稿 + interim」；voice-on 隐 textarea 自身文本；textarea value 恒为草稿", () => {
    voiceState = "recording";
    voiceInterim = "帮我把语音接入";
    stateRef.current = { ...stateRef.current, draft: "已有草稿：" };
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const wrap = document.querySelector(".msg-input-wrap") as HTMLElement;
    expect(wrap.className).toContain("voice-on");
    const layer = document.querySelector(".msg-interim-layer") as HTMLElement;
    expect(layer).not.toBeNull();
    expect(layer.textContent).toBe("已有草稿：帮我把语音接入");
    // interim 独立灰字 span（正常色草稿 + 灰色临时文本同面）
    const interimSpan = layer.querySelector(".interim") as HTMLElement;
    expect(interimSpan.textContent).toBe("帮我把语音接入");
    // textarea 正式输入面零污染：interim 不入 value（final 才回填）
    const ta = document.querySelector("#msg-input") as HTMLTextAreaElement;
    expect(ta.value).toBe("已有草稿：");
  });

  it("草稿空：镜像层仅 interim（灰字占位，无前缀）", () => {
    voiceState = "recording";
    voiceInterim = "开口第一句";
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const layer = document.querySelector(".msg-interim-layer") as HTMLElement;
    expect(layer.textContent).toBe("开口第一句");
    expect((document.querySelector("#msg-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("转写中：镜像层保留（final 回填前闪现不闪断）", () => {
    voiceState = "transcribing";
    voiceInterim = "等终帧文本";
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(document.querySelector(".msg-interim-layer")).not.toBeNull();
  });

  it("idle：零镜像层零 voice-on（final 已回填草稿，灰字让位正式文本）", () => {
    voiceState = "idle";
    voiceInterim = null;
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const wrap = document.querySelector(".msg-input-wrap") as HTMLElement;
    expect(wrap.className).not.toContain("voice-on");
    expect(document.querySelector(".msg-interim-layer")).toBeNull();
  });
});
