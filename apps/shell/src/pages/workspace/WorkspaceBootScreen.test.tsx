// @vitest-environment jsdom
/**
 * WorkspaceBootScreen 组件测试（W3 门禁 connecting 占位；brief 任务 2）。
 *
 * conn 三形态：connecting/disconnected → 轻量加载占位（pulse dot + 文案）；
 * error（gave-up）→ 连接失败占位（err-icon/hud-btn 既有视觉语言）+ 重试
 * 钮（useSession().retry——SM-2 手动重试路径）。复用既有加载/连接类 UI
 * 风格，不新造视觉体系。
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
  it("connecting/disconnected → 轻量加载占位（pulse dot + 连接文案，无交互件）", () => {
    conn = "connecting";
    ui();
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    expect(el.querySelector(".hud-dot-pulse")).not.toBeNull();
    expect(el.textContent).toContain("正在连接 daemon");
    expect(document.querySelector("button")).toBeNull();
    conn = "disconnected";
    cleanup();
    ui();
    expect(document.querySelector('[data-wsgate-boot="connecting"]')).not.toBeNull();
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
