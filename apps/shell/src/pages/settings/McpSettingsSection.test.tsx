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
const sendMcpServersUpdate = vi.fn();
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
      sendMcpServersUpdate,
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

describe("MCP 设置分区：编辑 server（update 接线批，CAND-705）", () => {
  it("⑨ 编辑：回填 + name 锁定 + 保存走 sendMcpServersUpdate + applied 收起重拉", async () => {
    ui();
    feed("mcp.servers.list.result", LIST_FRAME);
    await waitFor(() => screen.getByText("shadcn"));
    fireEvent.click(document.querySelector('[data-mcp-edit="shadcn"]')!);
    // 回填：name/command/args 预填 + name 锁定（update 按 name 定位，改名 = 删了重加）
    const nameInput = document.querySelector("[data-mcp-name]") as HTMLInputElement;
    expect(nameInput.value).toBe("shadcn");
    expect(nameInput.disabled).toBe(true);
    expect((document.querySelector("[data-mcp-command]") as HTMLInputElement).value).toBe("npx");
    expect((document.querySelector("[data-mcp-args]") as HTMLInputElement).value).toBe("shadcn@latest mcp");
    // 改命令提交 → update 命令面（name 原值 + 新 command + enabled/deferred 原样）
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "uvx" } });
    fireEvent.click(document.querySelector("[data-mcp-submit]")!);
    expect(sendMcpServersUpdate).toHaveBeenCalledWith({
      name: "shadcn",
      command: "uvx",
      args: ["shadcn@latest", "mcp"],
      enabled: true,
      deferred: true,
    });
    feed("mcp.servers.update.result", { status: "applied", server: { name: "shadcn", state: "running" } });
    await waitFor(() => {
      expect(document.querySelector("[data-mcp-form]")).toBeNull();
      expect(sendMcpServersList).toHaveBeenCalledTimes(2);
    });
  });

  it("⑩ 编辑：connect_failed 行内错误保留表单；取消收起复位新增态", async () => {
    ui();
    feed("mcp.servers.list.result", LIST_FRAME);
    await waitFor(() => screen.getByText("shadcn"));
    fireEvent.click(document.querySelector('[data-mcp-edit="shadcn"]')!);
    fireEvent.click(document.querySelector("[data-mcp-submit]")!);
    feed("mcp.servers.update.result", { status: "connect_failed", server: { name: "shadcn", state: "error" }, error: "spawn boom" });
    await waitFor(() => {
      expect(document.querySelector("[data-mcp-form-error]")!.textContent).toContain("spawn boom");
      expect(document.querySelector("[data-mcp-form]")!).toBeTruthy();
    });
    // 取消：收起 + 复位（再开 = 新增态：name 可编辑、字段清空）
    fireEvent.click(document.querySelector("[data-mcp-cancel]")!);
    await waitFor(() => expect(document.querySelector("[data-mcp-form]")).toBeNull());
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    const nameInput = document.querySelector("[data-mcp-name]") as HTMLInputElement;
    expect(nameInput.disabled).toBe(false);
    expect(nameInput.value).toBe("");
  });
});

describe("MCP 设置分区：导入配置 JSON（粘贴文本批——直接粘贴完整 JSON，不再选 .json 文件）", () => {
  it("⑥ 粘贴 Claude Desktop mcpServers 格式 → 预填 name/command/args + 表单展开 + 面板收起 + 多 server 提示", async () => {
    ui();
    const json = JSON.stringify({
      mcpServers: {
        shadcn: { command: "npx", args: ["shadcn@latest", "mcp"] },
        other: { command: "node", args: ["server.js"] },
      },
    });
    fireEvent.click(document.querySelector("[data-mcp-import]")!); // 展开粘贴面板
    fireEvent.change(document.querySelector("[data-mcp-import-text]")!, { target: { value: json } });
    fireEvent.click(document.querySelector("[data-mcp-import-parse]")!);
    await waitFor(() => {
      expect((document.querySelector("[data-mcp-name]") as HTMLInputElement).value).toBe("shadcn");
    });
    expect((document.querySelector("[data-mcp-command]") as HTMLInputElement).value).toBe("npx");
    expect((document.querySelector("[data-mcp-args]") as HTMLInputElement).value).toBe("shadcn@latest mcp");
    expect(document.querySelector("[data-mcp-form]")!).toBeTruthy(); // 表单展开
    expect(document.querySelector("[data-mcp-import-panel]")).toBeNull(); // 面板收起
    expect(document.querySelector("[data-mcp-import-note]")!.textContent).toContain("2");
  });

  it("⑦ 非法 JSON → 面板内行内错误（表单不动不展开）", async () => {
    ui();
    fireEvent.click(document.querySelector("[data-mcp-import]")!);
    fireEvent.change(document.querySelector("[data-mcp-import-text]")!, { target: { value: "not json" } });
    fireEvent.click(document.querySelector("[data-mcp-import-parse]")!);
    await waitFor(() => {
      expect(document.querySelector("[data-mcp-import-error]")!.textContent).toContain("导入失败");
    });
    expect(document.querySelector("[data-mcp-form]")).toBeNull(); // 解析失败不强制展开表单
  });

  it("⑧ 单 server 裸对象（无 mcpServers 包裹）→ name 留空 + 补填提示（不再有文件名可取）", async () => {
    ui();
    fireEvent.click(document.querySelector("[data-mcp-import]")!);
    fireEvent.change(document.querySelector("[data-mcp-import-text]")!, {
      target: { value: JSON.stringify({ command: "uvx", args: ["mcp-server"] }) },
    });
    fireEvent.click(document.querySelector("[data-mcp-import-parse]")!);
    await waitFor(() => {
      expect((document.querySelector("[data-mcp-name]") as HTMLInputElement).value).toBe("");
    });
    expect((document.querySelector("[data-mcp-command]") as HTMLInputElement).value).toBe("uvx");
    expect((document.querySelector("[data-mcp-args]") as HTMLInputElement).value).toBe("mcp-server");
    expect(document.querySelector("[data-mcp-import-note]")!.textContent).toContain("补填名称");
  });
});

