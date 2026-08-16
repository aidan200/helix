/**
 * 展示格式化（desk shared/lib/format.ts 的 P-1 子集）。
 */

/** epoch 毫秒 → 时间戳（格式串仅支持 "HH:mm"，i18n chat.tsFormat）。 */
export function formatTs(ts: number, pattern = "HH:mm"): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return pattern.replace("HH", hh).replace("mm", mm);
}

/** 毫秒 → "0.3s" 风格耗时展示。 */
export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** token 档位格式化（F3.3 统计徽标；T4.2 消费）：≥1M 一位小数 M；≥1k 取整 k；否则原值。 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** epoch 毫秒 → 相对时间（P-2 会话卡片）：刚刚 / N 分钟前 / N 小时前 /
 *  昨天 / N 天前（文案 key 由调用方 i18n，本函数只定档位与参数）。
 *  now 由调用方注入（重放确定性；组件传 Date.now()）。 */
export function relativeTimeSpan(
  fromMs: number,
  nowMs: number,
): { key: "justNow" | "minutes" | "hours" | "yesterday" | "days"; n: number } {
  const diff = Math.max(0, nowMs - fromMs);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return { key: "justNow", n: 0 };
  if (minutes < 60) return { key: "minutes", n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: "hours", n: hours };
  const days = Math.floor(hours / 24);
  if (days === 1) return { key: "yesterday", n: 1 };
  return { key: "days", n: days };
}

/** 工具参数 JSON 字符串 → 展开后的 pretty JSON（解析失败回退原文）。 */
export function prettyJsonArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/** 从工具结果文本提取 exit code（无结构化字段的启发式；失败回退 1）。
 * 兼容两种文案：pi bash 真实错误「Command exited with code N」与
 * mock/通用「... exit N」（含「process exited with exit 1」）。 */
export function extractExitCode(result: string): string {
  return /exited with code (\d+)/.exec(result)?.[1] ?? /exit (\d+)/.exec(result)?.[1] ?? "1";
}
