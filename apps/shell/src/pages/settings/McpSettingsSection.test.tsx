// @vitest-environment jsdom
/**
 * MCP 分区测试（mcp 批）：
 * - ① 进入分区拉取 mcp.servers.list + list.result 回填渲染（行 name/命令/
 *   五态徽标/工具数）；
 * - ② mcp.status.changed 广播单行合并（running 徽标实时更新）；
 * - ③ 新增表单：必填校验（空名行内错误）+ add.result applied → 表单收起
 *   + 重拉对账；connect_failed → 行内错误保留表单；
 * - ④ 测试连接：test.result applied → 工具数反馈；failed → 错误反馈；
 * - ⑤ 删除两段式：首击变确认态、二击发 remove。
 *
 * vi.mock SessionContext（GeneralSettingsSection.test 先例）；域订阅
 * mock 为「捕获 listener 直通」——谓词存在性已由 command-surface.test
 * 钉住（TR-89 防线分工），此处只测消费逻辑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";

const sendMcpServersList = vi.fn();
const sendMcpServersAdd = vi.fn();
const sendMcpServersRemove = vi.fn();
const sendMcpServersTest = vi.fn();
/** 域订阅捕获面：listener 直通（测试驱动回执/广播帧）。 */
let capturedListener: ((e: EventEnvelope) => void) | null = null;

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { agentState: "idle", instances: [] },
      topology: { modelConfig: null, list: [] },
      sendMcpServersList,
      sendMcpServersAdd,
      sendMcpServersRemove,
      sendMcpServersTest,
      subscribeMcpFrames: (listener: (e: EventEnvelope) => void) => {
        capturedListener = listener;
        return () => {
          capturedListener = null;
        };
      },
    }),
  };
});

import McpSettingsSection from "./ui/McpSettingsSection";

beforeEach(() => {
  localStorage.setItem("helix-lang", "zh-CN");
});

afterEach(() => {
  cleanup();
  capturedListener = null;
  vi.clearAllMocks();
});

function ui() {
  return render(
    <ToastProvider>
      <I18nProvider>
        <McpSettingsSection />
      </I18nProvider>
    </ToastProvider>,
  );
}

/** 驱动一帧（listener 直通）。 */
function feed(type: string, payload: Record<string, unknown>): void {
  capturedListener?.({
    v: 11,
    sessionId: "__system__",
    channel: "mcp",
    type,
    payload,
  } as unknown as EventEnvelope);
}

const LIST_FRAME = {
  servers: [
    {
      config: { name: "shadcn", command: "npx", args: ["shadcn@latest", "mcp"], enabled: true },
      status: { name: "shadcn", state: "running", toolCount: 10 },
    },
    {
      config: { name: "broken", command: "nope-xyz" },
      status: { name: "broken", state: "error", lastError: "spawn failed" },
    },
  ],
};

