// @vitest-environment jsdom
/**
 * 三方平台 tab 测试（三方平台批 II：结构化表单）：
 * - 平台行渲染：名称/api 风格徽标/baseUrl·模型清单/脱敏 key chip（未配 = 「去配 Key」）；
 * - 新增弹层：非空校验（红边内联错误）→「添加模型」逐行录入（id/上下文必填，
 *   名称/最大输出/推理/价格选填）→ sendProviderSet 载荷形状（api + 价格）；
 * - API 风格下拉（OpenAI / Anthropic）；
 * - 编辑弹层：id 锁定 + 结构化回显（价格 0 = 未知 → 空输入）+ upsert 载荷；
 * - 两段式 armed 删除（二击生效）。
 *
 * vi.mock SessionContext 先例（EmbeddingModelsTab.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope, ProviderView } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

const sendProviderList = vi.fn(() => true);
const sendProviderSet = vi.fn(() => true);
const sendProviderDelete = vi.fn(() => true);
const verifyProvider = vi.fn(() => true);
const pullModelCatalog = vi.fn(() => true);
let providerListeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      sendProviderList,
      sendProviderSet,
      sendProviderDelete,
      verifyProvider,
      pullModelCatalog,
      topology: { modelConfig: { auth: {} } },
      subscribeProviderFrames: (listener: (e: EventEnvelope) => void) => {
        providerListeners.push(listener);
        return () => {
          providerListeners = providerListeners.filter((l) => l !== listener);
        };
      },
    }),
  };
});

import CustomProvidersTab from "./CustomProvidersTab";

beforeEach(() => {
  localStorage.setItem("helix-lang", "zh-CN");
});

afterEach(() => {
  cleanup();
  providerListeners = [];
  vi.clearAllMocks();
});

const PROVIDERS: ProviderView[] = [
  {
    id: "volcengine-plan",
    name: "火山方舟 Agent Plan",
    api: "openai-completions",
    thinkingFormat: "deepseek",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    models: [
      { id: "kimi-k3", name: "kimi-k3", contextWindow: 256_000, maxTokens: 16_384, reasoning: true, inputPrice: 0, outputPrice: 0 },
      { id: "glm-5.3", name: "glm-5.3", contextWindow: 128_000, maxTokens: 16_384, reasoning: false, inputPrice: 0.6, outputPrice: 2.5 },
    ],
    hasApiKey: true,
    keyMasked: "····7f3a",
  },
  {
    id: "my-gateway",
    name: "my-gateway",
    api: "anthropic-messages",
    thinkingFormat: "auto",
    baseUrl: "http://localhost:3000/v1",
    models: [{ id: "gpt-x", name: "gpt-x", contextWindow: 128_000, maxTokens: 16_384, reasoning: false, inputPrice: 0, outputPrice: 0 }],
    hasApiKey: false,
  },
];

function feedList(providers: ProviderView[]) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "provider",
    type: "provider.list.result",
    ts: 1,
    payload: { providers },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of providerListeners) l(frame);
  });
}

function ui(onGoAuth = vi.fn()) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <CustomProvidersTab onGoAuth={onGoAuth} />
      </ToastProvider>
    </I18nProvider>,
  );
}

/** 行字段快捷填充（attr 可为 "name" 或 "name=value"——数字值自动加引号成合法选择器）。 */
function fill(container: HTMLElement, attr: string, value: string): void {
  const eq = attr.indexOf("=");
  const selector = eq === -1 ? `[${attr}]` : `[${attr.slice(0, eq)}="${attr.slice(eq + 1)}"]`;
  fireEvent.change(container.querySelector(selector)!, { target: { value } });
}

