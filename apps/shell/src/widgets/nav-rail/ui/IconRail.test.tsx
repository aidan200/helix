// @vitest-environment jsdom
/**
 * S1 IconRail 改造契约（用户裁决：logo 换 chat header 同款 HelixLogo；
 * 主题切换单钮置 rail-avatar 上方，太阳/月亮显示切换目标）。
 *
 * T4 联网状态钮（契约 v0.7 web 族）：主题钮上方联网图标——三态
 *（灰 idle/未连接 → 绿 connected → 红 error）+ 点击 popover（连接详情
 * + tab 清单 + 停止并清理）。
 *
 * T7 显式启动通路（契约 v0.9 web.start）：popover 按态切换——idle 启动钮
 * 可用/停止钮禁用；connecting 双禁用 + 启动钮文案「连接中…」；connected
 * 停止钮可用/启动钮禁用。两钮恒渲染（焦点守恒，不按态卸载）。
 *
 * 纯展示纪律（TR-AD-8）：theme/onToggleTheme/webStatus/onStopWeb/onStartWeb
 * 全 props 注入，组件不读 ThemeContext、不读 store——无 Provider 装配也可渲染。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Activity, MessageSquare } from "lucide-react";
import type { WebStatusPayload } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import IconRail from "./IconRail";

const items = [
  { id: "chat", route: "/", labelKey: "chat.nav.pages.chat.label", icon: MessageSquare },
  { id: "trace", route: "/trace", labelKey: "chat.nav.pages.trace.label", icon: Activity },
] as const;

const CONNECTED: WebStatusPayload = {
  state: "connected",
  browser: { id: "chrome-9222", label: "Chrome", port: 9222 },
  tabCount: 2,
  tabs: [
    { tabId: "tab-1", ownerId: "main", url: "https://example.com", title: "Example", lastAccessed: Date.now() - 5 * 60_000 },
    { tabId: "tab-2", ownerId: "agent-1", url: "https://example.com/docs", title: "Docs", lastAccessed: Date.now() - 30_000 },
  ],
};

function ui(props: { theme?: "dark" | "light"; onToggleTheme?: () => void; webStatus?: WebStatusPayload | null; onStopWeb?: () => void; onStartWeb?: () => void } = {}) {
  // jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
  localStorage.setItem("helix-lang", "zh-CN");
  return render(
    <I18nProvider>
      <IconRail
        items={items}
        active="/"
        onNavigate={() => {}}
        theme={props.theme ?? "dark"}
        onToggleTheme={props.onToggleTheme ?? (() => {})}
        webStatus={props.webStatus ?? null}
        onStopWeb={props.onStopWeb ?? (() => {})}
        onStartWeb={props.onStartWeb ?? (() => {})}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("S1 IconRail 契约", () => {
  it("rail-logo = HelixLogo 渐变图标（HX 文字退役，40px 发光外框保留）", () => {
    ui();
    const logo = document.querySelector(".rail-logo")!;
    expect(logo.querySelector("[data-brand-logo]")).not.toBeNull();
    expect(logo.textContent!.trim()).toBe("");
  });

  it("rail-avatar 上方有 #btn-theme-toggle 单钮：dark → Sun（显示切换目标）+ i18n 文案", () => {
    ui({ theme: "dark", onToggleTheme: () => {} });
    const btn = document.querySelector("#btn-theme-toggle")!;
    expect(btn).toBeTruthy();
    expect(btn.querySelector(".lucide-sun")).not.toBeNull();
    expect(btn.querySelector(".lucide-moon")).toBeNull();
    expect(btn.getAttribute("title")).toBe("切换明暗主题");
    expect(btn.getAttribute("aria-label")).toBe("切换明暗主题");
    // DOM 序：主题钮在 .rail-avatar 之前（rail-nav 之后）
    const rail = document.querySelector(".icon-rail")!;
    const seq = Array.from(rail.querySelectorAll("#btn-theme-toggle, .rail-avatar")).map(
      (e) => (e instanceof HTMLElement ? e.id || e.className : ""),
    );
    expect(seq).toEqual(["btn-theme-toggle", "rail-avatar"]);
  });

  it("light → Moon；点击触发 onToggleTheme（纯 props 注入，一次一回调）", () => {
    const onToggleTheme = vi.fn();
    ui({ theme: "light", onToggleTheme });
    const btn = document.querySelector("#btn-theme-toggle")!;
    expect(btn.querySelector(".lucide-moon")).not.toBeNull();
    fireEvent.click(btn);
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });
});

describe("T4 IconRail 联网状态钮（契约 v0.7 web 族）", () => {
  it("DOM 序：#btn-web-status 在 #btn-theme-toggle 上方（主题钮之上）", () => {
    ui();
    const rail = document.querySelector(".icon-rail")!;
    const seq = Array.from(rail.querySelectorAll("#btn-web-status, #btn-theme-toggle, .rail-avatar")).map(
      (e) => (e instanceof HTMLElement ? e.id || e.className : ""),
    );
    expect(seq).toEqual(["btn-web-status", "btn-theme-toggle", "rail-avatar"]);
  });

  it("三态：null/idle → 灰（data-web-state=idle）；connected → 绿 + title 含浏览器名与 tab 数；error → 红", () => {
    // ① 未收到任何状态帧（null）= 灰态未连接
    ui({ webStatus: null });
    const btn = document.querySelector("#btn-web-status")!;
    expect(btn.getAttribute("data-web-state")).toBe("idle");
    expect(btn.getAttribute("aria-label")).toContain("联网");
    cleanup();
    // ② connected = 绿态；title 显示浏览器名 + tab 数
    ui({ webStatus: CONNECTED });
    const on = document.querySelector("#btn-web-status")!;
    expect(on.getAttribute("data-web-state")).toBe("connected");
    expect(on.getAttribute("title")).toContain("Chrome");
    expect(on.getAttribute("title")).toContain("2");
    cleanup();
    // ③ error = 红态
    ui({ webStatus: { state: "error", tabCount: 0, error: "CDP WebSocket 断开", tabs: [] } });
    const err = document.querySelector("#btn-web-status")!;
    expect(err.getAttribute("data-web-state")).toBe("error");
  });

  it("点击开合 popover：连接详情（浏览器/端口/tab 数）+ tab 清单（owner/标题/闲置）+ 停止并清理", () => {
    ui({ webStatus: CONNECTED });
    const btn = document.querySelector("#btn-web-status")!;
    expect(document.querySelector(".web-pop")).toBeNull(); // 初始闭合
    fireEvent.click(btn);
    const pop = document.querySelector(".web-pop")!;
    expect(pop).not.toBeNull();
    expect(pop.textContent).toContain("Chrome");
    expect(pop.textContent).toContain("9222");
    // tab 清单：标题 + owner + 闲置时长
    expect(pop.textContent).toContain("Example");
    expect(pop.textContent).toContain("main");
    expect(pop.textContent).toContain("agent-1");
    expect(pop.textContent).toContain("闲置");
    // 停止并清理按钮在场
    const stop = pop.querySelector("#btn-web-stop")!;
    expect(stop.textContent).toContain("停止并清理");
    // 再点钮关闭
    fireEvent.click(btn);
    expect(document.querySelector(".web-pop")).toBeNull();
  });

  it("停止并清理点击调 onStopWeb（纯 props 注入，一次一回调）；Esc 关闭 popover", () => {
    const onStopWeb = vi.fn();
    ui({ webStatus: CONNECTED, onStopWeb });
    fireEvent.click(document.querySelector("#btn-web-status")!);
    fireEvent.click(document.querySelector("#btn-web-stop")!);
    expect(onStopWeb).toHaveBeenCalledTimes(1);
    // 停止后 popover 保持打开（idle 回流经广播驱动；T9 后 model-switch 已改选中即关，不再为先例）
    expect(document.querySelector(".web-pop")).not.toBeNull();
    // Esc 关闭
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".web-pop")).toBeNull();
  });

  it("idle 态 popover：无连接详情，停止钮禁用（幂等无可停）", () => {
    ui({ webStatus: { state: "idle", tabCount: 0, tabs: [] } });
    fireEvent.click(document.querySelector("#btn-web-status")!);
    const pop = document.querySelector(".web-pop")!;
    expect(pop.textContent).toContain("未连接");
    expect(pop.querySelector("#btn-web-stop")!.hasAttribute("disabled")).toBe(true);
  });
});

describe("T7 popover 启动按钮三态切换（契约 v0.9 web.start 显式启动通路）", () => {
  it("idle 态：启动钮可用 + 停止钮禁用；点击启动钮调 onStartWeb（纯 props 注入，一次一回调）", () => {
    const onStartWeb = vi.fn();
    ui({ webStatus: { state: "idle", tabCount: 0, tabs: [] }, onStartWeb });
    fireEvent.click(document.querySelector("#btn-web-status")!);
    const pop = document.querySelector(".web-pop")!;
    const start = pop.querySelector("#btn-web-start")!;
    expect(start).not.toBeNull();
    expect(start.textContent).toContain("启动连接");
    expect(start.hasAttribute("disabled")).toBe(false); // idle = 启动可用
    expect(pop.querySelector("#btn-web-stop")!.hasAttribute("disabled")).toBe(true); // idle = 停止禁用
    fireEvent.click(start);
    expect(onStartWeb).toHaveBeenCalledTimes(1);
    // 点击后 popover 保持打开（状态回流经广播驱动；同停止钮先例）
    expect(document.querySelector(".web-pop")).not.toBeNull();
  });

  it("connecting 态：双禁用 + 启动钮文案「连接中…」", () => {
    ui({ webStatus: { state: "connecting", tabCount: 0, tabs: [] } });
    fireEvent.click(document.querySelector("#btn-web-status")!);
    const pop = document.querySelector(".web-pop")!;
    const start = pop.querySelector("#btn-web-start")!;
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(start.textContent).toContain("连接中");
    expect(pop.querySelector("#btn-web-stop")!.hasAttribute("disabled")).toBe(true); // 连接中无可停
  });

  it("connected 态：停止钮可用 + 启动钮禁用；两钮恒渲染（焦点守恒，不按态卸载）", () => {
    ui({ webStatus: CONNECTED });
    fireEvent.click(document.querySelector("#btn-web-status")!);
    const pop = document.querySelector(".web-pop")!;
    expect(pop.querySelector("#btn-web-stop")!.hasAttribute("disabled")).toBe(false);
    const start = pop.querySelector("#btn-web-start")!;
    expect(start).not.toBeNull(); // 不卸载（焦点守恒）
    expect(start.hasAttribute("disabled")).toBe(true);
  });

  it("error 态：启动钮可用（重试入口）+ 停止钮可用（清理既有错误残留）", () => {
    ui({ webStatus: { state: "error", tabCount: 0, error: "CDP WebSocket 断开", tabs: [] } });
    fireEvent.click(document.querySelector("#btn-web-status")!);
    const pop = document.querySelector(".web-pop")!;
    expect(pop.querySelector("#btn-web-start")!.hasAttribute("disabled")).toBe(false);
    expect(pop.querySelector("#btn-web-stop")!.hasAttribute("disabled")).toBe(false);
  });
});
