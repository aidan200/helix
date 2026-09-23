/**
 * 字幕行聚合纯函数测试（B2 全局语音批；StewardCaption 数据面）。
 *
 * 纪律：3-4 行堆叠最新在下（数组尾）超限截头；用户行（final）与管家行
 * （ask.delta 聚合）弱区分；管家流进行 in-place 更新（同一轮 delta 聚合
 * 不涨行）；纯文本层数据面零滚动容器知识。
 */
import { describe, expect, it } from "vitest";
import { CAPTION_MAX_LINES, captionPush, captionUpdateTail } from "./caption-log";

describe("captionPush（行入栈：最新在下 + 上限截头）", () => {
  it("单行入栈", () => {
    const lines = captionPush([], "user", "今天有什么任务");
    expect(lines).toEqual([{ id: 1, kind: "user", text: "今天有什么任务" }]);
  });

  it("多行追加序 = 最新在下；用户行/管家行交替弱区分", () => {
    let lines = captionPush([], "user", "问一");
    lines = captionPush(lines, "steward", "答一");
    lines = captionPush(lines, "user", "问二");
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ["user", "问一"],
      ["steward", "答一"],
      ["user", "问二"],
    ]);
  });

  it(`上限 ${CAPTION_MAX_LINES} 行：超限截头保最新`, () => {
    let lines: ReturnType<typeof captionPush> = [];
    for (let i = 1; i <= CAPTION_MAX_LINES + 2; i += 1) lines = captionPush(lines, "user", `行${i}`);
    expect(lines.length).toBe(CAPTION_MAX_LINES);
    expect(lines[lines.length - 1]!.text).toBe(`行${CAPTION_MAX_LINES + 2}`);
    expect(lines[0]!.text).toBe("行3"); // 最旧两行被截
  });

  it("id 单调（渲染 key 稳定；模块计数器跨用例共享——只钉相对序）", () => {
    let lines = captionPush([], "user", "a");
    const firstId = lines[0]!.id;
    lines = captionPush(lines, "steward", "b");
    expect(lines.map((l) => l.id - firstId)).toEqual([0, 1]);
  });
});

describe("captionUpdateTail（管家流进行 in-place 更新——同一轮 delta 不涨行）", () => {
  it("末尾是同 kind 行 → 原位更新文本", () => {
    let lines = captionPush([], "user", "问");
    lines = captionPush(lines, "steward", "正在");
    const updated = captionUpdateTail(lines, "steward", "正在思考");
    expect(updated.length).toBe(2);
    expect(updated[1]!.text).toBe("正在思考");
    expect(updated[1]!.id).toBe(lines[1]!.id); // 原位：id 不变
  });

  it("末尾非同 kind → 追加新行（含上限截头）", () => {
    let lines = captionPush([], "user", "问");
    const updated = captionUpdateTail(lines, "steward", "答一");
    expect(updated.length).toBe(2);
    expect(updated[1]!.kind).toBe("steward");
    expect(updated[1]!.text).toBe("答一");
    expect(updated[1]!.id).toBeGreaterThan(updated[0]!.id);
  });

  it("空栈 → 追加", () => {
    const added = captionUpdateTail([], "steward", "欢迎");
    expect(added.length).toBe(1);
    expect(added[0]!.kind).toBe("steward");
    expect(added[0]!.text).toBe("欢迎");
  });
});
