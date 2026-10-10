/**
 * 语音口令解析器测试（B2 全局语音批，D3=b；设计稿 §3.4 语音口令）。
 *
 * 主闸：**整句独立成句**才算数（trim 后全等口令形态）——聊天句中夹带的
 * 「确认」二字不触发（防误触）；不设「全部确认」（写操作授权禁语音批量
 * 放行）；编号指认支持阿拉伯与中文数字；裁决以整句定稿时卡栈快照绑定。
 */
import { describe, expect, it } from "vitest";
import {
  isStopIntentPhrase,
  parseVoiceCommand,
  resolveVoiceCommand,
  type VoiceCardSnapshot,
} from "./voice-command";

function cards(...spec: Array<[seq: number, state?: VoiceCardSnapshot["state"], actionId?: string]>): VoiceCardSnapshot[] {
  return spec.map(([seq, state = "awaiting", actionId = `a${seq}`]) => ({
    actionId,
    agentId: `agent-${seq}`,
    seq,
    state,
  }));
}

describe("parseVoiceCommand（整句成句才触发）", () => {
  it("整句「确认」/「取消」→ 栈顶口令；句尾句读容忍", () => {
    expect(parseVoiceCommand("确认")).toEqual({ kind: "confirm", target: "top" });
    expect(parseVoiceCommand("取消")).toEqual({ kind: "cancel", target: "top" });
    expect(parseVoiceCommand("确认。")).toEqual({ kind: "confirm", target: "top" });
    expect(parseVoiceCommand(" 取消！ ")).toEqual({ kind: "cancel", target: "top" });
  });

  it("编号指认：阿拉伯与中文数字均可（确认2号 / 确认二号 / 取消第3号）", () => {
    expect(parseVoiceCommand("确认2号")).toEqual({ kind: "confirm", target: { seq: 2 } });
    expect(parseVoiceCommand("确认二号")).toEqual({ kind: "confirm", target: { seq: 2 } });
    expect(parseVoiceCommand("取消第3号")).toEqual({ kind: "cancel", target: { seq: 3 } });
    expect(parseVoiceCommand("取消十二号")).toEqual({ kind: "cancel", target: { seq: 12 } });
    expect(parseVoiceCommand("确认二十一号。")).toEqual({ kind: "confirm", target: { seq: 21 } });
  });

  it("全部取消族：全部取消（strict）/ 都不要了（alias）", () => {
    expect(parseVoiceCommand("全部取消")).toEqual({ kind: "cancelAll" });
    expect(parseVoiceCommand("都不要了")).toEqual({ kind: "cancelAll", alias: true });
    expect(parseVoiceCommand("全都不要了。")).toEqual({ kind: "cancelAll", alias: true });
  });

  it("口语应答词（protocol 单源词族——闸门对应修复批）：全等命中 → 带 alias 的 top 口令；无卡透传归消费方", () => {
    expect(parseVoiceCommand("好的")).toEqual({ kind: "confirm", target: "top", alias: true });
    expect(parseVoiceCommand("行")).toEqual({ kind: "confirm", target: "top", alias: true });
    expect(parseVoiceCommand("可以")).toEqual({ kind: "confirm", target: "top", alias: true });
    expect(parseVoiceCommand("做吧")).toEqual({ kind: "confirm", target: "top", alias: true });
    expect(parseVoiceCommand("执行")).toEqual({ kind: "confirm", target: "top", alias: true });
    expect(parseVoiceCommand("执行吧")).toEqual({ kind: "confirm", target: "top", alias: true });
    expect(parseVoiceCommand("确认执行")).toEqual({ kind: "confirm", target: "top", alias: true });
    expect(parseVoiceCommand("好的。")).toEqual({ kind: "confirm", target: "top", alias: true }); // 尾句读容忍
    expect(parseVoiceCommand("不要了")).toEqual({ kind: "cancel", target: "top", alias: true });
    expect(parseVoiceCommand("放弃")).toEqual({ kind: "cancel", target: "top", alias: true });
    // strict 对照：「确认/取消」不带 alias（无卡时明示「没有待确认的卡片」）
    expect(parseVoiceCommand("确认")).toEqual({ kind: "confirm", target: "top" });
    expect(parseVoiceCommand("取消")).toEqual({ kind: "cancel", target: "top" });
  });

  it("聊天句中夹带不触发（主闸）：非整句口令形态一律 null", () => {
    expect(parseVoiceCommand("帮我确认一下")).toBeNull();
    expect(parseVoiceCommand("确认投递到三号会话")).toBeNull();
    expect(parseVoiceCommand("那就不取消了吧")).toBeNull();
    expect(parseVoiceCommand("我觉得可以确认")).toBeNull();
    expect(parseVoiceCommand("明天天气怎么样")).toBeNull();
    expect(parseVoiceCommand("确认")).not.toBeNull(); // 对照组：整句仍是口令
  });

  it("不设「全部确认」：整句也不触发（写操作授权禁语音批量放行）", () => {
    expect(parseVoiceCommand("全部确认")).toBeNull();
    expect(parseVoiceCommand("都确认")).toBeNull();
    expect(parseVoiceCommand("全部确认。")).toBeNull();
  });

  it("空串/纯空白/怪形态零触发", () => {
    expect(parseVoiceCommand("")).toBeNull();
    expect(parseVoiceCommand("   ")).toBeNull();
    expect(parseVoiceCommand("确认号")).toBeNull();
    expect(parseVoiceCommand("确认0号")).toBeNull(); // 编号 1 起
    expect(parseVoiceCommand("确认一百号")).toBeNull(); // 超界（1-99）
  });
});

