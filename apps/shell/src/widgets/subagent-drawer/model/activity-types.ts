/**
 * 活跃事件类型注册表（T5.5；task brief §4.1 用户裁决 Q1）：右侧活跃事件条
 * 的事件类型 → 呈现槽位（着色 token / 图标 / 标签词条）映射。
 *
 * 本期仅注册 subagent（violet，沿 SubAgent 卡 violet 签名）；结构预留未来
 * 类型（后台会话 / compaction / 引擎错误等）——注册即接入，YAGNI 不实现。
 *
 * 落位 widgets/subagent-drawer/model（事件条是本 widget 的呈现面；类型面
 * 随注册表扩展时再评估上提 shared）。
 */
import type { LucideIcon } from "lucide-react";
import { Bot } from "lucide-react";

/** 事件类型标识（注册表键）。 */
export type ActivityType = "subagent";

/** 类型呈现槽位：着色（data-color + tokens.css 注册色族）/ 图标 / i18n 标签键。 */
export interface ActivityTypeSpec {
  /** 着色槽位（对应 tokens.css 的 --{color} / --{color}-rgb 色族） */
  color: "violet";
  /** 展开态类型徽标图标（lucide 既有图标族） */
  icon: LucideIcon;
  /** i18n 标签键（chat.rail.type.*） */
  labelKey: "chat.rail.typeSubagent";
}

/** 类型注册表：新事件类型 = 在此注册一行（YAGNI：未接类型不注册）。 */
export const ACTIVITY_TYPES: Record<ActivityType, ActivityTypeSpec> = {
  subagent: { color: "violet", icon: Bot, labelKey: "chat.rail.typeSubagent" },
};
