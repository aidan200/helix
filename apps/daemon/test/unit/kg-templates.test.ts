import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SEGMENT_CATALOG,
  SEGMENT_SCENARIOS,
  TEMPLATE_HARD_CONSTRAINTS,
} from "../../src/adapters/driven/pi-engine/runtime/templates/catalog";
import {
  BRIEF_ASSEMBLY_GUIDE,
  REPORT_ASSEMBLY_GUIDE,
} from "../../src/adapters/driven/pi-engine/runtime/templates/guide";
import {
  checkEmptySectionOmission,
  validateBrief,
  validateReport,
} from "../../src/adapters/driven/pi-engine/runtime/templates/validate";
import { MAIN_SESSION_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SUBAGENT_SYSTEM_PROMPT } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";

/**
 * T4.2 模板体系（AD-18，CL-1 F1.3 / CL-3 F3.1+F3.3，测试映射 test-design
 * §2.1 F1.3 / §2.3 A5）：段库+LLM 装配+三条硬约束的机械判据——
 * 只测硬约束机械规则与段库资产存在性；LLM 选段质量归验证期人审（AD-6），
 * 不在本测试面（test-design §4 不可确定性断言清单第 3 条）。
 */

const TEMPLATES_DIR = join(
  import.meta.dir,
  "../../src/adapters/driven/pi-engine/runtime/templates",
);

// ───────────────────────────── validateBrief（CL-1.A10 机械化） ─────────────────────────────

/** 三要素齐备的合法 brief 夹具（其余段从简——校验只判三要素）。 */
const VALID_BRIEF = [
  "## 任务目标",
  "交付附着匹配纯逻辑四件套。",
  "",
  "## 范围钳制",
  "不做：embedding、语义检索。",
  "",
  "## 完成标准",
  "验收：单测全绿；交付物：四文件。",
].join("\n");

describe("validateBrief：brief 三要素硬约束（硬约束①）", () => {
  test("① 三要素齐 → 通过（零 violation）", () => {
    expect(validateBrief(VALID_BRIEF)).toEqual([]);
  });

  test("② 缺任务目标 → 精确指认 violation", () => {
    const brief = VALID_BRIEF.replace("## 任务目标", "## 任务范围");
    const violations = validateBrief(brief);
    expect(violations.map((v) => v.rule)).toEqual(["brief.missing-task-goal"]);
  });

  test("③ 缺范围钳制 → 精确指认 violation", () => {
    const brief = VALID_BRIEF.replace("## 范围钳制", "## 任务边界");
    const violations = validateBrief(brief);
    expect(violations.map((v) => v.rule)).toEqual(["brief.missing-scope-clamp"]);
  });

  test("④ 缺完成判定 → 精确指认 violation（完成标准/完成判定/验收 标题均承载该要素）", () => {
    const brief = VALID_BRIEF.replace("## 完成标准", "## 交付物");
    const violations = validateBrief(brief);
    expect(violations.map((v) => v.rule)).toEqual(["brief.missing-completion-criteria"]);
  });

  test("⑤ 空文本 → 三要素全缺（三条 violation 各自指认）", () => {
    expect(validateBrief("").map((v) => v.rule)).toEqual([
      "brief.missing-task-goal",
      "brief.missing-scope-clamp",
      "brief.missing-completion-criteria",
    ]);
  });

  test("⑥ 标题在但内容为空 → 要素仍判缺失（存在性判据=标题+非空内容）", () => {
    const brief = ["## 任务目标", "", "## 范围钳制", "不做 X。", "", "## 完成标准", "验收全绿。"].join("\n");
    expect(validateBrief(brief).map((v) => v.rule)).toEqual(["brief.missing-task-goal"]);
  });

  test("⑦ 源文档拼写变体「范围锥制」同判为要素在（钳制/锥制混用防御）", () => {
    const brief = VALID_BRIEF.replace("## 范围钳制", "## 范围锥制");
    expect(validateBrief(brief)).toEqual([]);
  });
});

// ───────────────────────────── validateReport（CL-3.A5 机械化） ─────────────────────────────

