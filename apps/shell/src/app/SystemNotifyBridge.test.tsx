// @vitest-environment jsdom
/**
 * 系统通知分流桥（SystemNotifyBridge）接线测试（P0）：
 * - steward.notify：窗口后台 → 系统通知；窗口前台 → 不发（toast 路径不变）；
 * - chat.turn.completed：仅「会话在后台 ∧ 窗口不在前台」发（标题=会话名，
 *   正文=固定白话标签，不杜撰帧内内容）；
 * - 设置关 → 整体短路；60s 同内容去重窗；urgency=high 直发；
 * - 无原生能力挂载点（纯浏览器 dev）→ 静默不调用（零形态分支）。
 *
 * useSession / native-capability 均以替身注入（StewardNotifyToast.test.tsx /
 * native-capability 消费面先例）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { EventEnvelope } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

const nativeSystemNotify = vi.fn(async (_title: string, _body: string) => {});
let nativeCapable = true;

vi.mock("@/shared/api/native-capability", () => ({
  hasSystemNotify: () => nativeCapable,
  nativeSystemNotify: (title: string, body: string) => nativeSystemNotify(title, body),
}));

type Listener = (e: EventEnvelope) => void;
const stewardListeners = new Set<Listener>();
const turnListeners = new Set<Listener>();

/** 拓扑替身：引用稳定 + 内部 map 原地变更（组件在事件时点按引用读）。 */
const topology: { background: Record<string, { title: string }> } = { background: {} };

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology,
    subscribeStewardFrames: (l: Listener) => {
      stewardListeners.add(l);
      return () => stewardListeners.delete(l);
    },
    subscribeChatTurnFrames: (l: Listener) => {
      turnListeners.add(l);
      return () => turnListeners.delete(l);
    },
  }),
}));

import { I18nProvider } from "@/shared/i18n";
import SystemNotifyBridge from "@/app/SystemNotifyBridge";

function frame(type: string, payload: Record<string, unknown>, sessionId = "__system__"): EventEnvelope {
  return { v: PROTOCOL_VERSION, sessionId, type, ts: 1, payload } as unknown as EventEnvelope;
}

function emitSteward(payload: Record<string, unknown>) {
  act(() => {
    for (const l of stewardListeners) l(frame("steward.notify", payload));
  });
}

function emitTurn(sessionId: string, payload: Record<string, unknown> = { turnId: "t1", reason: "completed" }) {
  act(() => {
    for (const l of turnListeners) l(frame("chat.turn.completed", payload, sessionId));
  });
}

const ui = () =>
  render(
    <I18nProvider>
      <SystemNotifyBridge />
    </I18nProvider>,
  );

/** 窗口失焦（后台）——jsdom 缺省 hasFocus()=true。 */
const setBackground = (background: boolean) => {
  vi.spyOn(document, "hasFocus").mockReturnValue(!background);
};

