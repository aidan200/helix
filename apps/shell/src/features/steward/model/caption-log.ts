/**
 * caption-log —— 管家字幕行聚合纯函数面（B2 全局语音批；StewardCaption
 * 数据面，设计稿 §3.2。短驻批（用户裁决 2026-10）：气泡只在事件发生期可见
 * ——行栈上限 2（最新问答对）+ TTL 驻留（静置超时自动移除），不再整场双工
 * 常驻历史）。
 *
 * 行模型：kind 弱区分用户（ASR final）/管家（ask.delta 聚合）；id 渲染 key
 * 单调；at = 最后更新时刻（入栈与流式原位更新都刷新——流进行中途不过期）。
 * 管家流进行 in-place 更新（同一轮 delta 聚合不涨行——captionUpdateTail 只
 * 动末尾同 kind 行）。interim 浮字不入栈（呈现层实时消费，零历史）。
 */

/** 字幕行（kind 弱区分用户/管家/note；id 渲染 key 单调）。note = 闸门略过
 *  行（dropped 反馈——闸门对应修复批）：非对话内容的淡行，零播报，TTL 同栈。 */
export interface CaptionLine {
  readonly id: number;
  readonly kind: "user" | "steward" | "note";
  readonly text: string;
  /** 最后更新时刻（epoch ms）：TTL 驻留判据；流式 in-place 更新刷新。 */
  readonly at: number;
}

/** 行数上限（短驻批 2：最新一问一答；原 4 行——用户裁决历史过多）。 */
export const CAPTION_MAX_LINES = 2;

/** 行驻留时长（ms）：静置超此值自动移除（短驻批——气泡只在事件发生期可见）。 */
export const CAPTION_TTL_MS = 6_000;

/** TTL 驱逐 tick 粒度（ms；呈现层 interval——驱逐时刻误差 ≤ 一拍）。 */
export const CAPTION_EVICT_TICK_MS = 500;

let lineSeq = 0;

/** 行入栈：追加保最新在下，超上限截头；at 记入栈时刻（可注入——纯函数可测）。 */
export function captionPush(
  lines: readonly CaptionLine[],
  kind: CaptionLine["kind"],
  text: string,
  max: number = CAPTION_MAX_LINES,
  at: number = Date.now(),
): CaptionLine[] {
  if (text === "") return [...lines];
  lineSeq += 1;
  const next = [...lines, { id: lineSeq, kind, text, at }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 管家流进行更新：末尾同 kind 行原位换文本（id 不变——渲染 key 稳定）并
 *  刷新 at（流进行中途不过期——静置时钟重起）；末尾异 kind/空栈 → 追加
 *  （同 captionPush 上限语义）。 */
export function captionUpdateTail(
  lines: readonly CaptionLine[],
  kind: CaptionLine["kind"],
  text: string,
  max: number = CAPTION_MAX_LINES,
  at: number = Date.now(),
): CaptionLine[] {
  const tail = lines[lines.length - 1];
  if (tail !== undefined && tail.kind === kind) {
    if (text === "") return [...lines];
    return [...lines.slice(0, -1), { ...tail, text, at }];
  }
  return captionPush(lines, kind, text, max, at);
}

/** TTL 驱逐：静置（now - at ≥ ttl）整行移除（到期一批全移）；无淘汰返回
 *  原引用（setState 恒等短路——呈现层 tick 空转零重渲）。 */
export function captionEvict(
  lines: readonly CaptionLine[],
  now: number,
  ttl: number = CAPTION_TTL_MS,
): readonly CaptionLine[] {
  const kept = lines.filter((l) => now - l.at < ttl);
  return kept.length === lines.length ? lines : kept;
}
