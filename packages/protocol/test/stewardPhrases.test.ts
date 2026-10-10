/**
 * stewardPhrases 单测（批 3b：跨端词表单源化）。
 *
 * 词表是「插话不排队」语义下停止的唯一入口（裁决 #2：词表外自然表达当环境
 * 音丢弃）——覆盖面与误触发边界都在这里锚定；daemon 路由面与 shell barge-in
 * 快通道双端同源，本测试即双端共享契约。
 */
import { describe, expect, it } from "vitest";
import {
  matchStewardStopPhrase,
  normalizeStewardPhrase,
  STEWARD_STOP_PHRASES,
  matchStewardConfirmPhrase,
  matchStewardCancelPhrase,
  matchStewardCancelAllPhrase,
  STEWARD_CONFIRM_PHRASES,
  STEWARD_CANCEL_PHRASES,
  STEWARD_CANCEL_ALL_PHRASES,
} from "../src/index";

describe("stewardPhrases（停止词表单源——批 3b 双端契约）", () => {
  it("14 词全停词表（用户裁决扩充：原 7 词 + 停一下/先别说了/不要说了/不用说了/别念了/别说话了/够了）", () => {
    expect(STEWARD_STOP_PHRASES).toEqual([
      "停", "停下", "停止", "停一下", "stop",
      "别说了", "先别说了", "不要说了", "不用说了", "别念了", "别说话了",
      "闭嘴", "住嘴", "够了",
    ]);
  });

  it("全部词命中（双端每词可用——漏收即双端同漏）", () => {
    for (const p of STEWARD_STOP_PHRASES) {
      expect(matchStewardStopPhrase(p)).toBe(true);
    }
  });

  it("尾句读容忍：句尾标点剥除后命中（语音转写常带句读；含空白）", () => {
    expect(matchStewardStopPhrase("停。")).toBe(true);
    expect(matchStewardStopPhrase("别说了！")).toBe(true);
    expect(matchStewardStopPhrase("  不用说了， ")).toBe(true);
    expect(matchStewardStopPhrase("够了？")).toBe(true);
  });

  it("夹带句不命中：全等主闸——聊天句夹「停」零触发（误停代价高于漏停）", () => {
    expect(matchStewardStopPhrase("先停一下")).toBe(false);
    expect(matchStewardStopPhrase("停下来")).toBe(false); // 变体不收录（宁缺勿滥）
    expect(matchStewardStopPhrase("暂停")).toBe(false);
    expect(matchStewardStopPhrase("你说到哪了")).toBe(false);
    expect(matchStewardStopPhrase("好的好了好了")).toBe(false);
    expect(matchStewardStopPhrase("等一下")).toBe(false); // 歧义词不收（用户裁决）
    expect(matchStewardStopPhrase("等等")).toBe(false);
    expect(matchStewardStopPhrase("")).toBe(false);
    expect(matchStewardStopPhrase("  ")).toBe(false);
  });

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
