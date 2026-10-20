/**
 * input-pipeline —— 光球「左侧输入流水」纯函数面（光球分区批，用户裁决：
 * 上方气泡=管家输出，左侧=用户输入流水——拟输入不与管家输出混排）。
 *
 * 每句用户输入一行，行随判定链推进色态（用户裁决的呈现顺序）：
 *   hearing（灰，interim 实时解析）→ confirmed（白，确认输入）→
 *   done（主题成功色，短暂驻留后消失）/ failed（主题错误色，短暂驻留后消失）
 *   / rejected（警示色 + 闸门注记行：声纹未过带相似度与阈值 / 非交流意图）。
 *
 * 短驻语义与字幕批同族（气泡短驻少历史）：行随事件推进刷新 at，终态行
 * INPUT_TERMINAL_TTL 后驱逐，全行 INPUT_ROW_TTL 硬上限（长流程残行不积压）。
 */

export type InputRowState = "hearing" | "confirmed" | "done" | "failed" | "rejected";

export type InputNote =
  | { readonly kind: "voiceprint-reject"; readonly pct: number; readonly th: number }
  | { readonly kind: "judge-reject" }
  | { readonly kind: "asr-fail" };

export interface InputRow {
  readonly id: number;
  readonly text: string;
  readonly state: InputRowState;
  readonly note: InputNote | null;
  /** 最后更新时刻（epoch ms）——TTL 驱逐判据；行推进刷新。 */
  readonly at: number;
}

/** 行数上限（输入流水只显当前发生——超上限截头保最新）。 */
export const INPUT_MAX_ROWS = 3;

/** 终态行驻留（ms）：done/failed/rejected 短驻后消失（成功绿/失败红「闪色即走」）。 */
export const INPUT_TERMINAL_TTL = 2_500;

/** 全行硬上限（ms）：hearing/confirmed 残行不积压（长流程/丢弃句兜底驱逐）。 */
export const INPUT_ROW_TTL = 6_000;

const TERMINAL: readonly InputRowState[] = ["done", "failed", "rejected"];

let rowSeq = 0;

function trim(rows: readonly InputRow[]): InputRow[] {
  return rows.length > INPUT_MAX_ROWS ? rows.slice(rows.length - INPUT_MAX_ROWS) : [...rows];
}

/** interim 实时解析：hearing 尾行原位换文本（id 稳定）；否则追加 hearing 行。 */
export function inputHearing(rows: readonly InputRow[], text: string, at: number = Date.now()): InputRow[] {
  if (text === "") return [...rows];
  const tail = rows[rows.length - 1];
  if (tail !== undefined && tail.state === "hearing") {
    return [...rows.slice(0, -1), { ...tail, text, at }];
  }
  rowSeq += 1;
  return trim([...rows, { id: rowSeq, text, state: "hearing", note: null, at }]);
}

/** 确认输入（ASR final 定稿）：hearing 尾行转正换文本（同句同行），否则追加。
 *  需要行身份的调用面（异步门后定向标记）用 inputConfirmWithId。 */
export function inputConfirm(rows: readonly InputRow[], text: string, at: number = Date.now()): InputRow[] {
  return inputConfirmWithId(rows, text, at).rows;
}

/** 确认输入 + 行 id（异步判定窗口内新句可入列抢占尾位——终态必须按
 *  id 定向标记，禁依赖「尾行」隐式约定）。 */
export function inputConfirmWithId(
  rows: readonly InputRow[],
  text: string,
  at: number = Date.now(),
): { readonly rows: InputRow[]; readonly id: number } {
  const tail = rows[rows.length - 1];
  if (tail !== undefined && tail.state === "hearing") {
    return { rows: [...rows.slice(0, -1), { ...tail, text, state: "confirmed", at }], id: tail.id };
  }
  rowSeq += 1;
  return { rows: trim([...rows, { id: rowSeq, text, state: "confirmed", note: null, at }]), id: rowSeq };
}

/** 行终态推进：done / failed / rejected（带闸门注记）。targetId 缺省 = 尾行
 *  （同步判定链）；异步判定链必传 id（尾位可能已被后到新句占走）。 */
export function inputResolve(
  rows: readonly InputRow[],
  outcome: { readonly state: "done" | "failed" | "rejected"; readonly note?: InputNote },
  at: number = Date.now(),
  targetId?: number,
): InputRow[] {
  const index = targetId === undefined ? rows.length - 1 : rows.findIndex((r) => r.id === targetId);
  if (index < 0 || index >= rows.length) return [...rows];
  const target = rows[index]!;
  const next = [...rows];
  next[index] = { ...target, state: outcome.state, note: outcome.note ?? target.note, at };
  return next;
}

/** 闸门异步回判（judge dropped 在 dispatch 之后才回执）：最近可判行翻 rejected
 *  带注记——**优先序 done > confirmed**（刚发问那行已 done；旧实现单一倒序扫
 *  首个 done|confirmed，注释承诺的 done 优先并不成立：中间夹一条 confirmed 时
 *  会先命中它）；无可判行补注记行（text 空串是有意形态：异步回执可能先于输入
 *  行到达，渲染面只呈现注记、随 TTL 自行消失）。 */
export function inputAnnotate(rows: readonly InputRow[], note: InputNote, at: number = Date.now()): InputRow[] {
  // ① done 优先（刚完成的那问）；② 退 confirmed（已确认未完成）
  for (const preferred of ["done", "confirmed"] as const) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i]!;
      if (r.state !== preferred) continue;
      const next = [...rows];
      next[i] = { ...r, state: "rejected", note, at };
      return next;
    }
  }
  rowSeq += 1;
  return trim([...rows, { id: rowSeq, text: "", state: "rejected", note, at }]);
}

/** TTL 驱逐：终态行超 INPUT_TERMINAL_TTL、全行超 INPUT_ROW_TTL 即移除；
 *  无变化原引用短路（无谓重渲染零）。 */
export function inputEvict(rows: readonly InputRow[], now: number = Date.now()): readonly InputRow[] {
  const next = rows.filter((r) => {
    const ttl = TERMINAL.includes(r.state) ? INPUT_TERMINAL_TTL : INPUT_ROW_TTL;
    return now - r.at <= ttl;
  });
  return next.length === rows.length ? rows : next;
}
