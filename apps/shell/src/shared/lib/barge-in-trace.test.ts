// @vitest-environment jsdom
/**
 * barge-in 误触埋点测试（B3 校准数据面；TDD 红→绿）：
 * 环形缓冲（最近 BARGE_IN_TRACE_CAP 条）+ localStorage 持久化 +
 * 损坏 JSON / 存储不可用静默兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BARGE_IN_TRACE_CAP,
  VOICE_BARGE_IN_TRACE_KEY,
  appendBargeInTrace,
  readBargeInTrace,
  recordBargeInTrace,
  type BargeInTraceEntry,
} from "./barge-in-trace";

const entry = (at: number, over: Partial<BargeInTraceEntry> = {}): BargeInTraceEntry => ({
  at,
  rms: 0.05,
  zcr: 0.08,
  phase: "speaking",
  ...over,
});

describe("appendBargeInTrace（环形缓冲纯函数）", () => {
  it("追加保留序；超上限丢最旧（最近 50 条）", () => {
    let buf: readonly BargeInTraceEntry[] = [];
    for (let i = 0; i < BARGE_IN_TRACE_CAP + 10; i += 1) buf = appendBargeInTrace(buf, entry(i));
    expect(buf.length).toBe(BARGE_IN_TRACE_CAP);
    expect(buf[0]!.at).toBe(10); // 最旧 10 条已丢
    expect(buf[buf.length - 1]!.at).toBe(BARGE_IN_TRACE_CAP + 9); // 最新在尾
  });
});

describe("barge-in 埋点存取（localStorage 环形缓冲）", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("record 后 read 回读（JSON 落盘含帧特征 rms/zcr/phase）", () => {
    recordBargeInTrace(entry(1700000000000, { rms: 0.21, zcr: 0.4, phase: "asking" }));
    const got = readBargeInTrace();
    expect(got).toEqual([entry(1700000000000, { rms: 0.21, zcr: 0.4, phase: "asking" })]);
    expect(localStorage.getItem(VOICE_BARGE_IN_TRACE_KEY)).toContain("\"rms\":0.21");
  });

  it("多次 record 环形收口（容量上限内累积、超限丢最旧）", () => {
    for (let i = 0; i < BARGE_IN_TRACE_CAP + 5; i += 1) recordBargeInTrace(entry(i));
    const got = readBargeInTrace();
    expect(got.length).toBe(BARGE_IN_TRACE_CAP);
    expect(got[got.length - 1]!.at).toBe(BARGE_IN_TRACE_CAP + 4);
  });

  it("缺省/损坏 JSON / 非数组 → 空清单（不抛错）", () => {
    expect(readBargeInTrace()).toEqual([]);
    localStorage.setItem(VOICE_BARGE_IN_TRACE_KEY, "{oops");
    expect(readBargeInTrace()).toEqual([]);
    localStorage.setItem(VOICE_BARGE_IN_TRACE_KEY, "{\"at\":1}");
    expect(readBargeInTrace()).toEqual([]);
  });

  it("localStorage 不可用：读写静默兜底（空清单 / 不抛错）", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(readBargeInTrace()).toEqual([]);
    spy.mockRestore();
    const spySet = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => recordBargeInTrace(entry(1))).not.toThrow();
    spySet.mockRestore();
  });
});

describe("⑦ 双态打点（fired 字段——触发/未触发双态入同一环形缓冲）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("fired 双态随条目落盘回读（true = 触发帧 / false = 未触发候选段收口）", () => {
    recordBargeInTrace(entry(1, { fired: true, rms: 0.05 }));
    recordBargeInTrace(entry(2, { fired: false, rms: 0.022 }));
    const got = readBargeInTrace();
    expect(got.map((e) => e.fired)).toEqual([true, false]);
    expect(got[1]!.rms).toBe(0.022);
  });

  it("旧版条目（无 fired 字段）照常读取（向前兼容——历史均为触发帧）", () => {
    localStorage.setItem(
      VOICE_BARGE_IN_TRACE_KEY,
      JSON.stringify([{ at: 1, rms: 0.05, zcr: 0.08, phase: "speaking" }]),
    );
    expect(readBargeInTrace()).toEqual([entry(1)]);
  });

  it("fired 形状非法（非布尔）条目剔除（损坏防御同族）", () => {
    localStorage.setItem(
      VOICE_BARGE_IN_TRACE_KEY,
      JSON.stringify([{ at: 1, rms: 0.05, zcr: 0.08, phase: "speaking", fired: "yes" }]),
    );
    expect(readBargeInTrace()).toEqual([]);
  });
});
