/**
 * stewardSnapshots —— 管家情景快照面（体量门 P4：自 StewardService 原样迁出）。
 *
 * 内容：时间档窗口纯函数族（TimeRange/timeRangeWindow/fmtWhen——query_recent_work
 * 工具参数消费）与 <context_snapshot> 段行文组装（buildContextSnapshot——
 * 生命周期域每 run 装配时消费）。全部纯函数/无状态，导出供单测断言。
 *
 * 门面 StewardService.ts 精确再导出——消费方 import 路径与符号零变化。
 */
import {
  CONTEXT_SNAPSHOT_MAX_CHARS,
  SNAPSHOT_ACTIVITY_DOMAIN_LABELS,
  SNAPSHOT_ACTIVITY_LINE_MAX_CHARS,
  SNAPSHOT_ACTIVITY_MAX_CHARS,
  SNAPSHOT_ACTIVITY_MAX_ENTRIES,
  SNAPSHOT_RECENT_SESSIONS,
  SNAPSHOT_TITLE_MAX_CHARS,
} from "./stewardConstants";
import { capChars } from "./stewardProjections";

/** ── A2：时间档窗口（本地时区；纯函数导出供单测） ───────── */
export type TimeRange = "today" | "yesterday" | "this_week" | "last_week";

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  today: "今天",
  yesterday: "昨天",
  this_week: "本周",
  last_week: "上周",
};

/** 本地时区某时刻的当日零点。 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地时区所在周的周一零点（ISO 周：周一为首日）。 */
function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const day = d.getDay(); // 0=周日
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d.getTime();
}

/** 时间档 → [since, until) 毫秒窗口（today/this_week 右端 = now 开区间上含；
 *  label = 枚举原文（LLM 参数面机械口径），中文展示标签见 zhLabel）。 */
export function timeRangeWindow(range: TimeRange, nowMs: number): { sinceMs: number; untilMs: number; label: string; zhLabel: string } {
  const today0 = startOfDay(nowMs);
  const thisWeek0 = startOfWeek(nowMs);
  switch (range) {
    case "today":
      return { sinceMs: today0, untilMs: nowMs, label: "today", zhLabel: TIME_RANGE_LABELS.today };
    case "yesterday":
      return { sinceMs: today0 - 86_400_000, untilMs: today0, label: "yesterday", zhLabel: TIME_RANGE_LABELS.yesterday };
    case "this_week":
      return { sinceMs: thisWeek0, untilMs: nowMs, label: "this_week", zhLabel: TIME_RANGE_LABELS.this_week };
    case "last_week":
      return { sinceMs: thisWeek0 - 7 * 86_400_000, untilMs: thisWeek0, label: "last_week", zhLabel: TIME_RANGE_LABELS.last_week };
  }
}

/** 查询行时间格式化（MM-DD HH:mm；纯函数）。 */
export function fmtWhen(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "?";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 快照段行文（纯函数导出供单测）：<context_snapshot> XML 包裹的情景快照。
 *  行序：当前时间 → 活跃 agent → 会话计数 → 最近 1-2 个会话主题 →
 *  （M3-d1）最近活动白话行。硬预算：基础段与活动段双预算分轨截断
 *  （CONTEXT_SNAPSHOT_MAX_CHARS / SNAPSHOT_ACTIVITY_MAX_CHARS——防御性
 *  截断互不挤占；活动段缺席 = 与既有形态逐字节同形）。 */
export function buildContextSnapshot(input: {
  nowMs: number;
  activeAgents: number;
  totalAgents: number;
  sessionCount: number;
  recentSessions: readonly { title: string; updatedAt: string }[];
  /** M3-d1：最近活动条目（活动账白话行——最旧→最新；缺席/空 = 零活动段）。 */
  recentActivity?: readonly { at: number; domain: string; attribution: string; text: string }[];
}): string {
  const now = new Date(input.nowMs);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const lines: string[] = [
    `当前时间：${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}（${WEEKDAY_NAMES[now.getDay()]}）${p2(now.getHours())}:${p2(now.getMinutes())}`,
    `活跃 agent：${input.activeAgents}${input.totalAgents > input.activeAgents ? `（在册 ${input.totalAgents}）` : ""}`,
    `会话：${input.sessionCount} 个`,
  ];
  const recent = input.recentSessions.slice(0, SNAPSHOT_RECENT_SESSIONS);
  if (recent.length > 0) {
    lines.push(
      `最近会话：${recent.map((s) => `「${capChars(s.title, SNAPSHOT_TITLE_MAX_CHARS)}」（${fmtWhen(s.updatedAt).slice(0, 5)}）`).join("、")}`,
    );
  }
  const budget = CONTEXT_SNAPSHOT_MAX_CHARS - "<context_snapshot>\n".length - "</context_snapshot>".length;
  let body = capChars(lines.join("\n"), budget);
  // M3-d1：活动段（独立预算——感知现场投影，失败/缺席零段）
  const activity = input.recentActivity ?? [];
  if (activity.length > 0) {
    const activityLines = [
      "最近的活动：",
      ...activity.slice(-SNAPSHOT_ACTIVITY_MAX_ENTRIES).map((e) => {
        const label = SNAPSHOT_ACTIVITY_DOMAIN_LABELS[e.domain] ?? "动态";
        return `- ${label}：${capChars(e.text, SNAPSHOT_ACTIVITY_LINE_MAX_CHARS)}`;
      }),
    ];
    body = `${body}\n${capChars(activityLines.join("\n"), SNAPSHOT_ACTIVITY_MAX_CHARS)}`;
  }
  return `<context_snapshot>\n${body}\n</context_snapshot>`;
}
