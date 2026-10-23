// @vitest-environment jsdom
/**
 * 网络代理设置组（通用→网络代理）测试：shell 链路完整可用面。
 *
 * 覆盖（TDD 先行，实现前全红）：
 * - 进入拉现值（requestProxyConfig）+ 未拉取禁用开关；
 * - get 回执回显（不冒充「已保存」）；set 回执驱动「已保存」+ 开关翻转；
 * - 地址草稿保护：未保存草稿不被读帧/他字段回执覆盖；
 * - 回车/失焦提交去重（一次命令）；非法地址与 SOCKS5 行内拒绝（零命令）；
 * - 启用时把正在编辑的地址原子发送（{enabled:true,url}）；关闭后保留地址；
 * - 断线 send false → 行内交代不假保存；daemon 拒绝（connection.error 尾缀）
 *   → 行内交代且不清草稿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

const requestProxyConfig = vi.fn();
const setProxyConfig = vi.fn((..._args: unknown[]) => true);
let proxyListeners: ((e: EventEnvelope) => void)[] = [];

/** 拓扑面可变位（结果帧驱动回填用）。 */
let mockProxy: { enabled: boolean; url: string } | null = null;
let mockInflight = false;
let mockSaved = false;
let mockConn = "connected";

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { conn: mockConn },
      topology: {
        modelConfig: { proxy: mockProxy, proxyInflight: mockInflight, proxySaved: mockSaved },
      },
      requestProxyConfig,
      setProxyConfig,
      subscribeConfigFrames: (listener: (e: EventEnvelope) => void) => {
        proxyListeners.push(listener);
        return () => {
          proxyListeners = proxyListeners.filter((l) => l !== listener);
        };
      },
    }),
  };
});

import NetworkProxySettingsGroup from "./NetworkProxySettingsGroup";

beforeEach(() => {
  localStorage.setItem("helix-lang", "zh-CN");
});

afterEach(() => {
  cleanup();
  mockProxy = null;
  mockInflight = false;
  mockSaved = false;
  mockConn = "connected";
  proxyListeners = [];
  vi.clearAllMocks();
  localStorage.removeItem("helix-lang");
});

function renderGroup() {
  return render(
    <I18nProvider>
      <NetworkProxySettingsGroup />
    </I18nProvider>,
  );
}

function feedConnError(message: string) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "notification",
    type: "connection.error",
    ts: 1,
    payload: { code: "invalid_payload", message },
  } as unknown as EventEnvelope;
  act(() => {
    for (const listener of proxyListeners) listener(frame);
  });
}

const OPTION_URL = "http://127.0.0.1:7890";

