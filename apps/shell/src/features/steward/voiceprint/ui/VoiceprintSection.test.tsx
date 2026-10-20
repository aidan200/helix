// @vitest-environment jsdom
/**
 * VoiceprintSection 测试（v3：阈值参数 + 5 槽位编辑批）——设置页声纹组。
 *
 * 契约面：
 * - 阈值滑杆（参数设置行形态）：改动 → chip 回显 + localStorage 偏好落值；
 * - 5 槽横排：录一句/重录/删除（未注册暂存；句长不达标当场拒绝不落槽）；
 * - 完成注册（>=3 句）：模型准备（进度）→ 落模板 → 状态 chip + 测试行；
 * - 已注册槽位编辑：单槽重录/删除即时重合成落盘；
 * - 测试行（试听行形态）：得分 + 通过/未通过判定（vs 当前阈值）；
 * - 旧模板（无逐句明细）：legacy 提示 + 单槽编辑不可用；
 * - 模型行：就绪 chip / 手动导入兜底（导入成功自动续跑注册）。
 *
 * 注入面：service（真服务 + 假引擎）与 recorder（假录音器——jsdom 无音频）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/shared/i18n";
import { VOICEPRINT_STORE_KEY, createLocalVoiceprintStore, createMemoryVoiceprintStore } from "../model/voiceprint-store";
import { createVoiceprintService, type EmbedEngine } from "../model/voiceprint-service";
import VoiceprintSection from "./VoiceprintSection";

/** 够长的假语句 PCM（1.5s Int16 域）。 */
function fakeUtterance(): Float32Array {
  const n = 16000 * 1.5;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(2000 * Math.sin((2 * Math.PI * 180 * i) / 16000));
  return out;
}

function makeFakeService(store = createMemoryVoiceprintStore()) {
  let next: number[] = [1, 0.1, 0.05, 0.01];
  const engine: EmbedEngine = {
    embed: async () => new Float32Array(next),
  };
  return {
    service: createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store }),
    store,
    setVector: (v: number[]) => {
      next = v;
    },
  };
}

function makeRecorder(utterance: () => Float32Array = fakeUtterance) {
  const calls: Array<{ min: number; max: number }> = [];
  return {
    calls,
    record: async (min: number, max: number) => {
      calls.push({ min, max });
      return utterance();
    },
  };
}

type FakeRecorder = { record(min: number, max: number): Promise<Float32Array | null> };

function renderSection(opts?: {
  service?: ReturnType<typeof makeFakeService>["service"];
  recorder?: FakeRecorder;
  prepareModel?: (onProgress: (received: number, total: number | null) => void) => Promise<void>;
  importModel?: (file: File) => Promise<void>;
  probeModel?: () => Promise<boolean>;
}) {
  return render(
    <I18nProvider>
      <VoiceprintSection
        {...(opts?.service !== undefined ? { service: opts.service } : {})}
        recorder={opts?.recorder ?? makeRecorder()}
        {...(opts?.prepareModel !== undefined ? { prepareModel: opts.prepareModel } : {})}
        {...(opts?.importModel !== undefined ? { importModel: opts.importModel } : {})}
        {...(opts?.probeModel !== undefined ? { probeModel: opts.probeModel } : { probeModel: probeFalse })}
      />
    </I18nProvider>,
  );
}

const noopPrepare = async () => undefined;
const probeFalse = async () => false;

/** 语义属性查询（data-vp-xxx——组件测试惯例：语义 data 属性直查）。 */
function byVp(name: string): HTMLElement {
  const el = document.querySelector(`[data-vp-${name}]`);
  if (el === null) throw new Error(`data-vp-${name} not found`);
  return el as HTMLElement;
}
function byVpOpt(name: string): HTMLElement | null {
  return document.querySelector(`[data-vp-${name}]`) as HTMLElement | null;
}
function slotOf(i: number): HTMLElement {
  const el = document.querySelector(`[data-vp-slot="${i}"]`);
  if (el === null) throw new Error(`slot ${i} not found`);
  return el as HTMLElement;
}
function slotBtnOpt(action: string, i: number): HTMLElement | null {
  return document.querySelector(`[data-vp-slot-${action}="${i}"]`) as HTMLElement | null;
}
function slotBtn(action: string, i: number): HTMLElement {
  const el = slotBtnOpt(action, i);
  if (el === null) throw new Error(`slot ${i} action ${action} not found`);
  return el;
}

