/**
 * VocabularyBuilder 纯函数单测（语音输入 V1 Phase 1，设计 §5.3 装配算法）。
 *
 * 测试点清单（零 mock、零 IO——纯函数纪律）：
 * 1. 会话 token 抽取：正则 `[A-Za-z][A-Za-z0-9_.#-]{2,}`；中文/标点隔离。
 * 2. 新近度衰减：最近 10 条 ×1.0，更早 ×0.5（权重基数 3）。
 * 3. 归一丢弃：纯数字 / 超长（>30 字符）/ 单字母丢弃。
 * 4. 去重：小写 key 去重、保留 camelCase 形态（高 weight 者胜、同 weight 首见胜）。
 * 5. 贪心装填：总字符（含分隔符）≤ BUDGET=350 即停。
 * 6. 单源字符占比上限：纠错 ≤10% / 会话 ≤50% / 符号 ≤35% / 基础 ≤5%。
 * 7. hint 紧凑词表串（逗号分隔，无自然语言包装——词表匹配生效机制）。
 * 8. 空输入 → 空词表（不抛错、hint = ""）。
 * 9. 热词 weight clamp 到 DashScope 即时热词域 [1,5]。
 */
import { describe, expect, test } from "bun:test";
import {
  ASR_CONTEXT_BUDGET,
  BASE_VOCABULARY,
  buildAsrContext,
  extractSessionTokens,
} from "../../src/application/stt/VocabularyBuilder";

describe("VocabularyBuilder：会话 token 抽取（P1 源）", () => {
  test("正则抽取 [A-Za-z][A-Za-z0-9_.#-]{2,}——中文夹英文、代码符号形态可抽", () => {
    const tokens = extractSessionTokens(["把 useEffect 里的 bug 修一下"]);
    const terms = [...tokens.values()].map((t) => t.term);
    expect(terms).toContain("useEffect");
    expect(terms).toContain("bug");
  });

  test("连续 token 独立成词：kebab/snake/dot/hash 形态整词保留；/ 与空格断词；2 字符段（kg）不抽（下界≥3）", () => {
    const tokens = extractSessionTokens(["看下 src/kg/node-id.ts 的 resolveMainRepoPath"]);
    const terms = [...tokens.values()].map((t) => t.term);
    expect(terms).toContain("src");
    expect(terms).toContain("node-id.ts");
    expect(terms).toContain("resolveMainRepoPath");
    expect(terms).not.toContain("kg"); // 2 字符段：[A-Za-z0-9_.#-]{2,} 续 2+ 下界之外
  });

  test("短于 3 字符的英文 token 不抽（设计 §5.2 下界：[A-Za-z0-9_.#-]{2,} 续 2+）", () => {
    const tokens = extractSessionTokens(["a b ab abc"]);
    const terms = [...tokens.values()].map((t) => t.term);
    expect(terms).toEqual(["abc"]);
  });

  test("纯中文消息产出空 token 集", () => {
    expect(extractSessionTokens(["你好，请帮我看一下这个"]).size).toBe(0);
  });

  test("新近度衰减：最近 10 条内 ×1.0（基数 3 → 3），更早条目 ×0.5（3 × 0.5 = 1.5）", () => {
    // 11 条消息：index 0 = 最近；同 key 重复出现时取最高权重来源（新近条目）
    const messages = [
      ...Array.from({ length: 10 }, () => "无关内容"),
      "useEffect", // index 10：最旧档（×0.5）
    ];
    const stale = extractSessionTokens(messages).get("useeffect");
    expect(stale?.weight).toBe(1.5);

    const fresh = extractSessionTokens(["useEffect"]).get("useeffect");
    expect(fresh?.weight).toBe(3);
  });
});

