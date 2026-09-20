/**
 * SentenceBuffer 单测（V3b-2 分句缓冲；TDD 红→绿）。
 *
 * 用例面（brief 测试要求 1）：
 * - delta 序列跨 push 累积 → 句读边界切分（。！？；… 及换行）；
 * - 无标点强制切（1.5s 定时器驱动方调 cut()）；
 * - LLM 流终止尾句冲刷（flush）；
 * - 连续边界合并（！！/……不拆）；
 * - 空白句不产出；reset 清位（新一轮回答）。
 */
import { describe, expect, test } from "vitest";
import { SentenceBuffer, SENTENCE_BOUNDARY_CHARS } from "./sentence-splitter";

describe("SentenceBuffer（V3b-2 delta → 句切分）", () => {
  test("① delta 跨 push 累积：边界到达即切，句含边界符", () => {
    const b = new SentenceBuffer();
    expect(b.push("你")).toEqual([]);
    expect(b.push("好，我是管")).toEqual([]);
    expect(b.push("家。")).toEqual(["你好，我是管家。"]);
    expect(b.push("今天天气不错！")).toEqual(["今天天气不错！"]);
  });

  test("② 单 delta 多句：一次切出多句（按序）", () => {
    const b = new SentenceBuffer();
    expect(b.push("早上好。任务完成了！要继续吗？")).toEqual(["早上好。", "任务完成了！", "要继续吗？"]);
  });

  test("③ 换行是句界；句首空白剥除", () => {
    const b = new SentenceBuffer();
    expect(b.push("第一行\n第二行没有结束")).toEqual(["第一行\n"]);
    expect(b.push("但是换行了\n2. 点列表项；好了")).toEqual(["第二行没有结束但是换行了\n", "2. 点列表项；"]);
  });

  test("④ 连续边界合并（！！！/……不拆句）", () => {
    const b = new SentenceBuffer();
    expect(b.push("真的吗？！太好了……")).toEqual(["真的吗？！太好了……"]);
  });

  test("⑤ 无标点强制切：cut() 把残余整段切出（空残量 null）", () => {
    const b = new SentenceBuffer();
    b.push("这是一段很长但完全没有句读的文本");
    expect(b.cut()).toBe("这是一段很长但完全没有句读的文本");
    expect(b.cut()).toBeNull();
  });

  test("⑥ 流终止尾句冲刷：flush() 无边界尾句也产出", () => {
    const b = new SentenceBuffer();
    b.push("第一句。第二句没有标点");
    expect(b.flush()).toBe("第二句没有标点");
    expect(b.flush()).toBeNull();
  });

  test("⑦ 空白句不产出（纯空白 delta / 空尾）", () => {
    const b = new SentenceBuffer();
    expect(b.push("   \n  \n")).toEqual([]);
    expect(b.flush()).toBeNull();
    expect(b.cut()).toBeNull();
  });

  test("⑧ reset 清位：新一轮回答残余不泄漏", () => {
    const b = new SentenceBuffer();
    b.push("上轮残余");
    b.reset();
    expect(b.flush()).toBeNull();
  });

  test("⑨ 省略号单字符也是边界（英文 !?; 同判）", () => {
    const b = new SentenceBuffer();
    expect(b.push("wait… what? yes! ok;")).toEqual(["wait…", "what?", "yes!", "ok;"]);
    expect(SENTENCE_BOUNDARY_CHARS).toContain("…");
    expect(SENTENCE_BOUNDARY_CHARS).toContain("\n");
  });
});
