/**
 * 常驻规则索引渲染（global 声明节点 → 系统提示触发面段）。
 *
 * 设计口径（用户裁决 2026-09-10）：
 * - 只渲染「名称 + 适用场景 + kg get 指针」——不渲染 digest/正文全文，
 *   LLM 命中场景后主动 kg get 读全文（scene 是触达核心）；
 * - 注入范围 = 当前项目 anchor_decl 里 scope_kind='global' 的节点（项目规则，
 *   非跨项目混合）；无图谱项目空集 → 整段省略（零注入痕迹，AD-18 空段不占位）。
 */

/** 常驻规则条目行：节点触发面最小集（id/kind/name/scene）+ 所属项目。 */
export interface ResidentRuleRow {
  readonly project: string;
  readonly row: {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly scene: string;
  };
}

/** 渲染参数：多项目标记（单项目时指针行不带项目尾注，与切片同构）。 */
export interface ResidentRulesRenderOptions {
  readonly multiProject: boolean;
}

/** 段标题行。 */
export const RESIDENT_RULES_HEADER = "项目常驻规则（kg 触发面索引）";

/** 条目上限：治理规则索引面，超限截断（确定性：id 序，调用方排序）。 */
export const MAX_RESIDENT_RULES = 16;

/** 单条 scene 截断长度（超长截断加省略号——触发面一行可扫）。 */
export const RESIDENT_SCENE_MAX_CHARS = 120;

/**
 * 渲染常驻规则段；空集返回 null（段整体省略——调用方不拼接）。
 * 结构：标题行 + 两句引导语 + 逐条「粗体 name + kind 徽章 + 适用：scene + 指针」。
 * scene 为空的条目跳过（无触达价值，不产出无场景行）。
 */
export function renderResidentRules(
  rows: readonly ResidentRuleRow[],
  options: ResidentRulesRenderOptions,
): string | null {
  const entries: string[] = [];
  for (const c of rows) {
    if (entries.length >= MAX_RESIDENT_RULES) break;
    const scene = c.row.scene.trim();
    if (scene === "") continue;
    const pointer = options.multiProject
      ? `kg get ${c.row.id}（project: ${projectNameOf(c.project)}）`
      : `kg get ${c.row.id}`;
    entries.push(
      `- **${c.row.name}** [${c.row.kind}] ${c.row.id}\n  适用：${truncateScene(scene)}\n  ↳ ${pointer}`,
    );
  }
  if (entries.length === 0) return null;
  return [
    RESIDENT_RULES_HEADER + "：",
    "以下规则在当前项目全局适用——此处仅列名称与适用场景，不含全文。",
    "当你的任务与某条的适用场景匹配时，先用 kg 工具读取该节点全文后再动手（不要凭标题猜测规则内容）。",
    ...entries,
  ].join("\n");
}

/** 单行折行防御 + 超长截断（scene 理论单行，frontmatter/多行防御同 foldToSingleLine）。 */
function truncateScene(value: string): string {
  const single = value.replace(/\r?\n/g, " ").trim();
  return single.length > RESIDENT_SCENE_MAX_CHARS
    ? single.slice(0, RESIDENT_SCENE_MAX_CHARS) + "…"
    : single;
}

/** projectRoot 尾段即项目名（与 task-slice 同口径）。 */
function projectNameOf(projectRoot: string): string {
  const parts = projectRoot.split("/");
  return parts[parts.length - 1] || projectRoot;
}
