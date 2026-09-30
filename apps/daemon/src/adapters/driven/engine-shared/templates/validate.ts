/**
 * 模板硬约束机械校验（architecture.md §7，AD-18；CL-1.A10 / CL-3.A5 机械化）。
 *
 * 分界（AD-18）：校验函数只判三类机械规则——brief 三要素 / report
 * summary+findings 显式「无」/ 空段省略不占位；**不判段内容质量**
 * （质量归验证期人审，AD-6）。机械判据是后续 plan_mark_done 闭环检查
 * 的参考输入，不改造闭环协议本身。
 *
 * 判据可测等价定义（在段库校验单测固化）：
 * - 段存在性 = ATX 标题行（`## 段名`）+ 该标题下有非空内容；标题别名按
 *   源文档实际用词收窄枚举（「范围钳制/范围锥制」拼写变体同判）；
 * - 空段 = 二级及以下标题的正文区（到下一个同级或更浅标题前）全空白，
 *   或正文仅由「（无内容）/待补充」类占位行构成——与 brief 给出的参考
 *   正则 `^## .+\n(\s*$|\n#)` 等价，并修正了嵌套子段（## 下 ### 有
 *   内容）与一级题名（文档标题非段）两类误报；
 * - findings 显式「无」= 段存在且正文非空非占位（「无」「无发现」等
 *   均合法）；段缺失 / 正文空白 / 占位 = violation。
 *
 * 纯函数、零 IO（TR-AD-1）。
 */

/** 单条违例：rule 稳定标识（测试/日志消费）+ message 人类可读描述。 */
export interface Violation {
  readonly rule: string;
  readonly message: string;
}

/** 解析后的段：标题级别 + 标题文本 + 正文区（到下一个同级或更浅标题前）。 */
interface Section {
  readonly level: number;
  readonly title: string;
  readonly body: string;
}

/** ATX 标题行（#{1,6} + 空白 + 标题文本；行尾空白容忍）。 */
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)\s*$/gm;

/** 解析全部段：正文区取到下一个**同级或更浅**标题前（更深的子标题属本段内容）。 */
function parseSections(text: string): Section[] {
  const heads = [...text.matchAll(HEADING_RE)].map((m) => ({
    level: m[1]!.length,
    title: m[2]!.trim(),
    headStart: m.index ?? 0,
    headEnd: (m.index ?? 0) + m[0].length,
  }));
  return heads.map((h, i) => {
    let end = text.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j]!.level <= h.level) {
        end = heads[j]!.headStart;
        break;
      }
    }
    return { level: h.level, title: h.title, body: text.slice(h.headEnd, end) };
  });
}

/** 硬约束①三要素标题判据（源文档实际用词的收窄枚举，非模糊包含）。 */
const TASK_GOAL_TITLE_RE = /目标/; // 任务目标（brief 段库标准标题）
const SCOPE_CLAMP_TITLE_RE = /范围[钳锥]制/; // 钳制/锥制：源文档拼写变体并存
const COMPLETION_TITLE_RE = /完成判定|完成标准|验收/; // 要素「完成判定」的载体段标题

/** 硬约束② report 必含段标题判据。 */
const SUMMARY_TITLE_RE = /summary|结论|摘要/i;
const FINDINGS_TITLE_RE = /findings|发现/i;

/** 「（无内容）」类占位行（硬约束③；「无」/「（无）」不在其列——那是显式「无」约定）。 */
const PLACEHOLDER_LINE_RE =
  /^[（(【「\[\s*>-]*(?:无内容|暂无|待补充|待定|TBD|N\/A|n\/a|占位)[。）)」\]\s。]*$/;

/** 占位段判据：正文所有非空行均为占位行。 */
function isPlaceholderBody(body: string): boolean {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.length > 0 && lines.every((l) => PLACEHOLDER_LINE_RE.test(l));
}