/** 逐槽录满 n 句（每槽点「录一句」——录句异步收尾用 waitFor 轮询落地）。 */
async function recordSlots(n: number) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      fireEvent.click(slotBtn("record", i));
    });
    await waitFor(() => expect(slotOf(i).getAttribute("data-vp-slot-state")).toBe("filled"));
  }
}

/** 录满 3 句并完成注册（常用收口路径）。 */
async function registerThree(fake: ReturnType<typeof makeFakeService>) {
  await recordSlots(3);
  await act(async () => {
    fireEvent.click(byVp("finish"));
  });
  await waitFor(() => expect(byVp("status").textContent).toContain("已注册"));
  return fake;
}

describe("VoiceprintSection（v3 阈值参数 + 5 槽位编辑）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("未注册态：隐私说明 + 5 槽横排（首槽待录）+ 阈值滑杆默认 55%", () => {
    const { service } = makeFakeService();
    renderSection({ service });
    expect(screen.getByText(/只存在这台电脑上，不会上传/)).toBeTruthy();
    expect(byVp("slots")).toBeTruthy();
    expect(document.querySelectorAll("[data-vp-slot]")).toHaveLength(5);
    expect(slotOf(0).getAttribute("data-vp-slot-state")).toBe("next");
    expect(slotOf(1).getAttribute("data-vp-slot-state")).toBe("empty");
    expect((byVp("threshold") as HTMLInputElement).value).toBe("55");
    expect(byVp("threshold-value").textContent).toContain("55%");
  });

  it("阈值滑杆：改值 → chip 回显 + localStorage 偏好落值（授权点热读面）", async () => {
    const { service } = makeFakeService();
    renderSection({ service });
    const slider = byVp("threshold") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: "70" } });
    });
    expect(byVp("threshold-value").textContent).toContain("70%");
    expect(localStorage.getItem("helix.voice.vpThreshold")).toBe("70");
  });

  it("录句推进：3 句后完成注册出现、计数回显；2 句时无完成注册", async () => {
    const { service } = makeFakeService();
    renderSection({ service, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(slotBtn("record", 0));
    });
    await waitFor(() => expect(byVp("count").textContent).toContain("1 / 5"));
    expect(byVpOpt("finish")).toBeNull();
    await act(async () => {
      fireEvent.click(slotBtn("record", 1));
    });
    await waitFor(() => expect(slotOf(1).getAttribute("data-vp-slot-state")).toBe("filled"));
    await act(async () => {
      fireEvent.click(slotBtn("record", 2));
    });
    await waitFor(() => expect(byVp("count").textContent).toContain("3 / 5"));
    expect(byVp("finish")).toBeTruthy();
  });

  it("完成注册：模型准备（进度回调）→ 落模板 → 状态 chip + 测试行出现", async () => {
    const fake = makeFakeService();
    const prepareModel = vi.fn(async (onProgress: (received: number, total: number | null) => void) => {
      onProgress(1e6, 27e6);
    });
    renderSection({ service: fake.service, prepareModel, probeModel: async () => true });
    await registerThree(fake);
    expect(prepareModel).toHaveBeenCalled();
    expect(byVp("status").textContent).toContain("已注册 · 3 句");
    expect(fake.store.read()!.vectors).toHaveLength(3);
    expect(byVp("test")).toBeTruthy();
    expect(byVp("delete")).toBeTruthy();
  });

  it("未注册槽编辑：录 4 句删 1 → 计数 3；重录不增句数", async () => {
    const { service } = makeFakeService();
    renderSection({ service, prepareModel: noopPrepare });
    await recordSlots(4);
    await waitFor(() => expect(byVp("count").textContent).toContain("4 / 5"));
    await act(async () => {
      fireEvent.click(slotBtn("delete", 0));
    });
    await waitFor(() => expect(byVp("count").textContent).toContain("3 / 5"));
    await act(async () => {
      fireEvent.click(slotBtn("rerecord", 1));
    });
    await waitFor(() => expect(slotOf(1).getAttribute("data-vp-slot-state")).toBe("filled"));
    expect(byVp("count").textContent).toContain("3 / 5");
  });

  it("已注册槽位编辑：重录槽 1 向量换新；补录后删除槽句数 -1（即时重合成落盘）", async () => {
    const fake = makeFakeService();
    renderSection({ service: fake.service, prepareModel: noopPrepare, probeModel: async () => true });
    await registerThree(fake);
    fake.setVector([0, 1, 0, 0]); // 重录句向量换向（4 维与模板对齐）
    await act(async () => {
      fireEvent.click(slotBtn("rerecord", 1));
    });
    await waitFor(() => expect(Array.from(fake.store.read()!.vectors[1]!)).toEqual([0, 1, 0, 0]));
    fake.setVector([1, 0.1, 0.05, 0.01]);
    await act(async () => {
      fireEvent.click(slotBtn("record", 3)); // 补录第 4 句
    });
    await waitFor(() => expect(fake.store.read()!.utterances).toBe(4));
    await act(async () => {
      fireEvent.click(slotBtn("delete", 2));
    });
    await waitFor(() => expect(fake.store.read()!.utterances).toBe(3));
    expect(byVp("status").textContent).toContain("已注册 · 3 句");
  });

  it("测试行：高分通过 chip / 低分未通过（判定 vs 当前阈值）", async () => {
    const fake = makeFakeService();
    renderSection({ service: fake.service, prepareModel: noopPrepare, probeModel: async () => true });
    await registerThree(fake);
    await act(async () => {
      fireEvent.click(byVp("test"));
    });
    await waitFor(() => expect(byVp("test-score").textContent).toContain("通过"));
    expect(byVp("test-score").textContent).toContain("相似度");
    fake.setVector([-1, 0]); // 与模板反向 → 低分
    await act(async () => {
      fireEvent.click(byVp("test"));
    });
    await waitFor(() => expect(byVp("test-score").textContent).toContain("未通过"));
  });

  it("删除声纹：回未注册形态 + 模板彻底移除", async () => {
    const fake = makeFakeService();
    renderSection({ service: fake.service, prepareModel: noopPrepare, probeModel: async () => true });
    await registerThree(fake);
    await act(async () => {
      fireEvent.click(byVp("delete"));
    });
    await waitFor(() => expect(slotBtnOpt("record", 0)).toBeTruthy());
    expect(fake.store.read()).toBeNull();
  });

  it("旧模板（无逐句明细）：legacy 提示 + 单槽编辑不可用 + 校验态保留", () => {
    const store = createLocalVoiceprintStore(localStorage);
    // 旧版数据形态：无 vectors 字段
    localStorage.setItem(
      VOICEPRINT_STORE_KEY,
      JSON.stringify({ dim: 2, vector: [1, 0], utterances: 3, createdAt: 1 }),
    );
    const { service } = makeFakeService(store);
    renderSection({ service });
    expect(byVp("hint").textContent).toContain("旧版样本");
    expect(byVp("status").textContent).toContain("已注册 · 3 句");
    expect(slotBtnOpt("rerecord", 0)).toBeNull();
    expect(slotBtnOpt("delete", 0)).toBeNull();
    expect(byVp("test")).toBeTruthy();
    expect(byVp("delete")).toBeTruthy();
  });

  it("句太短（<1.2s）→ 当场白话错误、不落槽", async () => {
    const { service } = makeFakeService();
    const recorder = makeRecorder(() => new Float32Array(16000 * 0.5));
    renderSection({ service, recorder, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(slotBtn("record", 0));
    });
    await waitFor(() => expect(byVp("error").textContent).toContain("太短"));
    expect(byVp("count").textContent).toContain("0 / 5");
    expect(slotOf(0).getAttribute("data-vp-slot-state")).toBe("next");
  });

  it("模型下载失败 → 白话错误 + 导入通道保留（可手动导入续跑）", async () => {
    const fake = makeFakeService();
    const prepareModel = vi.fn().mockRejectedValue(new Error("download fail"));
    renderSection({ service: fake.service, prepareModel, probeModel: async () => false });
    await recordSlots(3);
    await act(async () => {
      fireEvent.click(byVp("finish"));
    });
    await waitFor(() => expect(byVp("error").textContent).toContain("拉取失败"));
    expect(byVp("import")).toBeTruthy();
    expect(fake.service.isRegistered()).toBe(false);
  });

  it("手动导入成功：就绪 chip + 自动续跑注册（暂存 >=3 句）", async () => {
    const fake = makeFakeService();
    const importModel = vi.fn().mockResolvedValue(undefined);
    renderSection({ service: fake.service, importModel, prepareModel: noopPrepare, probeModel: async () => false });
    await recordSlots(3);
    const fileInput = byVp("file") as HTMLInputElement;
    const file = new File([new Uint8Array(8).fill(1)], "voiceprint-model.onnx");
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file] });
      fireEvent.change(fileInput);
    });
    await waitFor(() => {
      expect(importModel).toHaveBeenCalledWith(file);
      expect(byVp("model-ready")).toBeTruthy();
    });
    await waitFor(() => expect(fake.store.read()).not.toBeNull()); // 自动续跑注册成功
  });

  it("就绪探测命中：声音模型就绪 chip + 导入姿态收起", async () => {
    const { service } = makeFakeService();
    renderSection({ service, probeModel: async () => true });
    await waitFor(() => {
      expect(byVp("model-ready").textContent).toContain("已就绪");
      expect(byVpOpt("import")).toBeNull();
      expect(byVpOpt("file")).toBeNull();
    });
  });

  it("麦克风失败 → 白话错误（麦克风不可用）", async () => {
    const { service } = makeFakeService();
    const recorder = { record: async () => null };
    renderSection({ service, recorder, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(slotBtn("record", 0));
    });
    await waitFor(() => expect(byVp("error").textContent).toContain("麦克风不可用"));
  });
});

