/**
 * kg 查重阈值配置域（kg.similarityWarn / kg.similarityDup）读面解析单测
 * （批2 WP-C §5.2；TDD 红绿证据链）。
 *
 * 断言面（memory.recallMinScore 先例同款哲学——写面不做前置值校验，值
 * 语义读面单点裁决）：
 * 1. 缺省对 0.80 / 0.92（KV 缺席/空串 = 未配置态 → 缺省零行为变化）；
 * 2. 合法自定义值 [0,1] 生效；
 * 3. 非法值（负数 / >1 / 非数 / NaN / Infinity）→ 该键静默回退缺省 + warn
 *    不抛错（查重绝不挡知识写入）；
 * 4. warn > dup 颠倒 → **整对**回退缺省 + warn（配对约束）；warn == dup
 *    不算颠倒（合法——dup 档同时触发 warn 档，语义自洽）。
 *
 * 检索语义化批追加（kg.semanticTopK / kg.semanticMinScore 读面裁决）：
 * 5. 语义召回缺省对 5 / 0.35（缺席/空串 = 未配置态）；
 * 6. 合法自定义生效（topK 有限整数 [1,50]；minScore [0,1]）；
 * 7. 非法逐键回退缺省 + warn（无配对约束——topK/minScore 无序关系，
 *    不套 warn≤dup 整对回退；与查重阈值对相互独立裁决）。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import {
  KG_SEMANTIC_MINSCORE_DEFAULT,
  KG_SEMANTIC_MINSCORE_KEY,
  KG_SEMANTIC_TOPK_DEFAULT,
  KG_SEMANTIC_TOPK_KEY,
  KG_SIMILARITY_DUP_DEFAULT,
  KG_SIMILARITY_DUP_KEY,
  KG_SIMILARITY_WARN_DEFAULT,
  KG_SIMILARITY_WARN_KEY,
  resolveKgSemanticRecallSettings,
  resolveKgSimilarityThresholds,
} from "../../src/application/services/kg/kgConfig";

function fakeConfig(kv: Record<string, string>): Pick<RuntimeConfigPort, "get"> {
  return { get: (key: string) => kv[key] } as Pick<RuntimeConfigPort, "get">;
}

describe("kg 查重阈值读面解析（resolveKgSimilarityThresholds）", () => {
  test("① 缺省对 0.80/0.92：KV 缺席与空串均 = 未配置态", () => {
    expect(resolveKgSimilarityThresholds(fakeConfig({}))).toEqual({ warn: 0.8, dup: 0.92 });
    expect(
      resolveKgSimilarityThresholds(
        fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "", [KG_SIMILARITY_DUP_KEY]: "" }),
      ),
    ).toEqual({ warn: 0.8, dup: 0.92 });
    expect(KG_SIMILARITY_WARN_DEFAULT).toBe(0.8);
    expect(KG_SIMILARITY_DUP_DEFAULT).toBe(0.92);
  });

  test("② 合法自定义值生效（[0,1] 闭区间含边界）", () => {
    const t = resolveKgSimilarityThresholds(
      fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "0.75", [KG_SIMILARITY_DUP_KEY]: "0.95" }),
    );
    expect(t).toEqual({ warn: 0.75, dup: 0.95 });
    expect(
      resolveKgSimilarityThresholds(fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "0", [KG_SIMILARITY_DUP_KEY]: "1" })),
    ).toEqual({ warn: 0, dup: 1 });
  });

  test("③ 非法值逐键回退缺省 + warn（不抛错）", () => {
    for (const bad of ["-0.1", "1.5", "abc", "NaN", "Infinity", "0.5.1"]) {
      const warnings: string[] = [];
      const t = resolveKgSimilarityThresholds(
        fakeConfig({ [KG_SIMILARITY_WARN_KEY]: bad, [KG_SIMILARITY_DUP_KEY]: "0.9" }),
        (m) => warnings.push(m),
      );
      expect(t.warn).toBe(KG_SIMILARITY_WARN_DEFAULT);
      expect(t.dup).toBe(0.9);
      expect(warnings.length).toBeGreaterThan(0);
    }
    // dup 侧非法同样单键回退
    const warnings: string[] = [];
    const t = resolveKgSimilarityThresholds(
      fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "0.7", [KG_SIMILARITY_DUP_KEY]: "2" }),
      (m) => warnings.push(m),
    );
    expect(t).toEqual({ warn: 0.7, dup: KG_SIMILARITY_DUP_DEFAULT });
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("④ warn > dup 颠倒 → 整对回退缺省 + warn；warn == dup 不算颠倒", () => {
    const warnings: string[] = [];
    const inverted = resolveKgSimilarityThresholds(
      fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "0.95", [KG_SIMILARITY_DUP_KEY]: "0.9" }),
      (m) => warnings.push(m),
    );
    expect(inverted).toEqual({ warn: KG_SIMILARITY_WARN_DEFAULT, dup: KG_SIMILARITY_DUP_DEFAULT });
    expect(warnings.length).toBeGreaterThan(0);
    // 边界：warn == dup 合法（dup 档触发时 warn 档同时触发，语义自洽不回退）
    expect(
      resolveKgSimilarityThresholds(fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "0.9", [KG_SIMILARITY_DUP_KEY]: "0.9" })),
    ).toEqual({ warn: 0.9, dup: 0.9 });
    // 非法回退后的解析值也参与配对校验（warn 非法回 0.80 < dup 0.7 仍颠倒）
    const warnings2: string[] = [];
    expect(
      resolveKgSimilarityThresholds(
        fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "abc", [KG_SIMILARITY_DUP_KEY]: "0.7" }),
        (m) => warnings2.push(m),
      ),
    ).toEqual({ warn: KG_SIMILARITY_WARN_DEFAULT, dup: KG_SIMILARITY_DUP_DEFAULT });
    expect(warnings2.length).toBeGreaterThan(0);
  });
});

describe("kg 语义召回读面解析（resolveKgSemanticRecallSettings）", () => {
  test("⑤ 缺省对 5/0.35：KV 缺席与空串均 = 未配置态", () => {
    expect(resolveKgSemanticRecallSettings(fakeConfig({}))).toEqual({ topK: 5, minScore: 0.35 });
    expect(
      resolveKgSemanticRecallSettings(
        fakeConfig({ [KG_SEMANTIC_TOPK_KEY]: "", [KG_SEMANTIC_MINSCORE_KEY]: "" }),
      ),
    ).toEqual({ topK: 5, minScore: 0.35 });
    expect(KG_SEMANTIC_TOPK_DEFAULT).toBe(5);
    expect(KG_SEMANTIC_MINSCORE_DEFAULT).toBe(0.35);
  });

  test("⑥ 合法自定义值生效（topK 整数 [1,50]；minScore [0,1] 含边界）", () => {
    expect(
      resolveKgSemanticRecallSettings(fakeConfig({ [KG_SEMANTIC_TOPK_KEY]: "3", [KG_SEMANTIC_MINSCORE_KEY]: "0.5" })),
    ).toEqual({ topK: 3, minScore: 0.5 });
    expect(
      resolveKgSemanticRecallSettings(fakeConfig({ [KG_SEMANTIC_TOPK_KEY]: "50", [KG_SEMANTIC_MINSCORE_KEY]: "0" })),
    ).toEqual({ topK: 50, minScore: 0 });
  });

  test("⑦ 非法逐键回退缺省 + warn（topK 非整/越界/非数；minScore 出 [0,1]）", () => {
    for (const bad of ["2.5", "0", "-1", "51", "abc", "NaN", "Infinity"]) {
      const warnings: string[] = [];
      const s = resolveKgSemanticRecallSettings(
        fakeConfig({ [KG_SEMANTIC_TOPK_KEY]: bad, [KG_SEMANTIC_MINSCORE_KEY]: "0.4" }),
        (m) => warnings.push(m),
      );
      expect(s.topK).toBe(KG_SEMANTIC_TOPK_DEFAULT);
      expect(s.minScore).toBe(0.4);
      expect(warnings.length).toBeGreaterThan(0);
    }
    const warnings: string[] = [];
    const s = resolveKgSemanticRecallSettings(
      fakeConfig({ [KG_SEMANTIC_TOPK_KEY]: "8", [KG_SEMANTIC_MINSCORE_KEY]: "1.2" }),
      (m) => warnings.push(m),
    );
    expect(s).toEqual({ topK: 8, minScore: KG_SEMANTIC_MINSCORE_DEFAULT });
    expect(warnings.length).toBeGreaterThan(0);
    // 整对语义边界：语义对无配对约束（topK/minScore 无序关系）——两键各自独立
    //  回退，不套查重对 warn>dup 的整对回退；查重对整对语义不受语义对影响
    const warnings2: string[] = [];
    const mixed = resolveKgSimilarityThresholds(
      fakeConfig({ [KG_SIMILARITY_WARN_KEY]: "0.95", [KG_SIMILARITY_DUP_KEY]: "0.9" }),
      (m) => warnings2.push(m),
    );
    expect(mixed).toEqual({ warn: KG_SIMILARITY_WARN_DEFAULT, dup: KG_SIMILARITY_DUP_DEFAULT });
    expect(warnings2.length).toBeGreaterThan(0);
  });
});
