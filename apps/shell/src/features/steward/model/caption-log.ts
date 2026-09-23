/**
 * caption-log —— 管家字幕行聚合纯函数面（B2 全局语音批；StewardCaption
 * 数据面，设计稿 §3.2）。
 *
 * 3-4 行堆叠渐隐最新在下（数组尾）超限截头；用户行（ASR final）与管家行
 * （ask.delta 聚合）弱区分（kind 字段）；管家流进行 in-place 更新（同一轮
 * delta 聚合不涨行——captionUpdateTail 只动末尾同 kind 行）。interim 浮字
 * 不入栈（呈现层实时消费，零历史）。
 */

/** 字幕行（kind 弱区分用户/管家；id 渲染 key 单调）。 */
export interface CaptionLine {
  readonly id: number;
  readonly kind: "user" | "steward";
  readonly text: string;
}

/** 行数上限（设计稿 §3.2：堆叠渐隐 3-4 行）。 */
export const CAPTION_MAX_LINES = 4;

let lineSeq = 0;

/** 行入栈：追加保最新在下，超上限截头。 */
export function captionPush(
  lines: readonly CaptionLine[],
  kind: CaptionLine["kind"],
  text: string,
  max: number = CAPTION_MAX_LINES,
): CaptionLine[] {
  if (text === "") return [...lines];
  lineSeq += 1;
  const next = [...lines, { id: lineSeq, kind, text }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 管家流进行更新：末尾同 kind 行原位换文本（id 不变——渲染 key 稳定），
 *  末尾异 kind/空栈 → 追加（同 captionPush 上限语义）。 */
export function captionUpdateTail(
  lines: readonly CaptionLine[],
  kind: CaptionLine["kind"],
  text: string,
  max: number = CAPTION_MAX_LINES,
): CaptionLine[] {
  const tail = lines[lines.length - 1];
  if (tail !== undefined && tail.kind === kind) {
    if (text === "") return [...lines];
    return [...lines.slice(0, -1), { ...tail, text }];
  }
  return captionPush(lines, kind, text, max);
}