describe("VoiceprintSection 卸载与注入面卫生（code-review 低危）", () => {
  it("卸载 → 中止在途录音（recorder.abort 恰一次，不等 10s 兜底超时）", async () => {
    const { service } = makeFakeService();
    let resolveRecord: ((v: Float32Array | null) => void) | null = null;
    const abort = vi.fn(() => resolveRecord?.(null));
    const recorder = {
      record: () =>
        new Promise<Float32Array | null>((resolve) => {
          resolveRecord = resolve;
        }),
      abort,
    };
    const view = renderSection({ service, recorder, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(slotBtn("record", 0));
    });
    expect(abort).not.toHaveBeenCalled(); // 录制中：未中止
    act(() => {
      view.unmount();
    });
    expect(abort).toHaveBeenCalledTimes(1); // 离开设置页即关麦
  });

  it("重渲染不重建录音器实例（旧写法每渲染调一次 createMicUtteranceRecorder）", async () => {
    const { service } = makeFakeService();
    const record = vi.fn(async () => fakeUtterance());
    const recorder = { record };
    const view = renderSection({ service, recorder, prepareModel: noopPrepare });
    // 触发若干次重渲染（阈值滑杆输入）
    const slider = document.querySelector("[data-vp-threshold]") as HTMLInputElement | null;
    if (slider !== null) {
      act(() => {
        fireEvent.change(slider, { target: { value: "0.8" } });
      });
    }
    act(() => {
      view.rerender(
        <I18nProvider>
          <VoiceprintSection service={service} recorder={recorder} prepareModel={noopPrepare} probeModel={async () => false} />
        </I18nProvider>,
      );
    });
    // 注入面恒为同一实例：录一句仍走注入 recorder（未被渲染期新建实例替换）
    await act(async () => {
      fireEvent.click(slotBtn("record", 0));
    });
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  });
});