describe("三方平台 tab（三方平台批 II：结构化表单）", () => {
  it("进入拉取：sendProviderList；平台行渲染（名称/api 徽标/url·模型/脱敏 key/未配去配 Key）", () => {
    const goAuth = vi.fn();
    const { container } = ui(goAuth);
    expect(sendProviderList).toHaveBeenCalledTimes(1);
    act(() => feedList(PROVIDERS));
    const row1 = container.querySelector("[data-cprov-row=volcengine-plan]")!;
    expect(row1.querySelector("[data-cprov-name=volcengine-plan]")!.textContent).toBe("火山方舟 Agent Plan");
    expect(row1.querySelector("[data-cprov-api=volcengine-plan]")!.textContent).toBe("OpenAI");
    expect(row1.querySelector("[data-cprov-url=volcengine-plan]")!.textContent).toContain(
      "https://ark.cn-beijing.volces.com/api/plan/v3 · kimi-k3, glm-5.3",
    );
    expect(row1.querySelector("[data-cprov-key=volcengine-plan]")!.textContent).toContain("7f3a");
    // anthropic 徽标 + 未配 key：「去配 Key」按钮 → onGoAuth 回调（父层切对话模型 tab）
    const row2 = container.querySelector("[data-cprov-row=my-gateway]")!;
    expect(row2.querySelector("[data-cprov-api=my-gateway]")!.textContent).toBe("Anthropic");
    fireEvent.click(row2.querySelector("[data-cprov-goauth=my-gateway]")!);
    expect(goAuth).toHaveBeenCalledTimes(1);
  });

  it("空清单 → 空态提示（data-cprov-empty）", () => {
    const { container } = ui();
    act(() => feedList([]));
    expect(container.querySelector("[data-cprov-empty]")!).not.toBeNull();
  });

  it("Bug 修复批（目录缓存失效）：provider.list.result 回执到达 → pullModelCatalog 重拉（写后 P-3/设置页目录面即时反映）", () => {
    ui();
    expect(pullModelCatalog).not.toHaveBeenCalled(); // 首进未收到回执不拉
    act(() => feedList(PROVIDERS));
    expect(pullModelCatalog).toHaveBeenCalledTimes(1); // 回执即静默重拉
  });

  it("新增弹层：必填校验红边（上下文窗口）→「添加模型」逐行录入 → 载荷含 api/价格", () => {
    const { container } = ui();
    act(() => feedList([]));
    fireEvent.click(container.querySelector("[data-cprov-add]")!);
    // 平台 id/baseUrl 空 + 行必填空 → 内联错误，不发送
    fireEvent.click(container.querySelector("[data-cprov-form-save]")!);
    expect(sendProviderSet).not.toHaveBeenCalled();
    expect(container.querySelector("[data-cprov-form-err]")!.className).toContain("show");
    // 平台三件套
    fill(container, "data-cprov-form-id", "volcengine-plan");
    fill(container, "data-cprov-form-name", "火山方舟 Agent Plan");
    fill(container, "data-cprov-form-baseurl", "https://ark.cn-beijing.volces.com/api/plan/v3");
    // 首行只填 id 不填上下文 → 行级校验失败
    fill(container, "data-cprov-mrow-id=0", "kimi-k3");
    fireEvent.click(container.querySelector("[data-cprov-form-save]")!);
    expect(sendProviderSet).not.toHaveBeenCalled();
    // 补必填上下文 + 选填列（名称/最大输出/推理/价格）
    fill(container, "data-cprov-mrow-ctx=0", "256000");
    fill(container, "data-cprov-mrow-in=0", "0.6");
    fill(container, "data-cprov-mrow-out=0", "2.5");
    fireEvent.click(container.querySelector('[data-cprov-mrow-reasoning="0"]')!);
    // 添加第二行：裸必填（其余选填缺省）
    fireEvent.click(container.querySelector("[data-cprov-mrow-add]")!);
    fill(container, "data-cprov-mrow-id=1", "deepseek-v4-flash");
    fill(container, "data-cprov-mrow-ctx=1", "128000");
    fireEvent.click(container.querySelector("[data-cprov-form-save]")!);
    expect(sendProviderSet).toHaveBeenCalledTimes(1);
    expect(sendProviderSet).toHaveBeenCalledWith({
      id: "volcengine-plan",
      name: "火山方舟 Agent Plan",
      api: "openai-completions",
      thinkingFormat: "auto",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      models: [
        { id: "kimi-k3", contextWindow: 256_000, inputPrice: 0.6, outputPrice: 2.5, reasoning: true },
        { id: "deepseek-v4-flash", contextWindow: 128_000 },
      ],
    });
  });

  it("API 风格下拉切 Anthropic → 载荷 api=anthropic-messages", () => {
    const { container } = ui();
    act(() => feedList([]));
    fireEvent.click(container.querySelector("[data-cprov-add]")!);
    fill(container, "data-cprov-form-id", "my-gateway");
    fill(container, "data-cprov-form-baseurl", "http://localhost:3000/v1");
    fireEvent.change(container.querySelector("[data-cprov-form-api]")!, { target: { value: "anthropic-messages" } });
    fill(container, "data-cprov-mrow-id=0", "claude-x");
    fill(container, "data-cprov-mrow-ctx=0", "200000");
    fireEvent.click(container.querySelector("[data-cprov-form-save]")!);
    expect(sendProviderSet).toHaveBeenCalledWith(
      expect.objectContaining({ api: "anthropic-messages", models: [{ id: "claude-x", contextWindow: 200_000 }] }),
    );
  });

  it("批 III：思考控制下拉切 deepseek → 载荷 thinkingFormat=deepseek（TR-159 帧级断言钉死透传）", () => {
    const { container } = ui();
    act(() => feedList([]));
    fireEvent.click(container.querySelector("[data-cprov-add]")!);
    fill(container, "data-cprov-form-id", "volcengine-plan");
    fill(container, "data-cprov-form-baseurl", "https://ark.cn-beijing.volces.com/api/plan/v3");
    fireEvent.change(container.querySelector("[data-cprov-form-thinking]")!, { target: { value: "deepseek" } });
    fill(container, "data-cprov-mrow-id=0", "kimi-k3");
    fill(container, "data-cprov-mrow-ctx=0", "256000");
    fireEvent.click(container.querySelector("[data-cprov-form-save]")!);
    expect(sendProviderSet).toHaveBeenCalledTimes(1);
    expect(sendProviderSet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "volcengine-plan", thinkingFormat: "deepseek" }),
    );
  });

  it("编辑弹层：id 锁定 + 结构化回显（价格 0 → 空；非 0 → 数值）+ 行删除 + upsert 载荷", () => {
    const { container } = ui();
    act(() => feedList(PROVIDERS));
    fireEvent.click(container.querySelector("[data-cprov-edit=volcengine-plan]")!);
    const idInput = container.querySelector("[data-cprov-form-id]")! as HTMLInputElement;
    expect(idInput.disabled).toBe(true);
    expect(idInput.value).toBe("volcengine-plan");
    // 回显：首行（价格 0 = 未知 → 空输入；reasoning true）
    expect((container.querySelector('[data-cprov-mrow-id="0"]') as HTMLInputElement).value).toBe("kimi-k3");
    expect((container.querySelector('[data-cprov-mrow-ctx="0"]') as HTMLInputElement).value).toBe("256000");
    expect((container.querySelector('[data-cprov-mrow-in="0"]') as HTMLInputElement).value).toBe("");
    // 次行（价格非 0 → 数值回显）
    expect((container.querySelector('[data-cprov-mrow-id="1"]') as HTMLInputElement).value).toBe("glm-5.3");
    expect((container.querySelector('[data-cprov-mrow-in="1"]') as HTMLInputElement).value).toBe("0.6");
    expect((container.querySelector('[data-cprov-mrow-out="1"]') as HTMLInputElement).value).toBe("2.5");
    // 删除次行（保留 1 行时行删除按钮仍在——modelRows > 1）
    fireEvent.click(container.querySelector('[data-cprov-mrow-del="1"]')!);
    fireEvent.click(container.querySelector("[data-cprov-form-save]")!);
    expect(sendProviderSet).toHaveBeenCalledWith({
      id: "volcengine-plan",
      name: "火山方舟 Agent Plan",
      api: "openai-completions",
      thinkingFormat: "deepseek",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      models: [{ id: "kimi-k3", contextWindow: 256_000, maxTokens: 16_384, reasoning: true }],
    });
  });

  it("两段式 armed 删除：一击武装二击生效", () => {
    const { container } = ui();
    act(() => feedList(PROVIDERS));
    const btn = container.querySelector("[data-cprov-delete=volcengine-plan]")! as HTMLButtonElement;
    fireEvent.click(btn);
    expect(sendProviderDelete).not.toHaveBeenCalled();
    expect(btn.dataset.armed).toBe("1");
    fireEvent.click(btn);
    expect(sendProviderDelete).toHaveBeenCalledWith("volcengine-plan");
  });

  it("测试按钮 → verifyProvider（auth.verify 既有通路）", () => {
    const { container } = ui();
    act(() => feedList(PROVIDERS));
    fireEvent.click(container.querySelector("[data-cprov-verify=my-gateway]")!);
    expect(verifyProvider).toHaveBeenCalledWith("my-gateway");
  });
});