/** 要素在 = 存在标题命中的段且正文非空（空壳标题不算要素交付）。 */
function hasElement(sections: readonly Section[], titleRe: RegExp): boolean {
  return sections.some((s) => titleRe.test(s.title) && s.body.trim() !== "");
}

/**
 * 硬约束①：brief 必含「任务目标+范围钳制+完成判定」三要素（CL-1.A10）。
 * 缺失各自精确指认（rule 逐一对应），不判段内容质量。
 */
export function validateBrief(brief: string): Violation[] {
  const sections = parseSections(brief);
  const violations: Violation[] = [];
  if (!hasElement(sections, TASK_GOAL_TITLE_RE)) {
    violations.push({
      rule: "brief.missing-task-goal",
      message: "brief 缺「任务目标」要素：无标题含「目标」且内容非空的段（硬约束①三要素之一）",
    });
  }
  if (!hasElement(sections, SCOPE_CLAMP_TITLE_RE)) {
    violations.push({
      rule: "brief.missing-scope-clamp",
      message: "brief 缺「范围钳制」要素：无标题含「范围钳制/范围锥制」且内容非空的段（硬约束①三要素之二）",
    });
  }
  if (!hasElement(sections, COMPLETION_TITLE_RE)) {
    violations.push({
      rule: "brief.missing-completion-criteria",
      message:
        "brief 缺「完成判定」要素：无标题含「完成标准/完成判定/验收」且内容非空的段（硬约束①三要素之三）",
    });
  }
  return violations;
}

/**
 * 硬约束②：report 必含 summary+findings，findings 空必须显式「无」（CL-3.A5）。
 * findings 正文非空且非占位即合法（实质内容或显式「无」均可）；缺失/空白/占位 = violation。
 */
export function validateReport(report: string): Violation[] {
  const sections = parseSections(report);
  const violations: Violation[] = [];

  // M19：判据从 sections.find 首个命中改 hasElement/some 语义（对齐 validateBrief）——
  // 同名段多现时首个空壳不误报，任一同名段有非空内容即要素在
  if (!hasElement(sections, SUMMARY_TITLE_RE)) {
    violations.push({
      rule: "report.missing-summary",
      message: "report 缺「summary」要素：无标题含 summary/结论/摘要 且内容非空的段（硬约束②）",
    });
  }

  const findingsSections = sections.filter((s) => FINDINGS_TITLE_RE.test(s.title));
  if (findingsSections.length === 0) {
    violations.push({
      rule: "report.missing-findings",
      message: "report 缺「findings」段（硬约束②：findings 是闭环判定与知识落账的输入，不可缺失）",
    });
  } else if (!findingsSections.some((s) => s.body.trim() !== "" && !isPlaceholderBody(s.body))) {
    violations.push({
      rule: "report.findings-not-explicit-none",
      message: "findings 段为空或占位：无发现必须显式写「无」（显式「无」原则，AD-14）",
    });
  }
  return violations;
}

/**
 * 硬约束③：空段省略不占位。一级标题（文档题名）不作段判；二级及以下
 * 段正文全空白或仅占位行 = violation。findings 段显式「无」是合法内容，
 * 不在此违例（硬约束②的例外通道）。
 */
export function checkEmptySectionOmission(text: string): Violation[] {
  const violations: Violation[] = [];
  for (const s of parseSections(text)) {
    if (s.level < 2) continue; // 一级标题 = 文档题名，非段
    if (s.body.trim() === "") {
      violations.push({
        rule: "template.empty-section",
        message: `「${s.title}」段内容为空——空段必须整段省略，不得保留标题占位（硬约束③）`,
      });
    } else if (isPlaceholderBody(s.body)) {
      violations.push({
        rule: "template.placeholder-section",
        message: `「${s.title}」段为占位文本——空段必须整段省略，不得输出「（无内容）/待补充」类占位行（硬约束③）`,
      });
    }
  }
  return violations;
}
