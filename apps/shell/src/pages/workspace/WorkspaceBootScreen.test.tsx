// @vitest-environment jsdom
/**
 * WorkspaceBootScreen 组件测试（W3 门禁 connecting 占位；W6b 终端化改版）。
 *
 * conn 三形态：connecting/disconnected → 终端启动屏（复用 index.html 持久
 * 类族 .app-boot-loader/.boot-term/.bl + 方块光标 .boot-cursor，内容为真实
 * 连接态）；disconnected 追加自动重连状态行；error（gave-up）→ 连接失败
 * 占位（err-icon/hud-btn 既有视觉语言）+ 重试钮（useSession().retry——
 * SM-2 手动重试路径）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";

let conn = "connecting";
let retries = 0;
const retryFn = (): void => {
  retries += 1;
};

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({ state: { conn }, retry: retryFn }),
}));

import WorkspaceBootScreen from "./WorkspaceBootScreen";

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <WorkspaceBootScreen />
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);
localStorage.setItem("helix-lang", "zh-CN");

describe("WorkspaceBootScreen（connecting 占位）", () => {
  it("connecting → 终端启动屏（boot 类族 + 连接文案 + 方块光标，无交互件）", () => {
    conn = "connecting";
    ui();
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    // 复用 index.html 持久类族（同视觉语言，零重复 CSS）
    expect(el.classList.contains("app-boot-loader")).toBe(true);
    expect(el.querySelector(".boot-term")).not.toBeNull();
    expect(el.querySelectorAll(".bl")).toHaveLength(1);
    expect(el.querySelector(".boot-cursor")).not.toBeNull();
    expect(el.textContent).toContain("正在连接 daemon");
    expect(document.querySelector("button")).toBeNull();
  });

  it("disconnected → 追加自动重连状态行（光标随末行）", () => {
    conn = "disconnected";
    ui();
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    const lines = el.querySelectorAll(".bl");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain("正在连接 daemon");
    expect(lines[1]!.textContent).toContain("连接中断，自动重连中");
    expect(lines[0]!.querySelector(".boot-cursor")).toBeNull();
    expect(lines[1]!.querySelector(".boot-cursor")).not.toBeNull();
  });

  it("conn=error（gave-up）→ 连接失败占位 + 重试钮（retry 调用）", () => {
    conn = "error";
    ui();
    const el = document.querySelector('[data-wsgate-boot="error"]')!;
    expect(el.textContent).toContain("无法连接 daemon");
    fireEvent.click(el.querySelector("button")!);
    expect(retries).toBe(1);
  });
});
