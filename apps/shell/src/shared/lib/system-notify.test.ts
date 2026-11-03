// @vitest-environment jsdom
/**
 * 系统通知分流桥决策面测试（P0）：设置短路 / 前台门控 / 会话前台门控 /
 * 60s 同内容去重窗 / urgency 分流（high 直发 = 不参与去重窗）。
 *
 * 纯函数面：不触原生、不触 React——判定逻辑单点在此，组件层只做接线。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideSystemNotify,
  isWindowForeground,
  readSystemNotifyPref,
  SystemNotifyDedup,
  SYSTEM_NOTIFY_DEDUP_WINDOW_MS,
  SYSTEM_NOTIFY_PREF_KEY,
  writeSystemNotifyPref,
} from "@/shared/lib/system-notify";

const base = { title: "任务完成", body: "整理完了", urgency: "normal" as const };
const ctx = { enabled: true, foreground: false, seenAt: undefined as number | undefined, now: 1_000_000 };

describe("系统通知判定（decideSystemNotify）", () => {
  it("窗口前台 → 不发（toast 已覆盖，前台零打扰）", () => {
    expect(decideSystemNotify(base, { ...ctx, foreground: true })).toEqual({
      send: false,
      reason: "foreground",
    });
  });

  it("窗口后台 + 开关开 → 发", () => {
    expect(decideSystemNotify(base, ctx)).toEqual({ send: true });
  });

  it("设置关 → 整体短路（high 也拦）", () => {
    expect(decideSystemNotify(base, { ...ctx, enabled: false })).toEqual({
      send: false,
      reason: "disabled",
    });
    expect(
      decideSystemNotify({ ...base, urgency: "high" }, { ...ctx, enabled: false }),
    ).toEqual({ send: false, reason: "disabled" });
  });

  it("normal 档 60s 同内容去重窗内重复 → 丢弃；窗外 → 发", () => {
    const seen = ctx.now - 10_000;
    expect(decideSystemNotify(base, { ...ctx, seenAt: seen })).toEqual({
      send: false,
      reason: "duplicate",
    });
    expect(
      decideSystemNotify(base, { ...ctx, seenAt: ctx.now - SYSTEM_NOTIFY_DEDUP_WINDOW_MS }),
    ).toEqual({ send: true });
  });

  it("urgency 分流：high 直发（同内容在去重窗内也发——失败类通知不因同文案被压）", () => {
    const seen = ctx.now - 1_000;
    expect(decideSystemNotify({ ...base, urgency: "high" }, { ...ctx, seenAt: seen })).toEqual({
      send: true,
    });
  });

  it("空 title/body 守卫（不进系统通知——避免空气泡）", () => {
    expect(decideSystemNotify({ ...base, title: " " }, ctx)).toEqual({ send: false, reason: "empty" });
    expect(decideSystemNotify({ ...base, body: "" }, ctx)).toEqual({ send: false, reason: "empty" });
  });
});

describe("同内容去重窗记账（SystemNotifyDedup）", () => {
  it("首达记账不命中；窗内重复命中；窗外再达不命中", () => {
    const dedup = new SystemNotifyDedup();
    expect(dedup.seenAt("a", 0)).toBeUndefined();
    expect(dedup.seenAt("a", 1_000)).toBe(0);
    expect(dedup.seenAt("a", SYSTEM_NOTIFY_DEDUP_WINDOW_MS + 1)).toBeUndefined();
  });

  it("容量挤出取最久未用（LRU 序：命中即刷新到尾部）", () => {
    const dedup = new SystemNotifyDedup(SYSTEM_NOTIFY_DEDUP_WINDOW_MS, 2);
    dedup.seenAt("a", 0);
    dedup.seenAt("b", 1);
    dedup.seenAt("a", 2); // a 刷新为最近使用
    dedup.seenAt("c", 3); // 挤出 b
    expect(dedup.seenAt("a", 4)).toBe(0); // 命中返回首达时刻（窗不滑动）
    expect(dedup.seenAt("b", 5)).toBeUndefined();
  });
});

describe("系统通知偏好（本地开关，默认开）", () => {
  beforeEach(() => localStorage.clear());

  it("缺键 → 默认开", () => {
    expect(readSystemNotifyPref()).toBe(true);
  });

  it("写关 → 读关；写开 → 读开", () => {
    writeSystemNotifyPref(false);
    expect(localStorage.getItem(SYSTEM_NOTIFY_PREF_KEY)).toBe("0");
    expect(readSystemNotifyPref()).toBe(false);
    writeSystemNotifyPref(true);
    expect(readSystemNotifyPref()).toBe(true);
  });
});

describe("语音覆盖闸（voiceCovered——steward.notify 面，§17.41：管家语音会播时弹窗冗余）", () => {
  it("voiceCovered=true → 不发（reason=voice-covered；听觉已触达）", () => {
    expect(
      decideSystemNotify(
        { title: "任务完成", body: "任务完成了", urgency: "normal", voiceCovered: true },
        { enabled: true, foreground: false, seenAt: undefined, now: 1000 },
      ),
    ).toEqual({ send: false, reason: "voice-covered" });
  });

  it("voiceCovered=true 且 high → 同样不发（failed 恒有语音，弹窗冗余）", () => {
    expect(
      decideSystemNotify(
        { title: "任务失败", body: "任务失败了", urgency: "high", voiceCovered: true },
        { enabled: true, foreground: false, seenAt: undefined, now: 1000 },
      ),
    ).toEqual({ send: false, reason: "voice-covered" });
  });

  it("voiceCovered=false / 缺省 → 不影响判定（旧 daemon 不携带字段按不覆盖处理）", () => {
    expect(
      decideSystemNotify(
        { title: "任务完成", body: "任务完成了", urgency: "normal", voiceCovered: false },
        { enabled: true, foreground: false, seenAt: undefined, now: 1000 },
      ),
    ).toEqual({ send: true });
    expect(
      decideSystemNotify(
        { title: "任务完成", body: "任务完成了", urgency: "normal" },
        { enabled: true, foreground: false, seenAt: undefined, now: 1000 },
      ),
    ).toEqual({ send: true });
  });

  it("前台闸优先于语音覆盖闸（前台本就不发，reason=foreground）", () => {
    expect(
      decideSystemNotify(
        { title: "任务完成", body: "任务完成了", urgency: "normal", voiceCovered: true },
        { enabled: true, foreground: true, seenAt: undefined, now: 1000 },
      ),
    ).toEqual({ send: false, reason: "foreground" });
  });
});

describe("isWindowForeground：WKWebView hasFocus 怪癖护栏（首验缺口回归锚）", () => {
  it("hasFocus 恒 true 时，window blur 事件仍把窗口判为后台（事件态短路查询态）", () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true); // 模拟怪癖：app 失焦仍 true
    window.dispatchEvent(new Event("blur"));
    expect(isWindowForeground()).toBe(false);
    window.dispatchEvent(new Event("focus"));
    expect(isWindowForeground()).toBe(true);
    hasFocusSpy.mockRestore();
  });
});
