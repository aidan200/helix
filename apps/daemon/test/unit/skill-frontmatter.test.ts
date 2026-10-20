import { describe, expect, test } from "bun:test";
import { parseSkillFrontmatter } from "../../src/adapters/driven/skill-frontmatter";

/**
 * SKILL.md frontmatter 解析单点（低危批上收）：
 * 三处同型消费（SkillScanner.readCompanionTools / SkillScanner.createSkill /
 * TaskSkillRegistry.readFrontmatter）曾各自维护一份解析——本条把闭合定界符
 * 判定与 CRLF 归一收到单点，并修掉宽松前缀匹配（"----"/"---foo" 被当闭合线）
 * 与「三份各自漂移」两个问题。
 */

const frontmatter = (yaml: string, body = "正文"): string => `---\n${yaml}\n---\n\n${body}\n`;

describe("parseSkillFrontmatter（单点解析）", () => {
  test("① 正常 frontmatter → present（映射形状）", () => {
    const out = parseSkillFrontmatter(frontmatter("name: demo\ntools:\n  - read"));
    expect(out).toEqual({ kind: "present", value: { name: "demo", tools: ["read"] } });
  });

  test("② 无 frontmatter（不以 --- 开头）→ absent", () => {
    expect(parseSkillFrontmatter("# 无头注\n正文")).toEqual({ kind: "absent" });
  });

  test("③ 有开头无闭合 → absent（不吞正文当 YAML）", () => {
    expect(parseSkillFrontmatter("---\nname: x\n正文无闭合")).toEqual({ kind: "absent" });
  });

  test("④ 闭合行带行尾空白 → present（容 [ \\t]*）", () => {
    const out = parseSkillFrontmatter("---\nname: x\n---  \n\n正文\n");
    expect(out).toEqual({ kind: "present", value: { name: "x" } });
  });

  test("⑤ 顶格 ---- / ---foo 不是闭合行：正文分隔线不干扰闭合定位", () => {
    const raw = frontmatter("name: x", "----\n---foo\n正文第一段");
    expect(parseSkillFrontmatter(raw)).toEqual({ kind: "present", value: { name: "x" } });
  });

  test("⑥ frontmatter 内顶格 ---- 行（笔误）→ 不歪打正着截断：YAML 非法诚实暴露 invalid", () => {
    const out = parseSkillFrontmatter("---\nname: x\n----\n---\n\n正文\n");
    expect(out.kind).toBe("invalid");
    if (out.kind === "invalid") expect(out.reason).toContain("YAML 解析失败");
  });

  test("⑦ CRLF 文件 → 归一同判 present", () => {
    const out = parseSkillFrontmatter("---\r\nname: crlf\r\n---\r\n\r\n正文\r\n");
    expect(out).toEqual({ kind: "present", value: { name: "crlf" } });
  });

  test("⑧ YAML 是标量/数组（非映射）→ invalid（reason 指明形状）", () => {
    const out = parseSkillFrontmatter("---\n- a\n- b\n---\n正文");
    expect(out.kind).toBe("invalid");
    if (out.kind === "invalid") expect(out.reason).toContain("非映射形状");
  });
});
