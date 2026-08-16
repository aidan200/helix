/**
 * entities/session —— SubAgent 卡片投影工具（C2 拆分共享面，T1.1）。
 *
 * 实例卡片（InstanceCardState）读写工具集：agent 消费者（编排生命周期族）
 * 与 chat 消费者（delta 摘要尾窗 / 消息完成定稿）共用，自原 session-reducer.ts
 * 语义不变迁出。终态吸收（F1.9）在 updateCard 回调内由调用方判定。
 */
import type { InstanceState } from "@helix/protocol";
import type { InstanceCardState } from "./state";

/** 卡片 streaming 摘要尾窗长度（滚动截断，防长文本撑爆状态；决策消解「末 120 字」）。 */
const SUMMARY_TAIL = 120;

function tailWindow(text: string): string {
  return text.length > SUMMARY_TAIL ? text.slice(-SUMMARY_TAIL) : text;
}

/** 终态判定（done/failed/cancelled；终态吸收后续 agent 事件与 delta，F1.9）。 */
export function isTerminal(state: InstanceState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

/** 按 instanceId 定位更新卡片（未命中/未变化时原引用返回，保持浅比较友好）。 */
export function updateCard(
  instances: InstanceCardState[],
  instanceId: string,
  fn: (c: InstanceCardState) => InstanceCardState,
): InstanceCardState[] {
  let changed = false;
  const next = instances.map((c) => {
    if (c.instanceId !== instanceId) return c;
    const updated = fn(c);
    if (updated !== c) changed = true;
    return updated;
  });
  return changed ? next : instances;
}

/** SubAgent delta → 卡片摘要尾窗追加（终态实例吸收；活动即恢复：清除 stalled 警示，§8-3）。 */
export function appendSummary(
  instances: InstanceCardState[],
  instanceId: string,
  delta: string,
): InstanceCardState[] {
  return updateCard(instances, instanceId, (c) =>
    isTerminal(c.state)
      ? c
      : { ...c, streamSummary: tailWindow(c.streamSummary + delta), stalledMs: undefined },
  );
}

/** SubAgent 消息完成 → 摘要定稿（决策消解：completed 转摘要定稿，取正文尾窗）。 */
export function finalizeSummary(
  instances: InstanceCardState[],
  instanceId: string,
  content: string,
): InstanceCardState[] {
  return updateCard(instances, instanceId, (c) =>
    isTerminal(c.state) ? c : { ...c, streamSummary: tailWindow(content) },
  );
}