// ── code-review H9：send 返回值消费——send false（断线窗口）不得永锁在途
//    （addPending 钮永久 disabled / test 永挂 testing）。──
describe("code-review H9：send false → 在途不置 + 行内交代（不永锁）", () => {
  it("submitAdd send false → 提交钮不锁 + 表单错误交代", () => {
    ui();
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    fireEvent.change(document.querySelector("[data-mcp-name]")!, { target: { value: "srv" } });
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "npx" } });
    sendMcpServersAdd.mockReturnValue(false);
    fireEvent.click(document.querySelector("[data-mcp-submit]")!);
    // 未发出 → 不置 addPending（钮不锁，可修正重提）+ 行内错误
    expect((document.querySelector("[data-mcp-submit]") as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector("[data-mcp-form-error]") as HTMLElement | null)?.textContent).toContain("未连接");
  });

  it("submitTest send false → 不进 testing（钮不锁）+ fail 态错误交代", () => {
    ui();
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    fireEvent.change(document.querySelector("[data-mcp-name]")!, { target: { value: "srv" } });
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "npx" } });
    sendMcpServersTest.mockReturnValue(false);
    fireEvent.click(document.querySelector("[data-mcp-test]")!);
    // 未发出 → 不永挂 testing（钮立即可用）+ fail 行内交代
    expect((document.querySelector("[data-mcp-test]") as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector("[data-mcp-test-fail]") as HTMLElement | null)?.textContent).toContain("未连接");
  });
});

describe("code-review 族A：connection.error 按在途 kind 归因收口（TR-144/145）", () => {
  it("testing 在途 + connection.error（尾缀 mcp.servers.test）→ fail 行内交代，不永挂 testing", async () => {
    ui();
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    fireEvent.change(document.querySelector("[data-mcp-name]")!, { target: { value: "probe" } });
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "npx" } });
    sendMcpServersTest.mockReturnValueOnce(true); // H9 消费面：true=已发出才进 testing
    fireEvent.click(document.querySelector("[data-mcp-test]")!);
    expect(document.querySelector("[data-mcp-test]")!.hasAttribute("disabled")).toBe(true); // testing 在途
    feed("connection.error", { message: "连接测试失败：spawn 被拒（命令 mcp.servers.test）" });
    // 现行红：connection.error 只清 addPending——testing 永挂
    await waitFor(() => {
      expect(document.querySelector("[data-mcp-test-fail]")!.textContent).toContain("spawn 被拒");
      expect(document.querySelector("[data-mcp-test]")!.hasAttribute("disabled")).toBe(false);
    });
  });

  it("尾缀非本族的 connection.error → 本族在途不误伤（addPending 保持）", async () => {
    ui();
    fireEvent.click(document.querySelector("[data-mcp-add-toggle]")!);
    fireEvent.change(document.querySelector("[data-mcp-name]")!, { target: { value: "magicui" } });
    fireEvent.change(document.querySelector("[data-mcp-command]")!, { target: { value: "npx" } });
    sendMcpServersAdd.mockReturnValueOnce(true); // H9 消费面：true=已发出才进 addPending
    fireEvent.click(document.querySelector("[data-mcp-submit]")!);
    expect(document.querySelector("[data-mcp-submit]")!.hasAttribute("disabled")).toBe(true); // addPending
    feed("connection.error", { message: "追踪查询失败（命令 trace.query）" });
    // 不误伤：addPending 保持、无 formError
    await waitFor(() => {
      expect(document.querySelector("[data-mcp-submit]")!.hasAttribute("disabled")).toBe(true);
      expect(document.querySelector("[data-mcp-form-error]")).toBeNull();
    });
  });

  it("remove send false（未连接）→ err toast 交代（不静默）", async () => {
    sendMcpServersRemove.mockReturnValueOnce(false);
    ui();
    feed("mcp.servers.list.result", LIST_FRAME);
    await waitFor(() => expect(document.querySelector('[data-mcp-delete="shadcn"]')).not.toBeNull());
    const btn = document.querySelector('[data-mcp-delete="shadcn"]')!;
    fireEvent.click(btn); // 首击 armed
    fireEvent.click(btn); // 二击执行
    // 现行红：send 返回值未消费——静默失败零交代
    await waitFor(() => expect(document.querySelector(".toast.err")!.textContent).toContain("未连接"));
  });
});
