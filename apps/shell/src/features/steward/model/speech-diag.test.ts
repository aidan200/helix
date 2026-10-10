/**
 * speech-diag 测试（发哑自检沉淀件）：
 * 1. 环形缓冲容量/顺序/快照；
 * 2. 持久化节流落盘 + 读盘恢复（重启不丢证据）；
 * 3. 存储不可用内存态降级（诊断不丢事件）；
 * 4. 清空即落盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIAG_PERSIST_DEBOUNCE_MS,
  DIAG_RING_CAPACITY,
  DIAG_STORAGE_KEY,
  clearSpeechDiag,
  dumpSpeechDiag,
  flushPersist,
  frameEv,
  hydrateDiagFromStorage,
  recordSpeechDiag,
  serializeDiag,
  setDiagStorage,
  type DiagStorage,
} from "./speech-diag";

function fakeStorage(): DiagStorage & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  const s = {
    data,
    writes: 0,
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      s.writes += 1;
      data.set(key, value);
    },
  };
  return s;
}

describe("speech-diag（语音链诊断环形缓冲）", () => {
  let storage: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    vi.useFakeTimers();
    storage = fakeStorage();
    setDiagStorage(storage);
    clearSpeechDiag();
    storage.writes = 0; // 清场自身的落盘不计入各用例断言
  });
  afterEach(() => {
    clearSpeechDiag();
    setDiagStorage(null);
    vi.useRealTimers();
  });

  it("环形缓冲：顺序保持 + 超容量挤掉最旧", () => {
    for (let i = 0; i < DIAG_RING_CAPACITY + 10; i += 1) recordSpeechDiag("ev", String(i));
    const dump = dumpSpeechDiag();
    expect(dump.length).toBe(DIAG_RING_CAPACITY);
    expect(dump[0]!.detail).toBe("10"); // 最旧 10 条被挤掉
    expect(dump[dump.length - 1]!.detail).toBe(String(DIAG_RING_CAPACITY + 9));
  });

  it("持久化节流：N 次记录合并一次落盘；flush 立即落", () => {
    recordSpeechDiag("a");
    recordSpeechDiag("b", "x");
    expect(storage.writes).toBe(0); // 节流窗内不写
    vi.advanceTimersByTime(DIAG_PERSIST_DEBOUNCE_MS);
    expect(storage.writes).toBe(1);
    expect(storage.data.get(DIAG_STORAGE_KEY)).toBe(serializeDiag());
    recordSpeechDiag("c");
    flushPersist();
    expect(storage.writes).toBe(2);
  });

  it("读盘恢复：重启后上次发哑现场回环（跨进程证据保留）", () => {
    recordSpeechDiag("issue.fail", "utt-3");
    flushPersist();
    clearSpeechDiag();
    expect(dumpSpeechDiag().length).toBe(0); // 清场（已落盘空——这里模拟换进程：先回填旧快照）
    storage.data.set(DIAG_STORAGE_KEY, JSON.stringify([{ t: 1, ev: "chunk.timeout", detail: "utt-3" }]));
    expect(hydrateDiagFromStorage()).toBe(1);
    expect(dumpSpeechDiag()).toEqual([{ t: 1, ev: "chunk.timeout", detail: "utt-3" }]);
  });

  it("存储不可用/坏快照：内存态降级不丢事件不抛错", () => {
    setDiagStorage({
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(hydrateDiagFromStorage()).toBe(0);
    recordSpeechDiag("still-works"); // 落盘抛错不影响内存环
    expect(dumpSpeechDiag().map((e) => e.ev)).toContain("still-works");
    vi.advanceTimersByTime(DIAG_PERSIST_DEBOUNCE_MS); // 不抛
  });

  it("frameEv 速记：in/drop 前缀归一", () => {
    frameEv("in", { type: "steward.ask.delta" }, "len=12");
    frameEv("drop", { type: "steward.ask.delta" }, "!answerActive");
    const evs = dumpSpeechDiag().map((e) => e.ev);
    expect(evs).toEqual(["frame.steward.ask.delta", "gate.drop.steward.ask.delta"]);
  });
});
