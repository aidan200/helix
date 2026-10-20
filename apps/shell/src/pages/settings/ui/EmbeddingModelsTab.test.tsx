// @vitest-environment jsdom
/**
 * 向量模型 tab 测试（B2-③；分类拆独立 tab 后收窄为纯向量端点面）：
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

function feedList(endpoints: typeof ENDPOINTS, defaultEndpointId: string | null = null) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "embedding",
    type: "embedding.list.result",
    ts: 1,
    payload: { endpoints, defaultEndpointId },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of embeddingListeners) l(frame);
  });
}

function feedVerify(
  id: string,
  payload:
    | { state: "ok"; kind: "embedding"; dim: number }
    | { state: "ok"; kind: "classifier"; prob: number }
    | { state: "fail"; error: string },
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

/** daemon 命令失败回执（connection.error——commandError 尾缀「（命令 <type>）」）。 */
function feedConnError(message: string) {
  const frame = {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "notification",
    type: "connection.error",
    ts: 1,
    payload: { code: "command.invalid_payload", message },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of embeddingListeners) l(frame);
  });
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
    act(() => feedVerify("ep-1", { state: "ok", kind: "embedding", dim: 1024 }));
    expect(container.querySelector("[data-emb-conn=ok]")!.textContent).toContain("1024");
    // 判别位窄化（B4）：kind=classifier 的 ok 回执走 prob 显示面（不误走 dim 分支）
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-verify=ep-2]")!);
    act(() => feedVerify("ep-2", { state: "ok", kind: "classifier", prob: 0.87 }));
    expect(container.querySelector('[data-emb-row="ep-2"] [data-emb-conn=ok]')!.textContent).toContain("87");
    // fail 判别：err toast 交代 + fail 徽标（文案无空尾——旧实现传 reason:"" 渲染「验证失败 · 」）
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-verify=ep-2]")!);
    act(() => feedVerify("ep-2", { state: "fail", error: "端点不可达" }));
    const failBadge = container.querySelector("[data-emb-conn=fail]")!;
    expect(failBadge.textContent).toBe("验证失败");
    expect(failBadge.getAttribute("title")).toBe("端点不可达"); // 原因在 title（不双重展示）
  });

  it("verifiedAt 持久态徽标：刚刚档显示「刚刚」（不复用目录刷新文案带 0 providers）", () => {
    const { container } = ui();
    act(() => feedList([{ ...ENDPOINTS[1]!, id: "ep-now", verifiedAt: Date.now() }] as typeof ENDPOINTS));
    const badge = container.querySelector("[data-emb-conn=verified]")!;
    expect(badge.textContent).toBe("刚刚");
    expect(badge.textContent).not.toContain("providers");
  });

  it("收窄（分类拆 tab）：仅渲染 embedding 端点——classifier 端点（ep-3）不出现在本 tab", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    const embGroup = container.querySelector("[data-emb-group=embedding]")!;
    expect(embGroup.querySelectorAll("[data-emb-row]")).toHaveLength(2); // ep-1 + ep-2
    expect(container.querySelector("[data-emb-row=ep-3]")).toBeNull(); // 分类端点归分类 tab
    // 纯 embedding 清单 → 无空组标题问题（恒单组）
    const { container: onlyEmb } = ui();
    act(() => feedList(ENDPOINTS.filter((e) => e.kind === "embedding")));
    expect(onlyEmb.querySelectorAll("[data-emb-row]")).toHaveLength(2);
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
    expect(sendEmbeddingSet).toHaveBeenCalledWith({ name: "新端点", baseUrl: "http://x/v1", model: "m1" });
    expect(container.querySelector("[data-emb-form-name]")).toBeNull(); // 弹层关闭
  });

  it("编辑弹层回填现值（apiKey 编辑位留空 = 不携带；kind 回填——凭据只进不出）", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-edit=ep-1]")!);
    expect(container.querySelector<HTMLInputElement>("[data-emb-form-name]")!.value).toBe("Ollama 本地");
    expect(container.querySelector<HTMLInputElement>("[data-emb-form-baseurl]")!.value).toBe("http://localhost:11434/v1");
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-form-save]")!);
    expect(sendEmbeddingSet).toHaveBeenCalledWith({ id: "ep-1", name: "Ollama 本地", baseUrl: "http://localhost:11434/v1", model: "bge-m3" });
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