describe("VocabularyBuilder：buildAsrContext 装配", () => {
  test("空输入 → 空词表、hint 空串（裸转写路径安全）", () => {
    const out = buildAsrContext({});
    expect(out.terms).toEqual([]);
    expect(out.hint).toBe("");
  });

  test("hint 为紧凑词表串（逗号+空格分隔，无自然语言包装）", () => {
    const out = buildAsrContext({ sessionTerms: ["useEffect", "Tauri"] });
    expect(out.hint).toBe("useEffect, Tauri");
  });

  test("归一丢弃：>30 字符项丢弃、纯数字丢弃、单字母丢弃", () => {
    const long = "a".repeat(31);
    const out = buildAsrContext({
      sessionTerms: [long, "12345", "x", "ok"],
    });
    const terms = out.terms.map((t) => t.term);
    expect(terms).toEqual(["ok"]);
  });

  test("小写 key 去重保 camelCase 形态：同 key 多变体时高 weight 形态胜", () => {
    const out = buildAsrContext({
      sessionTerms: ["useeffect", "useEffect"], // 会话权重同源（同 weight）→ 首见胜
      corrections: [{ term: "useEffect" }], // 纠错 ×5 更高 → camelCase 形态胜出
    });
    expect(out.terms.map((t) => t.term)).toEqual(["useEffect"]);
    expect(out.terms.length).toBe(1); // 去重后单条
  });

  test("weight 降序贪心：纠错(×5) → 会话(×3) → 符号(×2) → 基础(×1)", () => {
    const out = buildAsrContext({
      corrections: [{ term: "kubectl" }],
      sessionTerms: ["useEffect"],
      symbols: ["resolveMainRepoPath"],
      baseTerms: ["merge"],
    });
    expect(out.terms.map((t) => t.term)).toEqual(["kubectl", "useEffect", "resolveMainRepoPath", "merge"]);
  });

  test("字符预算 B=350：多源合计装填后 hint 总长（含分隔符）≤ 350 即停；单源独占时受单源占比约束更早停", () => {
    // 多源联合（会话 50% + 符号 35% + 纠错 10% ≈ 95% 预算可达）：逼近但不超 B
    const manySession = Array.from({ length: 100 }, (_, i) => `session${String(i).padStart(4, "0")}`);
    const manySymbols = Array.from({ length: 100 }, (_, i) => `symbol${String(i).padStart(4, "0")}`);
    const corrections = Array.from({ length: 10 }, (_, i) => ({ term: `fixword${i}` }));
    const out = buildAsrContext({ sessionTerms: manySession, symbols: manySymbols, corrections });
    expect(out.hint.length).toBeLessThanOrEqual(ASR_CONTEXT_BUDGET);
    expect(out.hint.length).toBeGreaterThan(200); // 多源联合确实逼近总预算（非单源早停）
    expect(out.terms.length).toBeLessThan(210); // 且被预算截断
    // 单源独占：仅会话供给 → 50% 占比上限（比 B 更早停）
    const solo = buildAsrContext({ sessionTerms: manySession });
    expect(solo.hint.length).toBeLessThanOrEqual(Math.ceil(ASR_CONTEXT_BUDGET * 0.5) + 2);
    expect(solo.terms.length).toBeGreaterThan(10); // 装填了相当数量（非全丢）
  });

  test("单源字符占比上限：基础词表 ≤5%（350 → ~17 字符）——超占比后停收基础词", () => {
    const out = buildAsrContext({
      sessionTerms: ["useEffect", "Tauri", "codegraph"], // 会话源填充大头
      baseTerms: Array.from({ length: 60 }, (_, i) => `base${i}`), // 基础词超量供给
    });
    const baseTerms = out.terms.filter((t) => t.source === "base");
    const baseChars = baseTerms.reduce((n, t) => n + t.term.length + 2, 0);
    expect(baseChars).toBeLessThanOrEqual(Math.ceil(ASR_CONTEXT_BUDGET * 0.05) + 2); // 容一个词粒度（追加后才判超）
  });

  test("单源字符占比上限：会话源 ≤50%——仅会话供给时最多装一半预算", () => {
    const many = Array.from({ length: 200 }, (_, i) => `sess${String(i).padStart(4, "0")}`);
    const out = buildAsrContext({ sessionTerms: many });
    const sessionChars = out.terms.reduce((n, t) => n + t.term.length + 2, 0);
    expect(sessionChars).toBeLessThanOrEqual(Math.ceil(ASR_CONTEXT_BUDGET * 0.5) + 12); // 容一个词粒度
    expect(out.hint.length).toBeLessThanOrEqual(ASR_CONTEXT_BUDGET);
  });

  test("热词 weight clamp [1,5]：内部高权重（纠错 ×5×衰减不存在场景下 >5）截到 5，低权重抬到 ≥1", () => {
    const out = buildAsrContext({
      corrections: [{ term: "kubectl", weight: 9 }], // 外部权重越域
      sessionTerms: ["useEffect"],
    });
    for (const t of out.terms) {
      expect(t.weight).toBeGreaterThanOrEqual(1);
      expect(t.weight).toBeLessThanOrEqual(5);
    }
  });

  test("内置基础词表（P3）非空且去重后可用", () => {
    expect(BASE_VOCABULARY.length).toBeGreaterThanOrEqual(80);
    const lowered = BASE_VOCABULARY.map((t) => t.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length); // 无重复 key
  });
});
