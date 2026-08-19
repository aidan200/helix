/**
 * P-1 TracePage 展示格式化（组件层纯函数；原型 P-1-trace.html fmtTime/
 * fmtClock/fmtDur/fmtNum/timeLine 口径对齐）。
 *
 * 与 model/trace-model.ts 的分工：model 管状态与 fold（无展示格式），
 * 本文件管展示文本（时间/时长/计数/实例起止行）。
 */

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");

/** ISO → "HH:mm:ss.SSS"（事件行时间列；非法输入回退原文）。 */
export function fmtTimeMs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** ISO → "HH:mm:ss"（起止时刻 / 变更轨迹行 / instantiated 来源行）。 */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ms → "61s" / "1m05s" / "1h02m"（时长；原型 fmtDur 口径）。 */
export function fmtDur(ms: number): string {
  if (!(ms > 0)) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${pad(rs)}s`;
  const h = Math.floor(m / 60);
  return `${h}h${pad(m % 60)}m`;
}

/** 千分位计数（字数 / token / 事件数）。 */
export function fmtNum(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