describe("resolveVoiceCommand（整句定稿时卡栈快照绑定）", () => {
  it("栈顶指认：awaiting 卡取 seq 最大者（最新到手的卡）", () => {
    const r = resolveVoiceCommand({ kind: "confirm", target: "top" }, cards([1], [2], [3]));
    expect(r).toEqual({ kind: "confirm", targets: [{ actionId: "a3", agentId: "agent-3", seq: 3 }] });
  });

  it("栈顶指认跳过 accepted/done 卡（不可能被二次确认）", () => {
    const r = resolveVoiceCommand({ kind: "confirm", target: "top" }, cards([1], [2, "accepted"], [3, "done"]));
    expect(r).toEqual({ kind: "confirm", targets: [{ actionId: "a1", agentId: "agent-1", seq: 1 }] });
  });

  it("无 awaiting 卡 → 零动作 + noCards 回读", () => {
    expect(resolveVoiceCommand({ kind: "confirm", target: "top" }, [])).toEqual({ kind: "none", reason: "noCards" });
    expect(
      resolveVoiceCommand({ kind: "cancel", target: "top" }, cards([1, "done"])),
    ).toEqual({ kind: "none", reason: "noCards" });
  });

  it("编号指认：seq 命中 awaiting 卡", () => {
    const r = resolveVoiceCommand({ kind: "cancel", target: { seq: 2 } }, cards([1], [2], [3]));
    expect(r).toEqual({ kind: "cancel", targets: [{ actionId: "a2", agentId: "agent-2", seq: 2 }] });
  });

  it("过期/不存在编号 → 零动作 + notFound 回读（彼时无此卡）", () => {
    expect(resolveVoiceCommand({ kind: "confirm", target: { seq: 9 } }, cards([1], [2]))).toEqual({
      kind: "none",
      reason: "notFound",
      seq: 9,
    });
  });

  it("编号卡存在但已 settled（accepted/done）→ 零动作 + settled 回读", () => {
    expect(resolveVoiceCommand({ kind: "confirm", target: { seq: 2 } }, cards([2, "accepted"]))).toEqual({
      kind: "none",
      reason: "settled",
      seq: 2,
    });
  });

  it("全部取消：一次撤销全部 awaiting 卡（含撤销数）；accepted/done 跳过", () => {
    const r = resolveVoiceCommand({ kind: "cancelAll" }, cards([1], [2, "accepted"], [3]));
    expect(r).toEqual({
      kind: "cancelAll",
      targets: [
        { actionId: "a1", agentId: "agent-1", seq: 1 },
        { actionId: "a3", agentId: "agent-3", seq: 3 },
      ],
    });
    expect(resolveVoiceCommand({ kind: "cancelAll" }, [])).toEqual({ kind: "none", reason: "noCards" });
  });
});

// ── 意图门控打断：停止意图快通道词表（barge-in 意图窗批）──────────────────

describe("isStopIntentPhrase（停止意图快通道——interim/final 两级共用）", () => {
  it("停止词全量命中（批 3b 起单源 @helix/protocol——14 词全停词表，双端同源）", () => {
    for (const p of ["停", "停下", "停止", "停一下", "stop", "别说了", "先别说了", "不要说了", "不用说了", "别念了", "别说话了", "闭嘴", "住嘴", "够了"]) {
      expect(isStopIntentPhrase(p)).toBe(true);
    }
  });

  it("尾句读容忍：句尾标点剥除后命中（说出口令常带收尾语气）", () => {
    expect(isStopIntentPhrase("停。")).toBe(true);
    expect(isStopIntentPhrase("别说了！")).toBe(true);
    expect(isStopIntentPhrase(" 不用说了， ")).toBe(true);
  });

  it("夹带/变体不命中：全等主闸——聊天句夹「停」、非停止表达零触发", () => {
    expect(isStopIntentPhrase("先停一下")).toBe(false);
    expect(isStopIntentPhrase("停下来")).toBe(false); // 变体不进快通道（宁缺勿滥——交慢通道/不打断）
    expect(isStopIntentPhrase("暂停")).toBe(false);
    expect(isStopIntentPhrase("你说到哪了")).toBe(false);
    expect(isStopIntentPhrase("")).toBe(false);
    expect(isStopIntentPhrase("  ")).toBe(false);
  });
});