describe("SystemNotifyBridge：steward.notify 面", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    nativeSystemNotify.mockClear();
    nativeCapable = true;
    topology.background = {};
    setBackground(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    stewardListeners.clear();
    turnListeners.clear();
  });

  it("窗口后台 → 透传 daemon title/body 发系统通知（前端零二次生成）", () => {
    ui();
    emitSteward({ urgency: "normal", title: "任务完成", body: "整理完了", seq: 1 });
    expect(nativeSystemNotify).toHaveBeenCalledTimes(1);
    expect(nativeSystemNotify).toHaveBeenCalledWith("任务完成", "整理完了");
  });

  it("窗口前台 → 不发（前台 toast 路径维持现状）", () => {
    setBackground(false);
    ui();
    emitSteward({ urgency: "normal", title: "任务完成", body: "整理完了", seq: 1 });
    expect(nativeSystemNotify).not.toHaveBeenCalled();
  });

  it("设置关 → 整体短路（含 high）", () => {
    localStorage.setItem("helix.notify.system", "0");
    ui();
    emitSteward({ urgency: "high", title: "任务失败", body: "没跑成", seq: 1 });
    expect(nativeSystemNotify).not.toHaveBeenCalled();
  });

  it("60s 同内容去重：窗内重复丢弃，不同内容照发", () => {
    ui();
    emitSteward({ urgency: "normal", title: "任务完成", body: "整理完了", seq: 1 });
    emitSteward({ urgency: "normal", title: "任务完成", body: "整理完了", seq: 2 });
    expect(nativeSystemNotify).toHaveBeenCalledTimes(1);
    emitSteward({ urgency: "normal", title: "任务完成", body: "另一件事", seq: 3 });
    expect(nativeSystemNotify).toHaveBeenCalledTimes(2);
  });

  it("urgency 分流：high 直发（同内容不被去重窗压）", () => {
    ui();
    emitSteward({ urgency: "high", title: "任务失败", body: "没跑成", seq: 1 });
    emitSteward({ urgency: "high", title: "任务失败", body: "没跑成", seq: 2 });
    expect(nativeSystemNotify).toHaveBeenCalledTimes(2);
  });

  it("title/body 非 string 或空 → 不发（CoordNoticeToast 同款守卫）", () => {
    ui();
    emitSteward({ urgency: "normal", title: "", body: "整理完了", seq: 1 });
    emitSteward({ urgency: "normal", title: "任务完成", body: undefined, seq: 2 });
    expect(nativeSystemNotify).not.toHaveBeenCalled();
  });

  it("无原生能力挂载点（纯浏览器 dev）→ 静默不调用", () => {
    nativeCapable = false;
    ui();
    emitSteward({ urgency: "normal", title: "任务完成", body: "整理完了", seq: 1 });
    expect(nativeSystemNotify).not.toHaveBeenCalled();
  });
});

describe("SystemNotifyBridge：chat.turn.completed 面", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    nativeSystemNotify.mockClear();
    nativeCapable = true;
    topology.background = { "s-bg": { title: "重构登录" } };
    setBackground(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    stewardListeners.clear();
    turnListeners.clear();
  });

  it("后台会话轮次结束 → 标题=会话名，正文=固定白话标签（不杜撰帧内内容）", () => {
    ui();
    emitTurn("s-bg");
    expect(nativeSystemNotify).toHaveBeenCalledTimes(1);
    expect(nativeSystemNotify).toHaveBeenCalledWith("重构登录", "回完了");
  });

  it("活跃（前台）会话轮次结束 → 不发（用户正看着这条会话）", () => {
    ui();
    emitTurn("s-active");
    expect(nativeSystemNotify).not.toHaveBeenCalled();
  });

  it("窗口前台 → 后台会话也不发", () => {
    setBackground(false);
    ui();
    emitTurn("s-bg");
    expect(nativeSystemNotify).not.toHaveBeenCalled();
  });

  it("设置关 → 不发", () => {
    localStorage.setItem("helix.notify.system", "0");
    ui();
    emitTurn("s-bg");
    expect(nativeSystemNotify).not.toHaveBeenCalled();
  });
});

describe("SystemNotifyBridge：voiceCovered 语音覆盖（§17.41——管家语音会播时跳过系统通知）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    nativeSystemNotify.mockClear();
    nativeCapable = true;
    topology.background = {};
    setBackground(true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    stewardListeners.clear();
    turnListeners.clear();
  });

  it("steward.notify voiceCovered=true → 后台也不发系统通知（语音已触达）", () => {
    ui();
    emitSteward({ urgency: "normal", title: "任务完成", body: "整理完了", voiceCovered: true, seq: 1 });
    expect(nativeSystemNotify).not.toHaveBeenCalled();
  });

  it("voiceCovered=false → 照发（语音不会响，通知是唯一触达）", () => {
    ui();
    emitSteward({ urgency: "normal", title: "任务完成", body: "整理完了", voiceCovered: false, seq: 2 });
    expect(nativeSystemNotify).toHaveBeenCalledTimes(1);
  });

  it("旧 daemon 缺省字段 → 照发（additive 零破坏）", () => {
    ui();
    emitSteward({ urgency: "normal", title: "任务完成", body: "整理完了", seq: 3 });
    expect(nativeSystemNotify).toHaveBeenCalledTimes(1);
  });
});
