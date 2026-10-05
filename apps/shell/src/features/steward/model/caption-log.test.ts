/**
 * 字幕行聚合纯函数测试（B2 全局语音批；StewardCaption 数据面；短驻批
 * （用户裁决 2026-10）：上限 2 行 + TTL 6s 驻留——气泡只在事件发生期可见）。
 *
 * 纪律：行栈最新在下超限截头；用户行（final）与管家行（ask.delta 聚合）
 * 弱区分；管家流进行 in-place 更新（同一轮 delta 聚合不涨行 + at 刷新保活）；
 * 静置超 TTL 自动移除（captionEvict，无淘汰恒等短路）；纯文本层数据面
 * 零滚动容器知识。
 */
import { describe, expect, it } from "vitest";
import {
  CAPTION_MAX_LINES,
  CAPTION_TTL_MS,
  captionEvict,
  captionPush,
  captionUpdateTail,
} from "./caption-log";

describe("captionPush（行入栈：最新在下 + 上限截头 + at 记入栈时刻）", () => {
  it("单行入栈（at 注入可测）", () => {
    const lines = captionPush([], "user", "今天有什么任务", CAPTION_MAX_LINES, 1_000);
    expect(lines).toEqual([{ id: 1, kind: "user", text: "今天有什么任务", at: 1_000 }]);
  });

  it("多行追加序 = 最新在下；用户行/管家行交替弱区分（max 放宽至 4 钉序——短驻批缺省 2 会截头）", () => {
    let lines = captionPush([], "user", "问一", 4, 1_000);
    lines = captionPush(lines, "steward", "答一", 4, 2_000);
    lines = captionPush(lines, "user", "问二", 4, 3_000);
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
    expect(lines[0]!.text).toBe("行3"); // 更旧行被截（短驻批：只留最新问答对）
  });

  it("id 单调（渲染 key 稳定；模块计数器跨用例共享——只钉相对序）", () => {
    let lines = captionPush([], "user", "a");
    const firstId = lines[0]!.id;
    lines = captionPush(lines, "steward", "b");
    expect(lines.map((l) => l.id - firstId)).toEqual([0, 1]);
  });
});

describe("captionUpdateTail（管家流进行 in-place 更新——同一轮 delta 不涨行）", () => {
  it("末尾是同 kind 行 → 原位更新文本 + at 刷新（流进行中途不过期）", () => {
    let lines = captionPush([], "user", "问", CAPTION_MAX_LINES, 1_000);
    lines = captionPush(lines, "steward", "正在", CAPTION_MAX_LINES, 2_000);
    const updated = captionUpdateTail(lines, "steward", "正在思考", CAPTION_MAX_LINES, 6_500);
    expect(updated.length).toBe(2);
    expect(updated[1]!.text).toBe("正在思考");
    expect(updated[1]!.id).toBe(lines[1]!.id); // 原位：id 不变
    expect(updated[1]!.at).toBe(6_500); // at 刷新：静置时钟重起
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

describe("captionEvict（TTL 驻留：静置超时整行移除）", () => {
  it("静置未超 TTL → 保留", () => {
    const lines = captionPush([], "user", "问", CAPTION_MAX_LINES, 1_000);
    expect(captionEvict(lines, 1_000 + CAPTION_TTL_MS - 1).length).toBe(1);
  });

  it("静置达/超 TTL → 移除（≥ 语义）；到期只移除到期行", () => {
    let lines = captionPush([], "user", "老问", CAPTION_MAX_LINES, 1_000);
    lines = captionUpdateTail(lines, "steward", "新答", CAPTION_MAX_LINES, 6_000);
    const kept = captionEvict(lines, 7_000); // 老问静置 6s 到期；新答静置 1s
    expect(kept.map((l) => l.text)).toEqual(["新答"]);
    expect(captionEvict(kept, 6_000 + CAPTION_TTL_MS).length).toBe(0); // 边界：恰达 TTL 即移除
  });

  it("流式更新保活：at 刷新后按新时刻起算", () => {
    let lines = captionPush([], "steward", "流前半", CAPTION_MAX_LINES, 1_000);
    lines = captionUpdateTail(lines, "steward", "流前半后半", CAPTION_MAX_LINES, 6_500);
    expect(captionEvict(lines, 7_000).length).toBe(1); // 若按旧 at 已过期——刷新后存活
  });

  it("无淘汰 → 原引用恒等返回（tick 空转零重渲）", () => {
    const lines = captionPush([], "user", "问", CAPTION_MAX_LINES, Date.now());
    expect(captionEvict(lines, Date.now())).toBe(lines);
  });
});