describe("全局默认 embedding 端点（批1 WP-A）", () => {
  it("「默认」徽标只挂默认端点行；「设为默认」动作在非默认行，点击发 embedding.set_default", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS, "ep-1"));
    expect(container.querySelector("[data-emb-default=ep-1]")!.textContent).toContain("默认");
    expect(container.querySelector("[data-emb-default=ep-2]")).toBeNull();
    expect(container.querySelector("[data-emb-set-default=ep-1]")).toBeNull(); // 默认行不再提供设默认
    const setDefault = container.querySelector<HTMLButtonElement>("[data-emb-set-default=ep-2]")!;
    fireEvent.click(setDefault);
    expect(sendEmbeddingSetDefault).toHaveBeenCalledWith("ep-2");
  });

  it("无默认端点 → tab 顶部引导条（记忆/知识库向量面不可用）；设默认后消失", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS, null));
    const hint = container.querySelector("[data-emb-no-default]")!;
    expect(hint.textContent).toMatch(/未设置默认 embedding 端点/);
    act(() => feedList(ENDPOINTS, "ep-1"));
    expect(container.querySelector("[data-emb-no-default]")).toBeNull();
  });

  it("默认端点删除（armed 态）→ 补充确认提示「删除后记忆与知识库向量面将不可用」", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS, "ep-1"));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-delete=ep-1]")!);
    const hint = container.querySelector("[data-emb-delete-default-hint=ep-1]")!;
    expect(hint.textContent).toMatch(/默认 embedding 端点/);
    expect(hint.textContent).toMatch(/不可用/);
    // 非默认端点 armed 无该提示
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-delete=ep-2]")!);
    expect(container.querySelector("[data-emb-delete-default-hint=ep-2]")).toBeNull();
  });
});

describe("D1 全局默认向量模型卡（F(3.4).6 同构 UI 契约）", () => {
  it("未设默认 → 弱化提示；设默认 → 只读展示 name·model；卡内「设置默认模型」修改口 + 列表行辅助入口", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS));
    expect(container.querySelector("[data-emb-global-default]")).not.toBeNull();
    expect(container.querySelector("[data-emb-global-default-unset]")).not.toBeNull();
    expect(container.querySelector("[data-emb-global-default-value]")).toBeNull();
    // 卡内修改口（LLM F(3.4).6 同构：按钮点开选择器）
    expect(container.querySelector<HTMLButtonElement>("[data-emb-change-default]")).not.toBeNull();
    act(() => feedList(ENDPOINTS, "ep-1"));
    expect(container.querySelector("[data-emb-global-default-value]")!.textContent).toBe("Ollama 本地 · bge-m3");
    expect(container.querySelector("[data-emb-global-default-unset]")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>("[data-emb-set-default=ep-2]")).not.toBeNull(); // 列表行辅助入口保留
  });

  it("修改口交互：点「设置默认模型」开面板 → 选端点即 set_default；回执新默认才关面板；默认项带 sel+chip", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS, "ep-1"));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-change-default]")!);
    const panel = container.querySelector("[data-emb-default-picker]")!;
    expect(panel).not.toBeNull();
    // 默认项 sel + 默认 chip；两项齐列
    expect(container.querySelector("[data-emb-default-picker-item=ep-1]")!.className).toContain("sel");
    expect(container.querySelector("[data-emb-default-picker-item=ep-2]")).not.toBeNull();
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-default-picker-item=ep-2]")!);
    expect(sendEmbeddingSetDefault).toHaveBeenCalledWith("ep-2");
    // 结果帧驱动收口（族B：不乐观关面板——daemon 三拒无 list 回执，乐观关面板会吞掉输入面）
    expect(container.querySelector("[data-emb-default-picker]")).not.toBeNull();
    act(() => feedList(ENDPOINTS, "ep-2"));
    expect(container.querySelector("[data-emb-default-picker]")).toBeNull(); // 回执新默认 → 关面板
  });

  it("set_default 被 daemon 拒 → 行内交代原因 + 面板不关（尾缀归因：他命令拒绝不误消费）", () => {
    const { container } = ui();
    act(() => feedList(ENDPOINTS, "ep-1"));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-change-default]")!);
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-default-picker-item=ep-2]")!);
    // 他族命令拒绝 → 不归本卡（不误显示）
    feedConnError("追踪查询失败（命令 trace.query）");
    expect(container.querySelector("[data-emb-default-error]")).toBeNull();
    // 本命令拒绝（未 verify）→ 行内交代 + 面板保持打开（用户可改选已验端点）
    feedConnError("端点未通过连通测试，不能设为默认（命令 embedding.set_default）");
    expect(container.querySelector("[data-emb-default-error]")!.textContent).toContain("未通过连通测试");
    expect(container.querySelector("[data-emb-default-picker]")).not.toBeNull();
  });

  it("修改口空态：无向量端点 → 面板内空态提示", () => {
    const { container } = ui();
    act(() => feedList([], null));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-emb-change-default]")!);
    expect(container.querySelector("[data-emb-default-picker-empty]")).not.toBeNull();
  });
});