describe("validateReport：summary+findings 硬约束与显式「无」原则（硬约束②）", () => {
  test("① summary+findings 齐且 findings 有实质内容 → 通过", () => {
    const report = [
      "## summary",
      "四件套交付，52 单测全绿。",
      "",
      "## findings",
      "- 新知识候选：附着预算裁剪顺序可沉淀。",
    ].join("\n");
    expect(validateReport(report)).toEqual([]);
  });

  test("② 缺 summary → violation", () => {
    const report = ["## findings", "无"].join("\n");
    expect(validateReport(report).map((v) => v.rule)).toEqual(["report.missing-summary"]);
  });

  test("③ 缺 findings → violation", () => {
    const report = ["## summary", "一句话结论。"].join("\n");
    expect(validateReport(report).map((v) => v.rule)).toEqual(["report.missing-findings"]);
  });

  test("④ findings 空显式写「无」→ 通过（显式「无」原则，AD-14/kg 落账输入）", () => {
    const report = ["## summary", "一句话结论。", "", "## findings", "无"].join("\n");
    expect(validateReport(report)).toEqual([]);
  });

  test("⑤ findings 空显式写「「无」」（带装饰括号）→ 通过", () => {
    const report = ["## summary", "一句话结论。", "", "## findings", "「无」"].join("\n");
    expect(validateReport(report)).toEqual([]);
  });

  test("⑥ findings 标题在但内容为空 → violation（空不算显式「无」）", () => {
    const report = ["## summary", "一句话结论。", "", "## findings", ""].join("\n");
    expect(validateReport(report).map((v) => v.rule)).toEqual(["report.findings-not-explicit-none"]);
  });

  test("⑦ findings 为「（无内容）」类占位 → violation（占位不等于显式「无」）", () => {
    const report = ["## summary", "一句话结论。", "", "## findings", "（无内容）"].join("\n");
    expect(validateReport(report).map((v) => v.rule)).toEqual(["report.findings-not-explicit-none"]);
  });

  test("⑧ summary 标题在但内容为空 → 判 missing-summary", () => {
    const report = ["## summary", "", "## findings", "无"].join("\n");
    expect(validateReport(report).map((v) => v.rule)).toEqual(["report.missing-summary"]);
  });
});

// ───────────────────────────── checkEmptySectionOmission（硬约束③） ─────────────────────────────

describe("checkEmptySectionOmission：空段省略不占位", () => {
  test("① 标题后紧跟空内容（下一个标题前无正文）→ violation", () => {
    const text = ["## 任务目标", "交付 X。", "", "## 背景", "", "## 完成标准", "验收全绿。"].join("\n");
    const violations = checkEmptySectionOmission(text);
    expect(violations.map((v) => v.rule)).toEqual(["template.empty-section"]);
    expect(violations[0]!.message).toContain("背景");
  });

  test("② 标题后到文本结束全空白 → violation", () => {
    const text = ["## 任务目标", "交付 X。", "", "## 背景", "   "].join("\n");
    expect(checkEmptySectionOmission(text).map((v) => v.rule)).toEqual(["template.empty-section"]);
  });

  test("③ 「（无内容）」类占位行 → violation（占位文本仍视为空段）", () => {
    const text = ["## 背景", "（无内容）"].join("\n");
    expect(checkEmptySectionOmission(text).map((v) => v.rule)).toEqual(["template.placeholder-section"]);
  });

  test("④ 「待补充」占位 → violation", () => {
    const text = ["## 背景", "- 待补充"].join("\n");
    expect(checkEmptySectionOmission(text).map((v) => v.rule)).toEqual(["template.placeholder-section"]);
  });

  test("⑤ findings 段显式「无」→ 不占位违例（显式「无」是合法内容非空段）", () => {
    const text = ["## summary", "结论。", "", "## findings", "无"].join("\n");
    expect(checkEmptySectionOmission(text)).toEqual([]);
  });

  test("⑥ 正常多段文档 → 零 violation", () => {
    const text = ["## 任务目标", "交付 X。", "", "## 范围钳制", "不做 Y。", "", "## 完成标准", "验收全绿。"].join("\n");
    expect(checkEmptySectionOmission(text)).toEqual([]);
  });

  test("⑦ 一级标题（文档题名）不作段判；父子嵌套子段有内容不算空段", () => {
    const text = ["# 任务 brief", "", "## 完成标准", "", "### 验收条件", "全绿。", "", "### 交付物", "四文件。"].join("\n");
    expect(checkEmptySectionOmission(text)).toEqual([]);
  });
});

