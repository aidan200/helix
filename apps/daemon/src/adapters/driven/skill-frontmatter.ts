import { parse as parseYaml } from "yaml";

/**
 * SKILL.md frontmatter 解析单点（adapters/driven 共享纯函数，低危批上收）。
 *
 * 三处同型实现曾各自维护此逻辑（SkillScanner.readCompanionTools /
 * SkillScanner.createSkill / TaskSkillRegistry.readFrontmatter），闭合定界符
 * 判定与 CRLF 归一重复三份，且其中两份用宽松 `indexOf("\n---")` 前缀匹配——
 * 以 "---" 开头的顶格行（"----" 分隔线、"---foo"）会被误判为闭合，把 YAML
 * 截断在非法行之前（坏形状静默回落吞掉损坏信号）。本单点只保留行级精确判定。
 *
 * 闭合标记判定（本模块的契约，改动前先看）：单独一行**恰为** `---`（容行尾
 * 空白 [ \t]*，其后必须是换行或文件尾）；`----`/`---foo` 不是闭合行。宽松实现
 * 的代价见上（pi loadSourcedSkills 的 parseFrontmatter 即宽松版，不可复用）。
 *
 * 纯函数、零 IO：调用方自己读文件（各调用点的读取失败语义/诊断文案不同）。
 */

/** 解析结果三态：无 frontmatter / YAML 或形状非法（带原因文案）/ 映射形状。 */
export type SkillFrontmatter =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "present"; readonly value: Record<string, unknown> };

/** 开头定界符：文件首行恰为 `---`（容行尾空白）。 */
const OPEN_RE = /^---[ \t]*\n/;

/** 闭合定界符：单独一行恰为 `---`（容行尾空白；其后为换行或文件尾）。 */
const CLOSE_RE = /\n---[ \t]*(?=\n|$)/;

/**
 * 解析 SKILL.md 全文的 frontmatter（YAML 映射）。
 *
 * CRLF 归一 → 开头定界符 → 行级精确闭合定位 → YAML 解析。无 frontmatter 与
 * 非法形状分开返回，让调用方决定「静默回落」还是「出诊断」（两处消费口径
 * 不同：技能增强声明静默，任务 manifest 装载出 warning）。
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const normalized = raw.replace(/\r\n/g, "\n");
  const open = OPEN_RE.exec(normalized);
  if (open === null) return { kind: "absent" };
  const close = CLOSE_RE.exec(normalized);
  if (close === null) return { kind: "absent" };
  const body = normalized.slice(open[0].length, close.index);
  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch (error) {
    return { kind: "invalid", reason: `YAML 解析失败：${String(error)}` };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return { kind: "present", value: parsed as Record<string, unknown> };
  }
  return { kind: "invalid", reason: `非映射形状（解析得到 ${typeof parsed}）` };
}
