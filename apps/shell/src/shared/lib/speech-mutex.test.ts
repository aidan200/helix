/**
 * speech-mutex 单测（语音闭环批 ⑥：播报-收音互斥——多源租约 + 边沿通知）。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  beginSpeechLease,
  endSpeechLease,
  onSpeechMutexChange,
  resetSpeechMutexForTest,
  speechLeaseActive,
} from "./speech-mutex";

afterEach(() => {
  resetSpeechMutexForTest();
});

describe("speech-mutex（播报租约）", () => {
  test("首租约进入 → speaking=true 边沿；末租约释放 → false 边沿（非边沿零通知）", () => {
    const changes: boolean[] = [];
    onSpeechMutexChange((s) => changes.push(s));

    beginSpeechLease("voice-broadcast:1");
    expect(speechLeaseActive()).toBe(true);
    expect(changes).toEqual([true]);

    beginSpeechLease("steward-speech"); // 第二源（仍活跃——无新边沿）
    expect(changes).toEqual([true]);

    endSpeechLease("voice-broadcast:1");
    expect(speechLeaseActive()).toBe(true); // 仍有租约
    expect(changes).toEqual([true]);

    endSpeechLease("steward-speech");
    expect(speechLeaseActive()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  test("同源幂等（重复 begin 不叠加租约）+ 未知源 end no-op", () => {
    const changes: boolean[] = [];
    onSpeechMutexChange((s) => changes.push(s));
    beginSpeechLease("a");
    beginSpeechLease("a"); // 幂等
    endSpeechLease("nope"); // 未知源
    expect(speechLeaseActive()).toBe(true);
    expect(changes).toEqual([true]);
    endSpeechLease("a");
    expect(changes).toEqual([true, false]);
  });

  test("退订后零通知；监听器抛错隔离", () => {
    const bad = vi.fn(() => {
      throw new Error("listener boom");
    });
    const good: boolean[] = [];
    const off = onSpeechMutexChange((s) => good.push(s));
    onSpeechMutexChange(bad);
    beginSpeechLease("x"); // bad 抛错不阻断 good
    expect(good).toEqual([true]);
    off();
    endSpeechLease("x");
    expect(good).toEqual([true]); // 已退订零通知
  });
});
