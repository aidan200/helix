// @vitest-environment jsdom
/**
 * Composer 输入区改造测试（T8：Alt+Enter 发送 / Enter 换行 / 停止钮 / 脚注）。
 *
 * - input → textarea：rows=1 多行载体；Enter 原生换行（不 preventDefault、
 *   不发送），Alt+Enter（mac Option 同位）preventDefault + 发送；
 * - Shift+Enter / Cmd+Enter 保持原生（无自定义语义）；
 * - 纯空白（含换行）草稿不发送（发送前 trim 门控）；
 * - 停止钮（#btn-abort）：恒渲染不按态卸载（T7 焦点守恒先例），仅
 *   runState === "streaming"（main 生成中）可用；idle / subagent_running
 *   （main 空闲，chat.abort 只中断 main）禁用；点击调 abort()；
 *   abort 后 agent.state.changed idle 归位 → 钮回禁用；
 * - 脚注：projectionNote 整行移除；enterHint 新文案 kbd 双键帽。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "@/entities/session/model/session-reducer";
import { selectActiveRunState } from "@/entities/session/model/topology";

const setDraft = vi.fn();
const submit = vi.fn();
const abort = vi.fn();
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      setDraft,
      submit,
      abort,
    }),
  };
});

import Composer from "./Composer";

function play(events: SessionAction[]): SessionState {
  return events.reduce(sessionReducer, createInitialSessionState());
}

const ev = (event: EventEnvelope): SessionAction => ({ type: "event", event });

/** connected + ready 基态（welcome 即就绪可发，P-1s 两阶段）。 */
function connectedReady(extra: SessionAction[] = []): SessionState {
  return play([
    ev({
      v: 0,
      type: "connection.welcome",
      payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
    }),
    ...extra,
  ]);
}

const draft = (text: string): SessionAction => ({ type: "ui/set-draft", text });

function ui() {
  return render(
    <I18nProvider>
      <Composer />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("T8 · Alt+Enter 发送 / Enter 换行（textarea 化）", () => {
  it("载体为 textarea（rows=1），多行草稿经 onChange 透传 setDraft", () => {
    stateRef.current = connectedReady();
    ui();
    const ta = document.querySelector("#msg-input")!;
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.getAttribute("rows")).toBe("1");
    fireEvent.change(ta, { target: { value: "line1\nline2\nline3" } });
    expect(setDraft).toHaveBeenCalledWith("line1\nline2\nline3");
  });

  it("Enter 原生换行：不 preventDefault、不发送（Shift/Cmd+Enter 同保持原生）", () => {
    stateRef.current = connectedReady([draft("你好")]);
    ui();
    const ta = document.querySelector("#msg-input")! as HTMLTextAreaElement;
    // fireEvent 返回 false = 事件被 preventDefault 取消；native Enter 不应取消
    expect(fireEvent.keyDown(ta, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(ta, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(ta, { key: "Enter", metaKey: true })).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("Alt+Enter 发送（preventDefault + submit 草稿原文）", () => {
    stateRef.current = connectedReady([draft("多行\n消息")]);
    ui();
    const ta = document.querySelector("#msg-input")!;
    expect(fireEvent.keyDown(ta, { key: "Enter", altKey: true })).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("多行\n消息");
  });

  it("纯空白草稿（含换行）Alt+Enter 不发送", () => {
    stateRef.current = connectedReady([draft("  \n \n  ")]);
    ui();
    const ta = document.querySelector("#msg-input")!;
    fireEvent.keyDown(ta, { key: "Enter", altKey: true });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("T8 · 停止钮（#btn-abort，main session 生成中断）", () => {
  it("streaming 态（agent.state.changed running）可用；点击调 abort()", () => {
    stateRef.current = connectedReady([
      ev({ v: 0, type: "agent.state.changed", payload: { state: "running" } }),
    ]);
    expect(selectActiveRunState(stateRef.current)).toBe("streaming");
    ui();
    const btn = document.querySelector("#btn-abort") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("idle 态恒渲染但禁用（焦点守恒，T7 先例）；点击不触发 abort", () => {
    stateRef.current = connectedReady();
    expect(selectActiveRunState(stateRef.current)).toBe("idle");
    ui();
    const btn = document.querySelector("#btn-abort") as HTMLButtonElement;
    expect(btn).not.toBeNull(); // 不按态卸载
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(abort).not.toHaveBeenCalled();
  });

  it("subagent_running 态（main 空闲，chat.abort 只中断 main）禁用", () => {
    stateRef.current = connectedReady([
      ev({
        v: 0,
        type: "agent.spawned",
        payload: { agentId: "agent-9", task: "后台任务", profileKind: "subagent-worker" },
      }),
    ]);
    expect(selectActiveRunState(stateRef.current)).toBe("subagent_running");
    ui();
    const btn = document.querySelector("#btn-abort") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("abort 后状态归位：agent.state.changed idle 到达 → runState 回 idle，钮回禁用", () => {
    // 生成中（streaming，钮可用）点击 abort → daemon 回 agent.state.changed
    // idle 收口 → 前端状态机归位驱动钮回禁用（无「停在可用态」缺口）
    stateRef.current = connectedReady([
      ev({ v: 0, type: "agent.state.changed", payload: { state: "running" } }),
    ]);
    const { rerender } = ui();
    expect((document.querySelector("#btn-abort") as HTMLButtonElement).disabled).toBe(false);
    stateRef.current = sessionReducer(stateRef.current, ev({
      v: 0,
      type: "agent.state.changed",
      payload: { state: "idle" },
    }));
    expect(selectActiveRunState(stateRef.current)).toBe("idle");
    rerender(
      <I18nProvider>
        <Composer />
      </I18nProvider>,
    );
    expect((document.querySelector("#btn-abort") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("T8 · 脚注文案（projectionNote 退役 / enterHint 新快捷键语义）", () => {
  it("projectionNote 整行移除：无「main-session · 会话投影」文案", () => {
    stateRef.current = connectedReady();
    ui();
    expect(document.body.textContent).not.toContain("main-session");
    expect(document.body.textContent).not.toContain("会话投影");
  });

  it("enterHint 新文案：Alt+Enter 发送 · Enter 换行（kbd 双键帽）", () => {
    stateRef.current = connectedReady();
    ui();
    const foot = document.querySelector(".composer-foot")!;
    expect(foot.textContent).toBe("Alt+Enter 发送 · Enter 换行");
    const kbds = Array.from(foot.querySelectorAll(".kbd"));
    expect(kbds.map((k) => k.textContent)).toEqual(["Alt+Enter", "Enter"]);
  });
});
