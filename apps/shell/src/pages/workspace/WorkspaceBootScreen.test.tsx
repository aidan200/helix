// @vitest-environment jsdom
/**
 * WorkspaceBootScreen 组件测试（W3 门禁 connecting 占位；W6b 终端化改版；
 * W6o 双形态）。
 *
 * 形态（W6o）：full（首启）= 完整 16 行序列（前 15 行装饰文案/--d 与
 * index.html 静态序列逐行同源对齐，硬编码英文梗不走 i18n）+ 末行为活状态
 * （正在连接（第 N 次尝试）/ 重连中 + 光标，i18n 键）；status（会话中重连）
 * = 仅活状态行 + 光标（现行为）。conn 三形态：connecting/disconnected →
 * 终端启动屏（复用 index.html 持久类族 .app-boot-loader/.boot-term/.bl +
 * 方块光标 .boot-cursor）；error（gave-up）→ 连接失败占位
 * （err-icon/hud-btn 既有视觉语言）+ 重试钮（useSession().retry——
 * SM-2 手动重试路径）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";

let conn = "connecting";
let connAttempts = 1;
let retries = 0;
const retryFn = (): void => {
  retries += 1;
};

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({ state: { conn, connAttempts }, retry: retryFn }),
}));

import WorkspaceBootScreen, { type WorkspaceBootVariant } from "./WorkspaceBootScreen";

function ui(variant: WorkspaceBootVariant = "status") {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <WorkspaceBootScreen variant={variant} />
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);
localStorage.setItem("helix-lang", "zh-CN");

/** 行内 --d 延迟（与 index.html 静态序列节奏对齐断言用）。 */
const delayOf = (el: Element) => (el as HTMLElement).style.getPropertyValue("--d");

describe("status 形态（会话中重连：仅活状态行）", () => {
  it("connecting → 终端启动屏（boot 类族 + 连接文案 + 方块光标，无交互件）", () => {
    conn = "connecting";
    connAttempts = 1;
    ui("status");
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    // 复用 index.html 持久类族（同视觉语言，零重复 CSS）
    expect(el.classList.contains("app-boot-loader")).toBe(true);
    expect(el.querySelector(".boot-term")).not.toBeNull();
    expect(el.querySelectorAll(".bl")).toHaveLength(1);
    expect(el.querySelector(".boot-cursor")).not.toBeNull();
    expect(el.textContent).toContain("正在连接 daemon");
    expect(document.querySelector("button")).toBeNull();
  });

  it("connecting 第 2 次尝试 → 活状态行附「第 2 次尝试」（chat.banner 键复用）", () => {
    conn = "connecting";
    connAttempts = 2;
    ui("status");
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    expect(el.querySelectorAll(".bl")).toHaveLength(1);
    expect(el.textContent).toContain("正在连接 daemon…（第 2 次尝试）");
  });

  it("disconnected → 追加自动重连状态行（光标随末行）", () => {
    conn = "disconnected";
    connAttempts = 1;
    ui("status");
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    const lines = el.querySelectorAll(".bl");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain("正在连接 daemon");
    expect(lines[1]!.textContent).toContain("连接中断，自动重连中");
    expect(lines[0]!.querySelector(".boot-cursor")).toBeNull();
    expect(lines[1]!.querySelector(".boot-cursor")).not.toBeNull();
  });
});

describe("full 形态（首启：完整 16 行序列 + 末行活状态）", () => {
  it("connecting → 16 行 .bl：前 15 行装饰（文案/--d 对齐 index.html）+ 末行活状态 + 光标", () => {
    conn = "connecting";
    connAttempts = 1;
    ui("full");
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    expect(el.querySelector(".boot-term")).not.toBeNull();
    const lines = el.querySelectorAll(".bl");
    expect(lines).toHaveLength(16);
    // 装饰行抽样：首行/末装饰行文案与 --d 节奏与 index.html 逐行同源
    expect(lines[0]!.textContent).toContain("helix v2 — boot sequence");
    expect(delayOf(lines[0]!)).toBe("0.10s");
    expect(lines[7]!.textContent).toContain("npm install motivation");
    expect(lines[7]!.querySelector("b.err")!.textContent).toBe("404");
    expect(lines[14]!.textContent).toContain("all systems nominal");
    expect(delayOf(lines[14]!)).toBe("1.22s");
    // 末行 = 活状态（i18n）+ 光标，--d 对齐 index.html 第 16 行节奏
    expect(lines[15]!.textContent).toContain("正在连接 daemon");
    expect(delayOf(lines[15]!)).toBe("1.30s");
    expect(lines[15]!.querySelector(".boot-cursor")).not.toBeNull();
    expect(document.querySelector("button")).toBeNull();
  });

  it("connecting 第 3 次尝试 → 末行活状态附「第 3 次尝试」（仍 16 行）", () => {
    conn = "connecting";
    connAttempts = 3;
    ui("full");
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    expect(el.querySelectorAll(".bl")).toHaveLength(16);
    expect(el.querySelectorAll(".bl")[15]!.textContent).toContain("正在连接 daemon…（第 3 次尝试）");
  });

  it("disconnected → 末行活状态切换为重连中（仍 16 行，装饰序列不重播）", () => {
    conn = "disconnected";
    connAttempts = 1;
    ui("full");
    const el = document.querySelector('[data-wsgate-boot="connecting"]')!;
    const lines = el.querySelectorAll(".bl");
    expect(lines).toHaveLength(16);
    expect(lines[15]!.textContent).toContain("连接中断，自动重连中");
    expect(lines[15]!.querySelector(".boot-cursor")).not.toBeNull();
  });
});

describe("conn=error（gave-up，形态无关）", () => {
  it("→ 连接失败占位 + 重试钮（retry 调用）", () => {
    conn = "error";
    connAttempts = 3;
    ui("full");
    const el = document.querySelector('[data-wsgate-boot="error"]')!;
    expect(el.textContent).toContain("无法连接 daemon");
    fireEvent.click(el.querySelector("button")!);
    expect(retries).toBe(1);
  });
});
