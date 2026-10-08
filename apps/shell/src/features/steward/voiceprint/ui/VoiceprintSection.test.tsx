// @vitest-environment jsdom
/**
 * VoiceprintSection 测试（M3-c 声纹批）——设置页注册引导（E-263 管家组
 * 第五件：3-5 句采集 / 测试按钮实时得分 / 删除彻底移除）。
 *
 * 注入面：service（真服务 + 假引擎）与 recorder（假录音器——jsdom 无音频）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/shared/i18n";
import { createVoiceprintService, type EmbedEngine } from "../model/voiceprint-service";
import { createMemoryVoiceprintStore } from "../model/voiceprint-store";
import { createLocalVoiceprintStore } from "../model/voiceprint-store";
import VoiceprintSection from "./VoiceprintSection";

/** 够长的假语句 PCM（1.5s Int16 域）。 */
function fakeUtterance(): Float32Array {
  const n = 16000 * 1.5;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(2000 * Math.sin((2 * Math.PI * 180 * i) / 16000));
  return out;
}

function makeFakeService(store = createMemoryVoiceprintStore()) {
  const engine: EmbedEngine = {
    embed: async (samples: Float32Array) => {
      // 句向量 = 首样本符号注入的确定性向量（不同句可区分；同向量族高相似）
      const v = new Float32Array(4);
      const tag = samples[0] ?? 0;
      v[0] = tag > 0 ? 1 : 1;
      v[1] = 0.1 * (samples.length % 7);
      v[2] = 0.05;
      v[3] = 0.01;
      return v;
    },
  };
  return {
    service: createVoiceprintService({ engineLoader: () => Promise.resolve(engine), store }),
    store,
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

function renderSection(opts?: {
  service?: ReturnType<typeof makeFakeService>["service"];
  recorder?: ReturnType<typeof makeRecorder>;
  prepareModel?: (onProgress: (received: number, total: number | null) => void) => Promise<void>;
  importModel?: (file: File) => Promise<void>;
}) {
  return render(
    <I18nProvider>
      <VoiceprintSection
        {...(opts?.service !== undefined ? { service: opts.service } : {})}
        {...(opts?.recorder !== undefined ? { recorder: opts.recorder } : {})}
        {...(opts?.prepareModel !== undefined ? { prepareModel: opts.prepareModel } : {})}
        {...(opts?.importModel !== undefined ? { importModel: opts.importModel } : {})}
      />
    </I18nProvider>,
  );
}

const noopPrepare = async () => undefined;


/** 语义属性查询（data-vp-xxx——组件测试惯例：语义 data 属性直查）。 */
function byVp(name: string): HTMLElement {
  const el = document.querySelector(`[data-vp-${name}]`);
  if (el === null) throw new Error(`data-vp-${name} not found`);
  return el as HTMLElement;
}
function byVpOpt(name: string): HTMLElement | null {
  return document.querySelector(`[data-vp-${name}]`) as HTMLElement | null;
}

describe("VoiceprintSection（M3-c 注册引导）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("未注册态：说明文案（本地/不上传）+ 注册入口", () => {
    const { service } = makeFakeService();
    renderSection({ service });
    expect(screen.getByText(/只存在这台电脑上，不会上传/)).toBeTruthy();
    expect(byVp("register")).toBeTruthy();
  });

  it("注册流程：说一句 ×3 → 完成注册出现 → 点击落模板（saved 态）", async () => {
    const { service, store } = makeFakeService();
    const recorder = makeRecorder();
    renderSection({ service, recorder, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(byVp("register"));
    });
    // 三句采集（进度显示已录句数）
    for (let i = 1; i <= 3; i++) {
      const btn = byVp("say");
      expect(btn.textContent).toContain(`第 ${i} 句`);
      await act(async () => {
        fireEvent.click(btn);
      });
      await waitFor(() => expect(byVp("count").textContent).toBe(`已录 ${i} 句`));
    }
    // ≥3 句 → 完成注册出现
    const finish = byVp("finish");
    await act(async () => {
      fireEvent.click(finish);
    });
    await waitFor(() => expect(byVp("status").textContent).toContain("已注册"));
    expect(store.read()).not.toBeNull();
    expect(store.read()!.utterances).toBe(3);
  });

  it("不足 3 句：完成注册不出现（2 句后仍无按钮）", async () => {
    const { service } = makeFakeService();
    const recorder = makeRecorder();
    renderSection({ service, recorder, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(byVp("register"));
    });
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        fireEvent.click(byVp("say"));
      });
      await waitFor(() => expect(byVp("count").textContent).toBe(`已录 ${i + 1} 句`));
    }
    expect(byVpOpt("finish")).toBeNull();
  });

  it("已注册态：测试按钮 → 实时相似度得分展示（百分比）", async () => {
    const { service } = makeFakeService();
    const recorder = makeRecorder();
    renderSection({ service, recorder, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(byVp("register"));
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(byVp("say"));
      });
      await waitFor(() => expect(byVp("count")).toBeTruthy());
    }
    await act(async () => {
      fireEvent.click(byVp("finish"));
    });
    await waitFor(() => expect(byVp("test")).toBeTruthy());
    await act(async () => {
      fireEvent.click(byVp("test"));
    });
    await waitFor(() => expect(byVp("test-score").textContent).toMatch(/相似度/));
  });

  it("删除：saved → 点删除 → 回未注册态 + 模板彻底移除", async () => {
    const { service, store } = makeFakeService();
    const recorder = makeRecorder();
    renderSection({ service, recorder, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(byVp("register"));
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(byVp("say"));
      });
      await waitFor(() => expect(byVp("count")).toBeTruthy());
    }
    await act(async () => {
      fireEvent.click(byVp("finish"));
    });
    await waitFor(() => expect(byVp("delete")).toBeTruthy());
    await act(async () => {
      fireEvent.click(byVp("delete"));
    });
    await waitFor(() => expect(byVp("register")).toBeTruthy());
    expect(store.read()).toBeNull();
  });

  it("句太短（<1.2s）→ 注册拒绝白话错误展示、不落模板", async () => {
    const { service, store } = makeFakeService();
    const recorder = makeRecorder(() => new Float32Array(16000 * 0.5)); // 0.5s
    renderSection({ service, recorder, prepareModel: noopPrepare });
    await act(async () => {
      fireEvent.click(byVp("register"));
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(byVp("say"));
      });
      await waitFor(() => expect(byVp("count").textContent).toBe(`已录 ${i + 1} 句`));
    }
    await act(async () => {
      fireEvent.click(byVp("finish"));
    });
    await waitFor(() => expect(byVp("error").textContent).toContain("太短"));
    expect(store.read()).toBeNull();
  });

  it("生产 store 注入面：localStorage 模板可读（跨会话已注册态直显）", async () => {
    const store = createLocalVoiceprintStore(localStorage);
    store.write({ dim: 4, vector: new Float32Array([1, 0, 0, 0]), utterances: 3, createdAt: 1 });
    const { service } = makeFakeService(store);
    renderSection({ service });
    expect(byVp("status").textContent).toContain("已注册");
    expect(byVpOpt("register")).toBeNull();
  });

  it("手动导入：选文件 → importModel 上行 → 直接进采句态（daemon 落盘后拉取命中）", async () => {
    const importModelProbe = vi.fn().mockResolvedValue(undefined);
    const { service } = makeFakeService();
    renderSection({ service, importModel: importModelProbe });
    const fileInput = byVp("file") as HTMLInputElement;
    const file = new File([new Uint8Array(8).fill(1)], "voiceprint-model.onnx");
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file] });
      fireEvent.change(fileInput);
    });
    await waitFor(() => {
      expect(importModelProbe).toHaveBeenCalledWith(file);
      expect(byVp("count")).toBeTruthy(); // 采句态（说一句按钮在）
      expect(byVpOpt("import")).toBeNull(); // 未注册态入口退场
    });
  });

  it("手动导入失败：白话错误展示、停留未注册态（可重试）", async () => {
    const importModelFail = vi.fn().mockRejectedValue(new Error("upload fail"));
    const { service } = makeFakeService();
    renderSection({ service, importModel: importModelFail });
    const fileInput = byVp("file") as HTMLInputElement;
    const file = new File([new Uint8Array(8).fill(1)], "voiceprint-model.onnx");
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file] });
      fireEvent.change(fileInput);
    });
    await waitFor(() => {
      expect(byVp("error").textContent).toContain("导入失败");
      expect(byVp("register")).toBeTruthy();
    });
  });
});
