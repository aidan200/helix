// @vitest-environment jsdom
/**
 * S1 IconRail 改造契约（用户裁决：logo 换 chat header 同款 HelixLogo；
 * 主题切换单钮置 rail-avatar 上方，太阳/月亮显示切换目标）。
 *
 * 纯展示纪律（TR-AD-8）：theme/onToggleTheme 全 props 注入，
 * 组件不读 ThemeContext、不读 store——无 Provider 装配也可渲染。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Activity, MessageSquare } from "lucide-react";
import { I18nProvider } from "@/shared/i18n";
import IconRail from "./IconRail";

const items = [
  { id: "chat", route: "/", labelKey: "chat.nav.pages.chat.label", icon: MessageSquare },
  { id: "trace", route: "/trace", labelKey: "chat.nav.pages.trace.label", icon: Activity },
] as const;

function ui(props: { theme?: "dark" | "light"; onToggleTheme?: () => void } = {}) {
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