describe("MCP 设置分区", () => {
  it("① 进入拉取 + list.result 回填（行渲染 + 五态徽标 + 错误行展开）", async () => {
    ui();
    expect(sendMcpServersList).toHaveBeenCalledTimes(1);
    feed("mcp.servers.list.result", LIST_FRAME);
    await waitFor(() => {
      expect(screen.getByText("shadcn")).toBeTruthy();
    });
    expect(screen.getByText("npx shadcn@latest mcp")).toBeTruthy();
    expect(screen.getByText("10 个工具")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("异常")).toBeTruthy();
    expect(screen.getByText("spawn failed")).toBeTruthy();
  });

  it("② mcp.status.changed 单行合并（broken error → running）", async () => {
    ui();
    feed("mcp.servers.list.result", LIST_FRAME);
    await waitFor(() => screen.getByText("shadcn"));
    feed("mcp.status.changed", { server: { name: "broken", state: "running", toolCount: 3 } });
    await waitFor(() => {
      expect(screen.queryByText("异常")).toBeNull();
      expect(screen.getAllByText("运行中").length).toBe(2);
    });
  });

  it("③ 新增：必填校验 + applied 收起表单重拉；connect_failed 行内错误", async () => {
    ui();
    feed("mcp.servers.list.result", LIST_FRAME);
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    // 空表单提交 → 行内错误，不发命令
    fireEvent.click(document.querySelector("[data-mcp-submit]")!);
    expect(sendMcpServersAdd).not.toHaveBeenCalled();
    expect(document.querySelector("[data-mcp-form-error]")!.textContent).toContain("必填");
    // 填表提交 → 命令面（args 空格分隔转数组）
    fireEvent.change(document.querySelector("[data-mcp-name]")!, { target: { value: "magicui" } });
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "npx" } });
    fireEvent.change(document.querySelector("[data-mcp-args]")!, { target: { value: "-y @magicuidesign/mcp@latest" } });
    fireEvent.click(document.querySelector("[data-mcp-submit]")!);
    expect(sendMcpServersAdd).toHaveBeenCalledWith({
      name: "magicui",
      command: "npx",
      args: ["-y", "@magicuidesign/mcp@latest"],
      enabled: true,
      deferred: true,
    });
    // deferred 批：applied 回执后重开表单（表单重置 deferred=true）→
    // 取消懒加载 → payload.deferred=false
    feed("mcp.servers.add.result", { status: "applied", server: { name: "magicui", state: "running" } });
    await waitFor(() => {
      expect(document.querySelector("[data-mcp-form]")).toBeNull();
      expect(sendMcpServersList).toHaveBeenCalledTimes(2);
    });
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    fireEvent.click(document.querySelector("[data-mcp-deferred] input")!);
    fireEvent.change(document.querySelector("[data-mcp-name]")!, { target: { value: "eager" } });
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "npx" } });
    fireEvent.change(document.querySelector("[data-mcp-args]")!, { target: { value: "-y @magicuidesign/mcp@latest" } });
    fireEvent.click(document.querySelector("[data-mcp-submit]")!);
    expect(sendMcpServersAdd).toHaveBeenLastCalledWith({
      name: "eager",
      command: "npx",
      args: ["-y", "@magicuidesign/mcp@latest"],
      enabled: true,
      deferred: false,
    });
    feed("mcp.servers.add.result", { status: "applied", server: { name: "eager", state: "running" } });
    await waitFor(() => expect(document.querySelector("[data-mcp-form]")).toBeNull());
    // 再开表单：connect_failed → 行内错误保留表单
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    fireEvent.change(document.querySelector("[data-mcp-name]")!, { target: { value: "bad" } });
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "x" } });
    fireEvent.click(document.querySelector("[data-mcp-submit]")!);
    feed("mcp.servers.add.result", { status: "connect_failed", server: { name: "bad", state: "error" }, error: "boom" });
    await waitFor(() => {
      expect(document.querySelector("[data-mcp-form-error]")!.textContent).toContain("boom");
      expect(document.querySelector("[data-mcp-form]")!).toBeTruthy();
    });
  });

  it("④ 测试连接：applied 工具数 / failed 错误", async () => {
    ui();
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    fireEvent.change(document.querySelector("[data-mcp-name]")!, { target: { value: "probe" } });
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "npx" } });
    fireEvent.click(document.querySelector("[data-mcp-test]")!);
    expect(sendMcpServersTest).toHaveBeenCalledWith({ name: "probe", command: "npx", enabled: true, deferred: true });
    feed("mcp.servers.test.result", { status: "applied", toolCount: 5 });
    await waitFor(() => expect(document.querySelector("[data-mcp-test-ok]")!.textContent).toContain("5"));
    fireEvent.click(document.querySelector("[data-mcp-test]")!);
    feed("mcp.servers.test.result", { status: "failed", error: "timeout" });
    await waitFor(() => expect(document.querySelector("[data-mcp-test-fail]")!.textContent).toContain("timeout"));
  });

  it("⑤ 删除两段式：首击确认态、二击发命令", async () => {
    ui();
    feed("mcp.servers.list.result", LIST_FRAME);
    await waitFor(() => screen.getByText("shadcn"));
    const del = document.querySelector('[data-mcp-delete="shadcn"]')!;
    fireEvent.click(del);
    expect(sendMcpServersRemove).not.toHaveBeenCalled();
    expect(document.querySelector('[data-mcp-delete="shadcn"]')!.textContent).toContain("确认删除");
    fireEvent.click(document.querySelector('[data-mcp-delete="shadcn"]')!);
    expect(sendMcpServersRemove).toHaveBeenCalledWith({ name: "shadcn" });
  });
});
