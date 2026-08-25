/**
 * supersede 状态机（domain/kg 纯函数，framework-free）。
 *
 * AD-14/AD-16：supersede 只翻 status 不换号——draft/confirmed → superseded
 * 是唯一迁移；superseded 是终态（id 永不回收、永不改写；再推翻走
 * replacement 新号链）。落库侧（sqlite-kg）在事务内消费本函数判定。
 */
import type { NodeStatus } from "./types";

/** 迁移判定：合法 → 下一态 superseded；非法（终态再翻）→ ok:false 附当前态。 */
export function supersedeTransition(
  current: NodeStatus,
): { ok: true; next: "superseded" } | { ok: false; current: NodeStatus } {
  if (current === "superseded") return { ok: false, current };
  return { ok: true, next: "superseded" };
}