describe("网络代理：拉取与未就绪门控", () => {
  it("进入分区拉现值（requestProxyConfig 调用一次）", () => {
    renderGroup();
    expect(requestProxyConfig).toHaveBeenCalledTimes(1);
  });

  it("未拉取（proxy=null）→ 开关禁用 + 不出「已保存」", () => {
    const r = renderGroup();
    const c = r.container;
    expect(c.querySelector<HTMLButtonElement>('[data-proxy-option="on"]')!.disabled).toBe(true);
    expect(c.querySelector<HTMLButtonElement>('[data-proxy-option="off"]')!.disabled).toBe(true);
    expect(c.querySelector("[data-proxy-saved]")).toBeNull();
  });

  it("get 回执回显：开启态 aria-pressed + 地址回显；不冒充「已保存」", () => {
    mockProxy = { enabled: true, url: OPTION_URL };
    const r = renderGroup();
    const c = r.container;
    expect(c.querySelector<HTMLButtonElement>('[data-proxy-option="on"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(c.querySelector<HTMLButtonElement>('[data-proxy-option="on"]')!.disabled).toBe(false);
    expect(c.querySelector<HTMLInputElement>("[data-proxy-url]")!.value).toBe(OPTION_URL);
    expect(c.querySelector("[data-proxy-saved]")).toBeNull();
  });
});

describe("网络代理：开关保存（结果帧驱动）", () => {
  it("点开启（地址现值合法）→ 原子发送 {enabled:true,url}；不发乐观态", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    fireEvent.click(r.container.querySelector<HTMLElement>('[data-proxy-option="on"]')!);
    expect(setProxyConfig).toHaveBeenCalledWith({ enabled: true, url: OPTION_URL });
    // 回执未到：仍显示关闭态（不假已开启）
    expect(r.container.querySelector<HTMLElement>('[data-proxy-option="off"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("set 回执到达（proxySaved）→ 显示「已保存」并翻转开关态", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    fireEvent.click(r.container.querySelector<HTMLElement>('[data-proxy-option="on"]')!);
    // 回执驱动：state 更新后重渲染
    mockProxy = { enabled: true, url: OPTION_URL };
    mockSaved = true;
    r.rerender(
      <I18nProvider>
        <NetworkProxySettingsGroup />
      </I18nProvider>,
    );
    expect(r.container.querySelector("[data-proxy-saved]")).not.toBeNull();
    expect(r.container.querySelector<HTMLElement>('[data-proxy-option="on"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("关闭 → 只发 {enabled:false}（地址保留不随发送清空）", () => {
    mockProxy = { enabled: true, url: OPTION_URL };
    const r = renderGroup();
    fireEvent.click(r.container.querySelector<HTMLElement>('[data-proxy-option="off"]')!);
    expect(setProxyConfig).toHaveBeenCalledWith({ enabled: false });
    expect(r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!.value).toBe(OPTION_URL);
  });

  it("未填地址点开启 → 行内交代且零命令", () => {
    mockProxy = { enabled: false, url: "" };
    const r = renderGroup();
    fireEvent.click(r.container.querySelector<HTMLElement>('[data-proxy-option="on"]')!);
    expect(setProxyConfig).not.toHaveBeenCalled();
    expect(r.container.querySelector("[data-proxy-error]")!.textContent).toContain("地址");
  });

  it("在途（proxyInflight）→ 开关与输入禁用（不双发）", () => {
    mockProxy = { enabled: true, url: OPTION_URL };
    mockInflight = true;
    const r = renderGroup();
    expect(r.container.querySelector<HTMLButtonElement>('[data-proxy-option="off"]')!.disabled).toBe(true);
    expect(r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!.disabled).toBe(true);
  });
});

describe("网络代理：地址草稿与提交去重", () => {
  it("回车提交合法地址 → {url}（不夹带 enabled）；失焦同值不再发（去重）", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    fireEvent.change(input, { target: { value: "http://10.0.0.2:8080" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setProxyConfig).toHaveBeenCalledTimes(1);
    expect(setProxyConfig).toHaveBeenCalledWith({ url: "http://10.0.0.2:8080" });
    fireEvent.blur(input);
    expect(setProxyConfig).toHaveBeenCalledTimes(1);
  });

  it("未保存草稿不被读帧覆盖（get 回执后仍保留编辑值）", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    fireEvent.change(input, { target: { value: "http://draft.local:1080" } });
    // 读帧到达（外部权威值未变）
    r.rerender(
      <I18nProvider>
        <NetworkProxySettingsGroup />
      </I18nProvider>,
    );
    expect(r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!.value).toBe("http://draft.local:1080");
  });

  it("他字段回执（关闭开关且 url 未变）不覆盖草稿", () => {
    mockProxy = { enabled: true, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    fireEvent.change(input, { target: { value: "http://draft.local:1080" } });
    fireEvent.click(r.container.querySelector<HTMLElement>('[data-proxy-option="off"]')!);
    mockProxy = { enabled: false, url: OPTION_URL }; // 关闭回执（地址未变）
    mockSaved = true;
    r.rerender(
      <I18nProvider>
        <NetworkProxySettingsGroup />
      </I18nProvider>,
    );
    expect(r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!.value).toBe("http://draft.local:1080");
  });

  it("非法地址 → 行内交代零命令（草稿保留待修）", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    fireEvent.change(input, { target: { value: "http://host:8080/path" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setProxyConfig).not.toHaveBeenCalled();
    expect(r.container.querySelector("[data-proxy-error]")).not.toBeNull();
    expect(r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!.value).toBe("http://host:8080/path");
  });

  it("SOCKS5 地址 → 行内明说不支持（零命令）", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    fireEvent.change(input, { target: { value: "socks5://127.0.0.1:1080" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setProxyConfig).not.toHaveBeenCalled();
    expect(r.container.querySelector("[data-proxy-error]")!.textContent).toContain("SOCKS5");
  });

  it("启用态下编辑地址不回退：草稿与权威值一致后草稿收敛（清空编辑态）", () => {
    mockProxy = { enabled: true, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    fireEvent.change(input, { target: { value: "http://10.0.0.3:3128" } });
    fireEvent.keyDown(input, { key: "Enter" });
    mockProxy = { enabled: true, url: "http://10.0.0.3:3128" }; // set 回执
    mockSaved = true;
    r.rerender(
      <I18nProvider>
        <NetworkProxySettingsGroup />
      </I18nProvider>,
    );
    expect(r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!.value).toBe("http://10.0.0.3:3128");
    expect(r.container.querySelector("[data-proxy-saved]")).not.toBeNull();
  });
});

describe("网络代理：失败反馈", () => {
  it("断线 send false → 行内交代，不假已保存", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    setProxyConfig.mockReturnValueOnce(false);
    const r = renderGroup();
    fireEvent.click(r.container.querySelector<HTMLElement>('[data-proxy-option="on"]')!);
    expect(r.container.querySelector("[data-proxy-error]")).not.toBeNull();
    expect(r.container.querySelector("[data-proxy-saved]")).toBeNull();
  });

  it("daemon 拒绝（connection.error 尾缀 config.set_proxy）→ 行内原样交代", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    fireEvent.click(r.container.querySelector<HTMLElement>('[data-proxy-option="on"]')!);
    feedConnError("代理地址须为有效 HTTP/HTTPS 端点（命令 config.set_proxy）");
    expect(r.container.querySelector("[data-proxy-error]")!.textContent).toContain("代理地址须为有效");
  });

  it("别族命令拒绝（尾缀他命令）→ 不误挂本组错误", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    fireEvent.click(r.container.querySelector<HTMLElement>('[data-proxy-option="on"]')!);
    feedConnError("沙箱配置非法（命令 config.set_sandbox）");
    expect(r.container.querySelector("[data-proxy-error]")).toBeNull();
  });
});

describe("网络代理：说明与凭据显隐", () => {
  it("标注「保存后新请求生效」+ SOCKS5 不支持 + 本地直连（不覆盖浏览器/MCP/bash）", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    const note = r.container.querySelector("[data-proxy-note]")!.textContent ?? "";
    expect(note).toContain("下一次");
    expect(note).toContain("SOCKS5");
    expect(note).toContain("本地");
    expect(note).toContain("MCP");
  });

  it("地址含凭据 → 默认掩码（password）可显隐；无凭据 → 明文（无显隐钮）", () => {
    mockProxy = { enabled: true, url: "http://alice:s3cret@10.0.0.2:3128" };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    expect(input.type).toBe("password");
    fireEvent.click(r.container.querySelector<HTMLElement>("[data-proxy-reveal]")!);
    expect(r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!.type).toBe("text");
    cleanup();
    mockProxy = { enabled: true, url: OPTION_URL };
    const plain = renderGroup();
    expect(plain.container.querySelector<HTMLInputElement>("[data-proxy-url]")!.type).toBe("text");
    expect(plain.container.querySelector("[data-proxy-reveal]")).toBeNull();
  });
});

describe("网络代理：真实焦点顺序与连接恢复", () => {
  it("地址编辑后点启用：blur 不抢先发送，click 原子发送一次", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    const on = r.container.querySelector<HTMLButtonElement>('[data-proxy-option="on"]')!;
    fireEvent.change(input, { target: { value: "http://10.0.0.9:8080" } });
    fireEvent.blur(input, { relatedTarget: on });
    fireEvent.click(on);
    expect(setProxyConfig).toHaveBeenCalledTimes(1);
    expect(setProxyConfig).toHaveBeenCalledWith({ enabled: true, url: "http://10.0.0.9:8080" });
  });
  it("启用态清空地址先本地拒绝，不发空地址请求", () => {
    mockProxy = { enabled: true, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setProxyConfig).not.toHaveBeenCalled();
    expect(r.container.querySelector("[data-proxy-error]")).not.toBeNull();
  });
  it("断连后重连强制重拉现值；未保存草稿仍可重试同值", () => {
    mockProxy = { enabled: false, url: OPTION_URL };
    const r = renderGroup();
    const input = r.container.querySelector<HTMLInputElement>("[data-proxy-url]")!;
    fireEvent.change(input, { target: { value: "http://10.0.0.9:8080" } });
    fireEvent.keyDown(input, { key: "Enter" });
    mockConn = "disconnected";
    r.rerender(<I18nProvider><NetworkProxySettingsGroup /></I18nProvider>);
    expect(r.container.querySelector<HTMLButtonElement>('[data-proxy-option="on"]')!.disabled).toBe(true);
    mockConn = "connected";
    r.rerender(<I18nProvider><NetworkProxySettingsGroup /></I18nProvider>);
    expect(requestProxyConfig).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setProxyConfig).toHaveBeenCalledTimes(2);
  });
  it("校验错误与已保存反馈互斥", () => {
    mockProxy = { enabled: false, url: "" }; mockSaved = true;
    const r = renderGroup();
    fireEvent.click(r.container.querySelector<HTMLButtonElement>('[data-proxy-option="on"]')!);
    expect(r.container.querySelector("[data-proxy-error]")).not.toBeNull();
    expect(r.container.querySelector("[data-proxy-saved]")).toBeNull();
  });
  it("拉取未发出时每连接世代只退避重试一次", async () => {
    vi.useFakeTimers();
    requestProxyConfig.mockReturnValue(false);
    try {
      renderGroup();
      expect(requestProxyConfig).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(requestProxyConfig).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(requestProxyConfig).toHaveBeenCalledTimes(2);
    } finally { requestProxyConfig.mockReset(); vi.useRealTimers(); }
  });
});
