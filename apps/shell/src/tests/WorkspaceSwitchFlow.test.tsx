// @vitest-environment jsdom
/**
 * workspace 切换流端到端组件测试（W4；brief 任务 3 / 验收 2）。
 *
 * 真链路（REAL WorkspaceProvider + reducer + 两页面；App 门禁分支同构
 * harness——phase 分流渲染主壳/gate）：设置入口 → gate（带取消逃逸）→
 * 取消回主壳；再入 → gate open 成功 → 回主壳（current 更新）。
 * 回归：首启 gate（get-result null）无逃逸（取消钮不在场）。
 *
 * deps 注入面（AG-15）：WorkspaceDeps stub（SessionContext mock 供设置
 * 分区活跃信号——恒 idle）。中文断言语言钉 zh-CN。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EventEnvelope } from "@helix/protocol";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/ui/theme";
import { ToastProvider } from "@/shared/ui/Toast";
import { WorkspaceProvider, useWorkspace, type WorkspaceDeps } from "@/entities/workspace/WorkspaceContext";
import WorkspaceGatePage from "@/pages/workspace/WorkspaceGatePage";
import WorkspaceSettingsSection from "@/pages/settings/ui/WorkspaceSettingsSection";

// ── useSession mock（设置分区活跃信号：恒 idle）─────────────
vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    state: { agentState: "idle", instances: [] },
    topology: { list: [] },
  }),
}));

let sentOpen: string[] = [];
let listeners: ((e: EventEnvelope) => void)[] = [];

function makeDeps(connected: boolean): WorkspaceDeps {
  return {
    connected,
    sendGet: () => true,
    sendOpen: (root: string) => {
      sentOpen.push(root);
      return true;
    },
    subscribe: (cb: (e: EventEnvelope) => void) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
  };
}

/** App.WorkspaceGateBranch 同构分流（phase → gate/boot/main）。 */
function GateBranch() {
  const { state } = useWorkspace();
  if (state.phase === "gate") return <WorkspaceGatePage />;
  if (state.phase === "connecting") return <div data-flow="connecting" />;
  return (
    <>
      <div data-flow="main">主壳在场</div>
      <WorkspaceSettingsSection />
    </>
  );
}

function ui(connected = true) {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <WorkspaceProvider deps={makeDeps(connected)}>
            <GateBranch />
          </WorkspaceProvider>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

function feed(type: string, payload: unknown) {
  const frame = { v: 0, type, sessionId: "__system__", channel: "workspace", payload } as EventEnvelope;
  act(() => {
    for (const l of [...listeners]) l(frame);
  });
}

function toMainBound() {
  ui(true);
  feed("workspace.get.result", { current: { root: "/ws/a" }, recents: [] });
  expect(document.querySelector("[data-flow='main']")).not.toBeNull();
}

beforeEach(() => {
  sentOpen = [];
  listeners = [];
});
afterEach(cleanup);

localStorage.setItem("helix-lang", "zh-CN");

describe("切换流端到端（设置入口 → gate 带取消 → open → 回主壳）", () => {
  it("设置入口点切换 → gate 在场（取消逃逸）+ 主壳卸载；取消 → 回主壳（绑定未变）", () => {
    toMainBound();
    expect(document.querySelector("[data-ws-set-root]")!.textContent).toBe("/ws/a");
    // 入口：设置分区切换按钮
    fireEvent.click(document.querySelector("[data-ws-set-switch]")!);
    // gate 接管：主壳卸载 + 取消钮在场（带取消逃逸）
    expect(document.querySelector("[data-flow='main']")).toBeNull();
    expect(document.querySelector("[data-wsgate-page='gate']")).not.toBeNull();
    expect(document.querySelector("[data-wsgate-cancel]")).not.toBeNull();
    // 取消 → 回主壳（绑定未变）
    fireEvent.click(document.querySelector("[data-wsgate-cancel]")!);
    expect(document.querySelector("[data-flow='main']")).not.toBeNull();
    expect(document.querySelector("[data-ws-set-root]")!.textContent).toBe("/ws/a");
  });

  it("再入切换流 → open 成功 → 回主壳（current 更新 + 切换流收口）", () => {
    toMainBound();
    fireEvent.click(document.querySelector("[data-ws-set-switch]")!);
    // gate 输入区提交 open
    const input = document.querySelector("[data-wsgate-path]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/ws/b" } });
    fireEvent.click(document.querySelector("[data-wsgate-submit]")!);
    expect(sentOpen).toEqual(["/ws/b"]);
    // daemon 回执（先广播后点对点双帧——两帧均收口 main，此处以点对点收尾）
    feed("workspace_changed", { root: "/ws/b" });
    feed("workspace.open.result", { root: "/ws/b", projects: [] });
    expect(document.querySelector("[data-flow='main']")).not.toBeNull();
    expect(document.querySelector("[data-wsgate-page='gate']")).toBeNull();
    expect(document.querySelector("[data-ws-set-root]")!.textContent).toBe("/ws/b");
  });

  it("open 失败 → 留 gate（行内错误 + 可取消逃逸），取消回主壳", () => {
    toMainBound();
    fireEvent.click(document.querySelector("[data-ws-set-switch]")!);
    const input = document.querySelector("[data-wsgate-path]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/nope" } });
    fireEvent.click(document.querySelector("[data-wsgate-submit]")!);
    feed("connection.error", { code: "WORKSPACE_E_INVALID_ROOT", message: "路径不存在或无法解析：/nope" });
    expect(document.querySelector("[data-wsgate-error]")!.textContent).toContain("路径无效");
    expect(document.querySelector("[data-wsgate-cancel]")).not.toBeNull();
    fireEvent.click(document.querySelector("[data-wsgate-cancel]")!);
    expect(document.querySelector("[data-flow='main']")).not.toBeNull();
  });
});

describe("首启 gate 无逃逸语义（回归）", () => {
  it("get-result null → gate 无取消钮（不选不进主壳，语义不变）", () => {
    ui(true);
    feed("workspace.get.result", { current: null, recents: [] });
    expect(document.querySelector("[data-wsgate-page='gate']")).not.toBeNull();
    expect(document.querySelector("[data-wsgate-cancel]")).toBeNull();
    expect(document.querySelector("[data-flow='main']")).toBeNull();
    expect(screen.getByText("选择工作空间")).toBeTruthy();
  });
});
