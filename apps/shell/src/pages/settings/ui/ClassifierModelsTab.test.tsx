// @vitest-environment jsdom
/**
 * 分类模型 tab 测试（判官 pi-ai 批——从向量 tab 拆出）：
 * - 端点行渲染：名称/model/通道徽标（pi-ai 目录 | Jev 直连）/脱敏 key/
 *   连通徽标（prob 变体）；向量端点不渲染（各归其 tab）；
 * - verify：点击 → verifying → embedding.verify.result prob 判别回填；
 * - 新增弹层（pi-ai 缺省）：无 baseUrl 输入 → name/model 即可保存，
 *   set 透传 kind=classifier + variant=pi-ai 且不携带 baseUrl；
 * - 通道切换（Jev 直连）：baseUrl 输入出现 + 必填校验；
 * - 编辑回填：variant/model 回填，apiKey 留空不携带。
 *
 * vi.mock SessionContext 先例（EmbeddingModelsTab.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

const sendEmbeddingList = vi.fn(() => true);
const sendEmbeddingSet = vi.fn(() => true);
const sendEmbeddingDelete = vi.fn(() => true);
const sendEmbeddingSetDefault = vi.fn(() => true);
const sendEmbeddingVerify = vi.fn(() => true);
let embeddingListeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      sendEmbeddingList,
      sendEmbeddingSet,
      sendEmbeddingDelete,
      sendEmbeddingSetDefault,
      sendEmbeddingVerify,
      subscribeEmbeddingFrames: (listener: (e: EventEnvelope) => void) => {
        embeddingListeners.push(listener);
        return () => {
          embeddingListeners = embeddingListeners.filter((l) => l !== listener);
        };
      },
    }),
  };
});

import ClassifierModelsTab from "./ClassifierModelsTab";

beforeEach(() => {
  localStorage.setItem("helix-lang", "zh-CN");
});

afterEach(() => {
  cleanup();
  embeddingListeners = [];
  vi.clearAllMocks();
});

const ENDPOINTS = [
  { id: "ep-1", name: "Ollama 本地", baseUrl: "http://localhost:11434/v1", model: "bge-m3", kind: "embedding" as const, hasApiKey: false, keyMasked: undefined, verifiedAt: null },
  { id: "ep-3", name: "Jev 直连端点", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "classifier" as const, hasApiKey: true, keyMasked: "····9c2d", verifiedAt: null },
  { id: "ep-4", name: "目录判官", baseUrl: "", model: "typesafe/jev-latest", kind: "classifier" as const, variant: "pi-ai", hasApiKey: false, keyMasked: undefined, verifiedAt: 1_760_000_000_000 },
];

function feedList(endpoints: typeof ENDPOINTS, defaultClassifierEndpointId: string | null = null) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "embedding",
    type: "embedding.list.result",
    ts: 1,
    payload: { endpoints, defaultClassifierEndpointId },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of embeddingListeners) l(frame);
  });
}

function feedVerify(id: string, payload: { state: "ok"; prob: number } | { state: "fail"; error: string }) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "embedding",
    type: "embedding.verify.result",
    ts: 1,
    payload: { id, ...payload },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of embeddingListeners) l(frame);
  });
}

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <ClassifierModelsTab />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("分类模型 tab（判官 pi-ai 批）", () => {
  it("进入拉取：仅渲染 classifier 端点——通道徽标区分 pi-ai/直连，向量端点不出现", () => {
    const { container } = ui();
    expect(sendEmbeddingList).toHaveBeenCalledTimes(1);
    act(() => feedList(ENDPOINTS));
    expect(container.querySelector("[data-clf-row=ep-1]")).toBeNull(); // 向量端点归向量 tab
    const direct = container.querySelector("[data-clf-row=ep-3]")!;
    expect(direct.querySelector("[data-clf-name=ep-3]")!.textContent).toBe("Jev 直连端点");
    expect(direct.querySelector("[data-clf-model=ep-3]")!.textContent).toContain("jev-latest");
    expect(direct.querySelector("[data-clf-variant=ep-3]")!.textContent).toContain("直连"); // 缺省 variant = jev
    expect(direct.querySelector("[data-clf-key=ep-3]")!.textContent).toContain("9c2d");
    const catalog = container.querySelector("[data-clf-row=ep-4]")!;
    expect(catalog.querySelector("[data-clf-variant=ep-4]")!.textContent).toContain("目录"); // pi-ai
    expect(catalog.querySelector("[data-clf-nokey=ep-4]")!).not.toBeNull(); // provider key 回落——可不配
    expect(catalog.querySelector("[data-clf-conn=verified]")!).not.toBeNull(); // verifiedAt 持久态
  });

  it("空清单（或仅向量端点）→ 空态提示", () => {
    const { container } = ui();
    act(() => feedList([ENDPOINTS[0]!]));
    expect(container.querySelector("[data-clf-empty]")!.textContent).toContain("暂无分类端点");
  });

  it("verify：点击 → verifying in-flight → prob 判别回填徽标", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    const verifyBtn = container.querySelector<HTMLButtonElement>("[data-clf-verify=ep-4]")!;
    fireEvent.click(verifyBtn);
    expect(sendEmbeddingVerify).toHaveBeenCalledWith("ep-4");
    expect(container.querySelector("[data-clf-conn=verifying]")!).not.toBeNull();
    expect(verifyBtn.disabled).toBe(true);
    act(() => feedVerify("ep-4", { state: "ok", prob: 0.96 }));
    expect(container.querySelector("[data-clf-row=ep-4] [data-clf-conn=ok]")!.textContent).toContain("96");
  });

  it("新增（pi-ai 目录缺省）：无 baseUrl 输入，name/model 即可保存——set 透传 kind+variant 且不带 baseUrl", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-add]")!);
    // pi-ai 缺省：baseUrl 输入不渲染
    expect(container.querySelector("[data-clf-form-baseurl]")).toBeNull();
    expect(container.querySelector<HTMLInputElement>("[data-clf-form-model]")!.placeholder).toBe("typesafe/jev-latest");
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-clf-form-name]")!, { target: { value: "新判官" } });
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-clf-form-model]")!, { target: { value: "typesafe/jev-latest" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-form-save]")!);
    expect(sendEmbeddingSet).toHaveBeenCalledWith({
      name: "新判官",
      model: "typesafe/jev-latest",
      kind: "classifier",
      variant: "pi-ai",
    });
    expect(container.querySelector("[data-clf-form-name]")).toBeNull(); // 弹层关闭
  });

  it("通道切换 Jev 直连：baseUrl 输入出现 + 必填校验 → set 带 baseUrl + variant=jev", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-add]")!);
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-variant-opt=jev]")!);
    expect(container.querySelector<HTMLInputElement>("[data-clf-form-baseurl]")!).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("[data-clf-form-model]")!.placeholder).toBe("jev-latest");
    // name/model 有值但 baseUrl 空 → 内联错误
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-clf-form-name]")!, { target: { value: "Jev 云端" } });
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-clf-form-model]")!, { target: { value: "jev-latest" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-form-save]")!);
    expect(container.querySelector("[data-clf-form-err]")!.textContent).toContain("不得为空");
    expect(sendEmbeddingSet).not.toHaveBeenCalled();
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-clf-form-baseurl]")!, { target: { value: "https://api.typesafe.ai/v1" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-form-save]")!);
    expect(sendEmbeddingSet).toHaveBeenCalledWith({
      name: "Jev 云端",
      baseUrl: "https://api.typesafe.ai/v1",
      model: "jev-latest",
      kind: "classifier",
      variant: "jev",
    });
  });

  it("编辑回填：pi-ai 端点回填 variant/model（apiKey 留空不携带——凭据只进不出）", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-edit=ep-4]")!);
    expect(container.querySelector<HTMLInputElement>("[data-clf-form-name]")!.value).toBe("目录判官");
    expect(container.querySelector<HTMLInputElement>("[data-clf-form-model]")!.value).toBe("typesafe/jev-latest");
    expect(container.querySelector("[data-clf-variant-opt=pi-ai]")!.className).toContain("hud-btn-cyan"); // variant 回填
    expect(container.querySelector("[data-clf-form-baseurl]")).toBeNull(); // pi-ai 免 baseUrl
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-form-save]")!);
    expect(sendEmbeddingSet).toHaveBeenCalledWith({
      id: "ep-4",
      name: "目录判官",
      model: "typesafe/jev-latest",
      kind: "classifier",
      variant: "pi-ai",
    });
  });

  it("两段式 armed 删除：首击 armed → 二击 sendEmbeddingDelete", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    const del = container.querySelector<HTMLButtonElement>("[data-clf-delete=ep-3]")!;
    fireEvent.click(del);
    expect(del.dataset.armed).toBe("1");
    expect(sendEmbeddingDelete).not.toHaveBeenCalled();
    fireEvent.click(del);
    expect(sendEmbeddingDelete).toHaveBeenCalledWith("ep-3");
  });
});

describe("D1 全局默认分类模型（渐进收编 UI 契约）", () => {
  it("全局默认卡：未设默认 → 弱化提示 + 无默认引导条；设默认 → 展示 name·model 且引导条消失", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    expect(container.querySelector("[data-clf-global-default]")).not.toBeNull();
    expect(container.querySelector("[data-clf-global-default-unset]")).not.toBeNull();
    expect(container.querySelector("[data-clf-global-default-value]")).toBeNull();
    expect(container.querySelector("[data-clf-no-default]")).not.toBeNull();
    act(() => feedList(ENDPOINTS, "ep-4"));
    expect(container.querySelector("[data-clf-global-default-value]")!.textContent).toBe("目录判官 · typesafe/jev-latest");
    expect(container.querySelector("[data-clf-global-default-unset]")).toBeNull();
    expect(container.querySelector("[data-clf-no-default]")).toBeNull();
  });

  it("行内「设为默认」按钮 + 默认徽标：点击发 set_default(kind=classifier)；徽标只挂默认行、按钮只在非默认行", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS, "ep-3"));
    expect(container.querySelector("[data-clf-default=ep-3]")).not.toBeNull();
    expect(container.querySelector("[data-clf-default=ep-4]")).toBeNull();
    expect(container.querySelector("[data-clf-set-default=ep-3]")).toBeNull(); // 默认行不显按钮
    fireEvent.click(container.querySelector("[data-clf-set-default=ep-4]")!);
    expect(sendEmbeddingSetDefault).toHaveBeenCalledWith("ep-4", "classifier");
  });

  it("修改口交互：点「设置默认模型」开面板 → 选端点即 set_default(kind=classifier) + 关面板；默认项带 sel+chip", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS, "ep-3"));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-change-default]")!);
    expect(container.querySelector("[data-clf-default-picker]")).not.toBeNull();
    expect(container.querySelector("[data-clf-default-picker-item=ep-3]")!.className).toContain("sel");
    expect(container.querySelector("[data-clf-default-picker-item=ep-4]")).not.toBeNull();
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-default-picker-item=ep-4]")!);
    expect(sendEmbeddingSetDefault).toHaveBeenCalledWith("ep-4", "classifier");
    expect(container.querySelector("[data-clf-default-picker]")).toBeNull(); // 成功关面板
  });

  it("修改口空态：无 classifier 端点 → 面板内空态提示", () => {
    const { container } = ui();
    act(() => feedList([], null));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-clf-change-default]")!);
    expect(container.querySelector("[data-clf-default-picker-empty]")).not.toBeNull();
  });
});
