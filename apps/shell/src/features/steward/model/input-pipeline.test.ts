/**
 * input-pipeline 测试（光球分区批：左侧输入流水色态链与短驻驱逐）。
 */
import { describe, expect, it } from "vitest";
import {
  inputAnnotate,
  inputConfirm,
  inputEvict,
  inputHearing,
  inputResolve,
  INPUT_MAX_ROWS,
  INPUT_ROW_TTL,
  INPUT_TERMINAL_TTL,
  type InputRow,
} from "./input-pipeline";

const T0 = 1_000;

describe("input-pipeline（左侧输入流水）", () => {
  it("hearing：interim 进入灰态行，原位更新不涨行（同句实时解析）", () => {
    let rows: readonly InputRow[] = [];
    rows = inputHearing(rows, "今", T0);
    rows = inputHearing(rows, "今天", T0 + 10);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ text: "今天", state: "hearing" });
  });

  it("confirm：final 定稿把 hearing 尾行转正（白色态 confirmed，id 稳定）；无 hearing 行则追加", () => {
    let rows: readonly InputRow[] = [];
    rows = inputHearing(rows, "今天天气", T0);
    const id = rows[0]!.id;
    rows = inputConfirm(rows, "今天天气怎么样", T0 + 50);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ id, text: "今天天气怎么样", state: "confirmed" });
    rows = inputConfirm(rows, "第二句", T0 + 80);
    expect(rows.length).toBe(2);
    expect(rows[1]).toMatchObject({ text: "第二句", state: "confirmed" });
  });

  it("resolve：done 转主题成功色态 / failed 带 asr-fail 注记转失败态——终态短驻后消失", () => {
    let rows: readonly InputRow[] = [];
    rows = inputConfirm(rows, "好句", T0);
    rows = inputResolve(rows, { state: "done" }, T0 + 10);
    expect(rows[0]!.state).toBe("done");
    // 终态 TTL 内驻留，超时驱逐
    expect(inputEvict(rows, T0 + 10 + INPUT_TERMINAL_TTL - 1)[0]).toBeDefined();
    expect(inputEvict(rows, T0 + 10 + INPUT_TERMINAL_TTL + 1).length).toBe(0);

    rows = inputConfirm([], "坏句", T0);
    rows = inputResolve(rows, { state: "failed", note: { kind: "asr-fail" } }, T0 + 5);
    expect(rows[0]).toMatchObject({ state: "failed", note: { kind: "asr-fail" } });
  });

  it("rejected：声纹未过带相似度与阈值注记；judge 注记异步回判翻最近 done 行（非交流意图）", () => {
    let rows: readonly InputRow[] = [];
    rows = inputConfirm(rows, "旁人的话", T0);
    rows = inputResolve(rows, { state: "rejected", note: { kind: "voiceprint-reject", pct: 42, th: 60 } }, T0 + 5);
    expect(rows[0]).toMatchObject({ state: "rejected", note: { kind: "voiceprint-reject", pct: 42, th: 60 } });

    // judge dropped 在 dispatch（done）之后回执——翻 done 行
    let rows2: readonly InputRow[] = [];
    rows2 = inputConfirm(rows2, "广告声", T0);
    rows2 = inputResolve(rows2, { state: "done" }, T0 + 5);
    rows2 = inputAnnotate(rows2, { kind: "judge-reject" }, T0 + 40);
    expect(rows2[0]).toMatchObject({ state: "rejected", note: { kind: "judge-reject" } });
  });

  it("annotate 无可判行补注记行（异步回执先于行到达的防御）", () => {
    const rows = inputAnnotate([], { kind: "judge-reject" }, T0);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ text: "", state: "rejected", note: { kind: "judge-reject" } });
  });

  it("行上限截头保最新；全行硬上限 TTL 驱逐 hearing/confirmed 残行", () => {
    let rows: readonly InputRow[] = [];
    for (let i = 0; i < INPUT_MAX_ROWS + 2; i += 1) {
      rows = inputConfirm(rows, `句${i}`, T0 + i);
    }
    expect(rows.length).toBe(INPUT_MAX_ROWS);
    expect(rows[rows.length - 1]!.text).toBe(`句${INPUT_MAX_ROWS + 1}`);
    // 残行（无终态推进）超硬上限也驱逐——不积压
    expect(inputEvict(rows, T0 + INPUT_ROW_TTL + 100).length).toBe(0);
  });

  it("evict 无变化原引用短路（无谓重渲染零）", () => {
    const rows = inputConfirm([], "活句", T0);
    expect(inputEvict(rows, T0 + 1)).toBe(rows);
  });
});