// ───────────────────────────── 段库资产存在性（test-design §2.1 F1.3） ─────────────────────────────

describe("段库资产：三场景段文件齐备（目录↔清单零漂移）", () => {
  test("① 每场景目录文件集与 SEGMENT_CATALOG 精确一致（不多不漏）", () => {
    for (const scenario of SEGMENT_SCENARIOS) {
      const dir = join(TEMPLATES_DIR, scenario);
      expect(existsSync(dir), `段库目录缺失：${scenario}`).toBe(true);
      const expected = SEGMENT_CATALOG.filter((s) => s.scenario === scenario).map((s) => s.file).sort();
      const actual = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
      expect(actual).toEqual(expected);
    }
  });

  test("② 每段文件含自身标准段标题（title↔文件内容零漂移，硬约束机械判据的标题来源）", () => {
    for (const seg of SEGMENT_CATALOG) {
      const content = readFileSync(join(TEMPLATES_DIR, seg.scenario, seg.file), "utf-8");
      expect(content).toContain(`## ${seg.title}`);
    }
  });

  test("③ 三场景硬约束段齐备：brief 六段（含任务目标/范围钳制/完成标准三要素载体）、report 四段（含 summary/findings）、kg-change-report 四类条目", () => {
    const titles = (scenario: string) =>
      SEGMENT_CATALOG.filter((s) => s.scenario === scenario).map((s) => s.title);
    expect(titles("brief")).toEqual(["任务目标", "背景", "kg 约束切片", "范围钳制", "测试要求", "完成标准"]);
    expect(titles("report")).toEqual(["summary", "deviation", "findings", "tests 执行记录"]);
    expect(titles("kg-change-report")).toEqual(["失效锚点", "规则冲突", "疑似过时", "知识变化"]);
  });
});

// ───────────────────────────── TEMPLATE-USAGE.md 与硬约束声明 ─────────────────────────────

describe("TEMPLATE-USAGE.md：段库目录+硬约束声明+装配示例", () => {
  const usage = readFileSync(join(TEMPLATES_DIR, "TEMPLATE-USAGE.md"), "utf-8");

  test("① 文件存在且含全部段目录行（每段 title 出现）", () => {
    expect(existsSync(join(TEMPLATES_DIR, "TEMPLATE-USAGE.md"))).toBe(true);
    for (const seg of SEGMENT_CATALOG) {
      expect(usage).toContain(seg.title);
    }
  });

  test("② 三条硬约束声明齐备", () => {
    for (const c of TEMPLATE_HARD_CONSTRAINTS) {
      expect(usage).toContain(c.text);
    }
    expect(TEMPLATE_HARD_CONSTRAINTS).toHaveLength(3);
  });

  test("③ 含装配示例段（非强制格式声明）", () => {
    expect(usage).toContain("装配示例");
    expect(usage).toContain("非强制");
  });
});

// ───────────────────────────── profile 提示词携带装配指引（AD-18 接线） ─────────────────────────────

describe("profile 接线：提示词携带段库目录+硬约束+装配示例引用", () => {
  test("① MainSessionProfile 提示词含 brief 装配指引段（diff 可见追加）", () => {
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain(BRIEF_ASSEMBLY_GUIDE);
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("模板段库");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("硬约束");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("TEMPLATE-USAGE.md");
  });

  test("② SubAgentProfile 提示词含 report 装配指引段（diff 可见追加）", () => {
    expect(SUBAGENT_SYSTEM_PROMPT).toContain(REPORT_ASSEMBLY_GUIDE);
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("模板段库");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("硬约束");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("TEMPLATE-USAGE.md");
  });

  test("③ 装配指引含三条硬约束全文与三场景段目录（携带完整，不只引路径）", () => {
    for (const guide of [BRIEF_ASSEMBLY_GUIDE, REPORT_ASSEMBLY_GUIDE]) {
      for (const c of TEMPLATE_HARD_CONSTRAINTS) {
        expect(guide).toContain(c.text);
      }
      expect(guide).toContain("kg-change-report"); // kg-change-report 场景目录也携带
    }
  });
});
