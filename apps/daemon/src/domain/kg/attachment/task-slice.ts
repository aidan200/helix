/**
 * 任务层切片注入的选择与渲染（T3.3，CL-1 F1.3，F-14）。
 *
 * spawn 派发时任务文本命中的知识节点 → digest+指针切片：候选（标识符
 * 检索命中行，project 伴随）→ 排除（会话已到达 id / superseded）→
 * token 硬顶贪心（与附着同预算纪律：估算 = 渲染字符数 / 4）→ 渲染
 * （digest+指针形态，AD-3/AD-16；协议行复用附着同源常量，AD-14）。
 *
 * 纯函数、零 IO（TR-AD-1）；不改变调用方传入的排除集。
 */

import type { NodeDigestRow } from "../types";
import { ATTACHMENT_PROTOCOL_LINE } from "./render";
import { extractIdentifiers } from "./identifier-extract";

/** 切片总 token 硬顶（同预算纪律：与 ATTACHMENT_TOKEN_BUDGET 同值起步）。 */
export const TASK_SLICE_TOKEN_BUDGET = 800;

/** 切片段标题行（brief 契约逐字符；AD-18 空命中整段省略不占位）。 */
export const TASK_SLICE_HEADER = "## kg 约束切片";

/**
 * 任务文本词条提取（F1.3）：ASCII 标识符（extractIdentifiers 同源——
 * camelCase/snake_case 双产出，长度≥3 非保留字）∪ 中文词元
 * （Intl.Segmenter ICU 分词，isWordLike 且长度≥2——单字噪声不产）。
 * 纯确定性，无 embedding（F-6）。任务文本是自然语言（非代码），
 * 中文词条面是标识符面的必要补充（节点名/digest 以中文为主）。
 */
export function extractTaskTerms(taskText: string): string[] {
  const terms = new Set<string>(extractIdentifiers(taskText, ""));
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    for (const part of segmenter.segment(taskText)) {
      if (part.isWordLike === true && part.segment.length >= 2) {
        terms.add(part.segment);
      }
    }
  }
  return [...terms]; // Set 插入序 = 任务文本出现序（确定性）
}

/** 切片候选行：命中节点摘要 + 所属项目（多项目时指针行携带项目名）。 */
export interface TaskSliceRow {
  readonly project: string;
  readonly row: NodeDigestRow;
}

/** 渲染参数：多项目标记（单项目时指针行不带项目尾注，保持简洁）。 */
export interface TaskSliceRenderOptions {
  readonly multiProject: boolean;
}

/** 单节点条目：粗体 name + kind 徽章 + digest + kg get 指针（与附着条目同构）。 */
function renderEntry(candidate: TaskSliceRow, multiProject: boolean): string {
  const { row } = candidate;
  const pointer = multiProject
    ? `kg get ${row.id}（project: ${projectNameOf(candidate.project)}）`
    : `kg get ${row.id}`;
  return `- **${row.name}** [${row.kind}] — ${row.digest}\n  ↳ ${pointer}`;
}

/** projectRoot 尾段即项目名（workspace 一级目录名；AD-16 项目名可见文本不受限）。 */
function projectNameOf(projectRoot: string): string {
  const parts = projectRoot.split("/");
  return parts[parts.length - 1] || projectRoot;
}

/**
 * 渲染切片段；空候选返回 ''（空命中整段省略——调用方不拼接）。
 * 结构：标题行 + digest+指针行们 + 协议行（AD-14 同源常量）。
 */
export function renderTaskSlice(
  rows: readonly TaskSliceRow[],
  options: TaskSliceRenderOptions,
): string {
  if (rows.length === 0) return "";
  return [
    TASK_SLICE_HEADER,
    ...rows.map((c) => renderEntry(c, options.multiProject)),
    ATTACHMENT_PROTOCOL_LINE,
  ].join("\n");
}

/** 切片段字符数（预算估算口径与渲染同源：token 估算 = 渲染字符数 / 4）。 */
export function taskSliceChars(rows: readonly TaskSliceRow[], options: TaskSliceRenderOptions): number {
  return renderTaskSlice(rows, options).length;
}

/**
 * 切片选择：排除（会话已到达裸 id / superseded）→ 去重（project+id 首见
 * 保留）→ token 硬顶贪心装入（候选序保持调用方确定性顺序——任务文本
 * 标识符出现序 + 项目序 + id 序）。超限项让位，不回填。
 */
export function selectTaskSlice(
  candidates: readonly TaskSliceRow[],
  excludeIds: ReadonlySet<string>,
  options: TaskSliceRenderOptions,
): TaskSliceRow[] {
  const seenKeys = new Set<string>();
  const unique: TaskSliceRow[] = [];
  for (const c of candidates) {
    if (excludeIds.has(c.row.id)) continue; // 会话已到达（跨通道注册表，F1.2）
    if (c.row.status === "superseded") continue; // 被推翻知识不作约束注入
    const key = `${c.project}\u0000${c.row.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(c);
  }
  const picked: TaskSliceRow[] = [];
  for (const c of unique) {
    if (taskSliceChars([...picked, c], options) / 4 <= TASK_SLICE_TOKEN_BUDGET) {
      picked.push(c);
    }
  }
  return picked;
}
