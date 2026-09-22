// @vitest-environment jsdom
/**
 * 向量模型 tab 测试（B2-③）：
 * - 端点行渲染：名称/baseUrl·model/key 尾 4 位脱敏/连通徽标（verifiedAt 持久态）；
 * - verify：点击 → verifying in-flight → embedding.verify.result 两判别回填；
 * - 新增/编辑弹层：非空校验（红边 + 内联错误）→ sendEmbeddingSet；
 * - 两段式 armed 删除（2.5s 超时复原，二击生效）。
 *
 * vi.mock SessionContext 先例（ModelsSettingsSection.test.tsx）。
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

import EmbeddingModelsTab from "./EmbeddingModelsTab";

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
  { id: "ep-2", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", kind: "embedding" as const, hasApiKey: true, keyMasked: "····3f3a", verifiedAt: 1_760_000_000_000 },
  { id: "ep-3", name: "Jev", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "classifier" as const, hasApiKey: true, keyMasked: "····9c2d", verifiedAt: null },
];

function feedList(endpoints: typeof ENDPOINTS) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "embedding",
    type: "embedding.list.result",
    ts: 1,
    payload: { endpoints },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of embeddingListeners) l(frame);
  });
}

function feedVerify(
  id: string,
  payload: { state: "ok"; dim: number } | { state: "ok"; prob: number } | { state: "fail"; error: string },
) {
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
        <EmbeddingModelsTab />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("向量模型 tab（B2-③）", () => {
  it("进入拉取：sendEmbeddingList；端点行渲染四要素（名称/url·model/脱敏 key/连通徽标）", () => {
    const { container } = ui();
    expect(sendEmbeddingList).toHaveBeenCalledTimes(1);
    act(() => feedList(ENDPOINTS));
    const row1 = container.querySelector("[data-emb-row=ep-1]")!;
    expect(row1.querySelector("[data-emb-name=ep-1]")!.textContent).toBe("Ollama 本地");
    expect(row1.querySelector("[data-emb-url=ep-1]")!.textContent).toContain("http://localhost:11434/v1 · bge-m3");
    // 未配 key 弱化「未配置」
    expect(row1.querySelector("[data-emb-nokey=ep-1]")!).not.toBeNull();
    const row2 = container.querySelector("[data-emb-row=ep-2]")!;
    expect(row2.querySelector("[data-emb-key=ep-2]")!.textContent).toContain("3f3a"); // 尾 4 位脱敏
    expect(row2.querySelector("[data-emb-conn=verified]")!).not.toBeNull(); // verifiedAt 持久态徽标
    expect(row1.querySelector("[data-emb-conn=unverified]")!).not.toBeNull();
  });

  it("空清单 → 空态提示（data-emb-empty）", () => {
    const { container } = ui();
    act(() => feedList([]));
    expect(container.querySelector("[data-emb-empty]")!.textContent).toContain("暂无端点");
  });

  it("verify：点击 → verifying in-flight → 回执 ok 徽标含 dim / fail toast", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    const verifyBtn = container.querySelector<HTMLButtonElement>("[data-emb-verify=ep-1]")!;
    fireEvent.click(verifyBtn);
    expect(sendEmbeddingVerify).toHaveBeenCalledWith("ep-1");
    expect(container.querySelector("[data-emb-conn=verifying]")!).not.toBeNull();
    expect(verifyBtn.disabled).toBe(true);
    act(() => feedVerify("ep-1", { state: "ok", dim: 1024 }));
    expect(container.querySelector("[data-emb-conn=ok]")!.textContent).toContain("1024");
    // fail 判别：err toast 交代 + fail 徽标
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-verify=ep-2]")!);
    act(() => feedVerify("ep-2", { state: "fail", error: "端点不可达" }));
    expect(container.querySelector("[data-emb-conn=fail]")!).not.toBeNull();
    // classifier 端点（B4a）：ok prob 判别——徽标显示百分比（限定 ep-3 行内）
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-verify=ep-3]")!);
    act(() => feedVerify("ep-3", { state: "ok", prob: 0.91 }));
    expect(container.querySelector("[data-emb-row=ep-3] [data-emb-conn=ok]")!.textContent).toContain("91");
  });

  it("内部分组（B4a）：embedding 与 classifier 两组标题各归其位", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    const embGroup = container.querySelector("[data-emb-group=embedding]")!;
    const clsGroup = container.querySelector("[data-emb-group=classifier]")!;
    expect(embGroup).not.toBeNull();
    expect(clsGroup).not.toBeNull();
    expect(embGroup.querySelectorAll("[data-emb-row]")).toHaveLength(2); // ep-1 + ep-2
    expect(clsGroup.querySelectorAll("[data-emb-row]")).toHaveLength(1); // ep-3
    expect(clsGroup.querySelector("[data-emb-name=ep-3]")!.textContent).toBe("Jev");
    // 空组不渲染标题：只有 embedding 端点时无 classifier 组
    const { container: onlyEmb } = ui();
    act(() => feedList(ENDPOINTS.filter((e) => e.kind === "embedding")));
    expect(onlyEmb.querySelector("[data-emb-group=classifier]")).toBeNull();
  });

  it("新增弹层：非空校验红边 + 内联错误 → 三字段齐 → sendEmbeddingSet", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-add]")!);
    expect(container.querySelector("[data-emb-form-name]")).not.toBeNull();
    // 空表单保存 → 内联错误
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-form-save]")!);
    expect(container.querySelector("[data-emb-form-err]")!.textContent).toContain("不得为空");
    // 填齐三字段（apiKey 留空不携带）
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-emb-form-name]")!, { target: { value: "新端点" } });
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-emb-form-baseurl]")!, { target: { value: "http://x/v1" } });
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-emb-form-model]")!, { target: { value: "m1" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-form-save]")!);
    expect(sendEmbeddingSet).toHaveBeenCalledWith({ name: "新端点", baseUrl: "http://x/v1", model: "m1", kind: "embedding" });
    expect(container.querySelector("[data-emb-form-name]")).toBeNull(); // 弹层关闭
  });

  it("新增弹层（B4a）：用途选择器切 classifier → placeholder 切换 + kind 透传", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-add]")!);
    // 切用途 → baseUrl/model placeholder 随 kind 切换
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-kind-opt=classifier]")!);
    expect(container.querySelector<HTMLInputElement>("[data-emb-form-baseurl]")!.placeholder).toBe("https://api.typesafe.ai/v1");
    expect(container.querySelector<HTMLInputElement>("[data-emb-form-model]")!.placeholder).toBe("jev-latest");
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-emb-form-name]")!, { target: { value: "Jev 云端" } });
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-emb-form-baseurl]")!, { target: { value: "https://api.typesafe.ai/v1" } });
    fireEvent.change(container.querySelector<HTMLInputElement>("[data-emb-form-model]")!, { target: { value: "jev-latest" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-form-save]")!);
    expect(sendEmbeddingSet).toHaveBeenCalledWith({ name: "Jev 云端", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "classifier" });
  });

  it("编辑弹层回填现值（apiKey 编辑位留空 = 不携带；kind 回填——凭据只进不出）", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-edit=ep-1]")!);
    expect(container.querySelector<HTMLInputElement>("[data-emb-form-name]")!.value).toBe("Ollama 本地");
    expect(container.querySelector<HTMLInputElement>("[data-emb-form-baseurl]")!.value).toBe("http://localhost:11434/v1");
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-form-save]")!);
    expect(sendEmbeddingSet).toHaveBeenCalledWith({ id: "ep-1", name: "Ollama 本地", baseUrl: "http://localhost:11434/v1", model: "bge-m3", kind: "embedding" });
    // classifier 端点编辑：kind 回填 classifier
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-edit=ep-3]")!);
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-form-save]")!);
    expect(sendEmbeddingSet).toHaveBeenLastCalledWith({ id: "ep-3", name: "Jev", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", kind: "classifier" });
  });

  it("两段式 armed 删除：首击 armed（2.5s 复原）→ 二击 sendEmbeddingDelete", () => {
    vi.useFakeTimers();
    try {
      const { container } = ui();
      act(() => feedList(ENDPOINTS));
      const del = container.querySelector<HTMLButtonElement>("[data-emb-delete=ep-1]")!;
      fireEvent.click(del);
      expect(del.dataset.armed).toBe("1");
      expect(sendEmbeddingDelete).not.toHaveBeenCalled();
      fireEvent.click(del);
      expect(sendEmbeddingDelete).toHaveBeenCalledWith("ep-1");
      // 复原计时：另一行首击 armed 后 2.5s 自动复原
      const del2 = container.querySelector<HTMLButtonElement>("[data-emb-delete=ep-2]")!;
      fireEvent.click(del2);
      expect(del2.dataset.armed).toBe("1");
      act(() => {
        vi.advanceTimersByTime(2600);
      });
      expect(del2.dataset.armed).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
