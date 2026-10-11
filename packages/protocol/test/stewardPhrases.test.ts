/**
 * stewardPhrases 单测（跨端词族单源化）。
 *
 * 停止词族已随「Jev 停止意图判官单轨判定」整体退役（停止判定单源全走判官，
 * 本文件不再有停止词契约）；保留面 = 确认/取消词族（卡栈口令用，与打断链
 * 正交）+ 停止词族退役后仍被词族匹配共用的归一函数。
 */
import { describe, expect, it } from "vitest";
import {
  normalizeStewardPhrase,
  matchStewardConfirmPhrase,
  matchStewardCancelPhrase,
  matchStewardCancelAllPhrase,
  STEWARD_CONFIRM_PHRASES,
  STEWARD_CANCEL_PHRASES,
  STEWARD_CANCEL_ALL_PHRASES,
} from "../src/index";

describe("stewardPhrases（归一函数——词族匹配共用）", () => {
  it("normalizeStewardPhrase：trim + 尾部标点剥除，中部不改", () => {
    expect(normalizeStewardPhrase(" 停。！？ ")).toBe("停");
    expect(normalizeStewardPhrase("别说了，")).toBe("别说了");
    expect(normalizeStewardPhrase("停,一下")).toBe("停,一下"); // 中部标点不动
  });
});

describe("stewardPhrases（确认/取消词族单源——闸门对应修复批双端契约）", () => {
  it("确认 8 词 / 取消 3 词 / 全取消 3 词（daemon 漏斗与 shell 口令面同源）", () => {
    expect(STEWARD_CONFIRM_PHRASES).toEqual([
      "确认", "确认执行", "执行", "执行吧", "做吧", "好的", "行", "可以",
    ]);
    expect(STEWARD_CANCEL_PHRASES).toEqual(["取消", "不要了", "放弃"]);
    expect(STEWARD_CANCEL_ALL_PHRASES).toEqual(["全部取消", "都不要了", "全都不要了"]);
  });

  it("每词全等命中（双端每词可用——漏收即双端同漏）+ 尾句读容忍", () => {
    for (const p of [...STEWARD_CONFIRM_PHRASES, ...STEWARD_CANCEL_PHRASES, ...STEWARD_CANCEL_ALL_PHRASES]) {
      expect(matchStewardConfirmPhrase(p) || matchStewardCancelPhrase(p) || matchStewardCancelAllPhrase(p)).toBe(true);
    }
    expect(matchStewardConfirmPhrase("好的。")).toBe(true);
    expect(matchStewardCancelPhrase(" 放弃！")).toBe(true);
  });

  it("夹带句不命中：全等主闸（「帮我确认一下」零触发）", () => {
    expect(matchStewardConfirmPhrase("帮我确认一下")).toBe(false);
    expect(matchStewardConfirmPhrase("我觉得可以")).toBe(false);
    expect(matchStewardConfirmPhrase("好的好了好了")).toBe(false);
    expect(matchStewardCancelPhrase("那就不取消了吧")).toBe(false);
    expect(matchStewardCancelAllPhrase("全都不要了吧那就")).toBe(false);
    expect(matchStewardConfirmPhrase("")).toBe(false);
  });

  it("确认/取消/全取消三族互不互备（族间零交叉）", () => {
    for (const p of STEWARD_CANCEL_PHRASES) expect(matchStewardConfirmPhrase(p)).toBe(false);
    for (const p of STEWARD_CONFIRM_PHRASES) expect(matchStewardCancelPhrase(p)).toBe(false);
    for (const p of [...STEWARD_CONFIRM_PHRASES, ...STEWARD_CANCEL_PHRASES]) {
      expect(matchStewardCancelAllPhrase(p)).toBe(false);
    }
  });
});
