// @vitest-environment jsdom
/**
 * WorkspaceGatePage 组件测试（W3 选择页；brief 任务 3 / 验收 2）。
 *
 * 覆盖：recents 渲染（name/root/lastUsedAt 本地化短格式）、失效项置灰
 * disabled + 失效标注、点击 valid 项即 open、路径输入提交（trim）、错误码
 * →行内文案映射（INVALID_ROOT/ACTIVE_AGENT/send-failed）、notice 置顶展示、
 * 提交中禁用态。vi.mock useWorkspace（store 注入分工——ProjectPage 先例）；
 * 中文断言语言钉 zh-CN。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import type { WorkspaceState } from "@/entities/workspace/model/workspace-store";

// ── useWorkspace mock（store 注入面）─────────────────────────
let store: WorkspaceState;
let opened: string[] = [];

vi.mock("@/entities/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({
    state: store,
    openWorkspace: (root: string) => {
      opened.push(root);
      return true;
    },
  }),
}));

import WorkspaceGatePage from "./WorkspaceGatePage";

function baseGate(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    phase: "gate",
    current: null,
    recents: [],
    notice: null,
    opening: false,
    openError: null,
    ...overrides,
  };
}

function ui() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <WorkspaceGatePage />
      </I18nProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  store = baseGate();
  opened = [];
});
afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言）
localStorage.setItem("helix-lang", "zh-CN");

describe("recents 区（MRU 列表）", () => {
  it("渲染 name/root/lastUsedAt（短格式）", () => {
    store = baseGate({
      recents: [
        { root: "/Users/siyong/ws/helix", name: "helix", lastUsedAt: "2026-08-27T14:32:00+08:00", valid: true },
        { root: "/Users/siyong/ws/old", name: "old", lastUsedAt: "2026-08-26T09:05:00+08:00", valid: true },
      ],
    });
    ui();
    const list = document.querySelector("[data-wsgate-recents]")!;
    expect(list.querySelectorAll(".wsgate-recent")).toHaveLength(2);
    expect(screen.getByText("helix")).toBeTruthy();
    expect(screen.getByText("/Users/siyong/ws/helix")).toBeTruthy();
    expect(screen.getByText(/08-27 14:32/)).toBeTruthy();
    expect(screen.getByText(/08-26 09:05/)).toBeTruthy();
  });

  it("valid:false 项置灰（disabled）+ 失效标注，点击不触发 open", () => {
    store = baseGate({
      recents: [
        { root: "/ws/gone", name: "gone", lastUsedAt: "2026-08-26T09:05:00+08:00", valid: false },
        { root: "/ws/helix", name: "helix", lastUsedAt: "2026-08-27T14:32:00+08:00", valid: true },
      ],
    });
    ui();
    const invalid = document.querySelector('.wsgate-recent[data-valid="0"]') as HTMLButtonElement;
    expect(invalid.disabled).toBe(true);
    expect(screen.getByText("已失效")).toBeTruthy();
    fireEvent.click(invalid);
    expect(opened).toEqual([]);
    // valid 项可点：点击即 open
    fireEvent.click(document.querySelector('.wsgate-recent[data-valid="1"]')!);
    expect(opened).toEqual(["/ws/helix"]);
  });

  it("无 recents → 列表区不渲染（首启空态）", () => {
    ui();
    expect(document.querySelector("[data-wsgate-recents]")).toBeNull();
  });
});

describe("输入区（路径 + 确认）", () => {
  it("输入路径提交 → openWorkspace(trim 后)；Enter 同效", () => {
    ui();
    const input = document.querySelector("[data-wsgate-path]") as HTMLInputElement;
    const btn = document.querySelector("[data-wsgate-submit]") as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "  /ws/helix  " } });
    fireEvent.click(btn);
    expect(opened).toEqual(["/ws/helix"]);
    fireEvent.change(input, { target: { value: "/ws/another" } });
    fireEvent.submit(input.closest("form")!);
    expect(opened).toEqual(["/ws/helix", "/ws/another"]);
  });

  it("空路径（含纯空白）→ 确认钮 disabled", () => {
    ui();
    const input = document.querySelector("[data-wsgate-path]") as HTMLInputElement;
    const btn = document.querySelector("[data-wsgate-submit]") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    expect(btn.disabled).toBe(true);
  });

  it("提交中（opening）→ 输入/确认/recents 全禁用 + 按钮文案切换", () => {
    store = baseGate({
      opening: true,
      recents: [{ root: "/ws/helix", name: "helix", lastUsedAt: "2026-08-27T14:32:00+08:00", valid: true }],
    });
    ui();
    const input = document.querySelector("[data-wsgate-path]") as HTMLInputElement;
    const submit = document.querySelector("[data-wsgate-submit]") as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    const recent = document.querySelector(".wsgate-recent") as HTMLButtonElement;
    expect(recent.disabled).toBe(true);
    expect(submit.textContent).toBe("打开中…");
  });
});

describe("错误码 → 行内文案映射（daemon 单点校验，前端只显示）", () => {
  it("WORKSPACE_E_INVALID_ROOT → 无效根文案 + daemon message 附加行", () => {
    store = baseGate({ openError: { code: "WORKSPACE_E_INVALID_ROOT", message: "路径不是可读目录：/nope" } });
    ui();
    const box = document.querySelector("[data-wsgate-error]")!;
    expect(box.getAttribute("data-wsgate-error")).toBe("WORKSPACE_E_INVALID_ROOT");
    expect(box.textContent).toContain("路径无效");
    expect(box.textContent).toContain("路径不是可读目录：/nope");
  });

  it("WORKSPACE_E_ACTIVE_AGENT → 活跃智能体文案", () => {
    store = baseGate({ openError: { code: "WORKSPACE_E_ACTIVE_AGENT", message: "" } });
    ui();
    expect(document.querySelector("[data-wsgate-error]")!.textContent).toContain("运行中的智能体");
  });

  it("send-failed → 通用发送失败文案（无 message 附加行）", () => {
    store = baseGate({ openError: { code: "send-failed", message: "" } });
    ui();
    const box = document.querySelector("[data-wsgate-error]")!;
    expect(box.textContent).toContain("发送失败");
    expect(box.querySelector(".wsgate-error-detail")).toBeNull();
  });

  it("未知码 → 通用失败文案", () => {
    store = baseGate({ openError: { code: "command.unknown", message: "" } });
    ui();
    expect(document.querySelector("[data-wsgate-error]")!.textContent).toContain("打开工作空间失败");
  });

  it("无错误 → 行内错误区不渲染", () => {
    ui();
    expect(document.querySelector("[data-wsgate-error]")).toBeNull();
  });
});

describe("notice 区（get 降级说明置顶）", () => {
  it("notice 有值 → 置顶展示（daemon 用户可读文本）", () => {
    store = baseGate({ notice: "上次的工作空间已不可用：路径不存在或无法解析：/old" });
    ui();
    const notice = document.querySelector("[data-wsgate-notice]")!;
    expect(notice.textContent).toContain("上次的工作空间已不可用：路径不存在或无法解析：/old");
    // 置顶：位于面板首位（标题之后、recents/输入区之前）
    const panel = document.querySelector(".wsgate-panel")!;
    expect(panel.children[2]).toBe(notice);
  });

  it("无 notice → 区不渲染", () => {
    ui();
    expect(document.querySelector("[data-wsgate-notice]")).toBeNull();
  });
});

describe("门禁语义（无导航逃逸）", () => {
  it("全页零导航链接（不选不进主壳）", () => {
    store = baseGate({
      recents: [{ root: "/ws/a", name: "a", lastUsedAt: "2026-08-27T10:00:00+08:00", valid: true }],
    });
    ui();
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });
});
