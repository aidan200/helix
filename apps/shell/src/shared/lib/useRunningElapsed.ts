/**
 * running 态耗时计时（视图本地展示；1s 步进，纯信息量非动效，reduced-motion 不豁免）。
 *
 * 从 SubAgentCard 提取为 shared 原语（T4.3）：卡片与抽屉头共用同一耗时口径；
 * 协议 DTO 不携带 startedAt，此处为展示层 best-effort（快照重建后从挂载起算）。
 */
import { useEffect, useRef, useState } from "react";
import { formatDuration } from "./format";

export function useRunningElapsed(active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  const startRef = useRef<number | null>(null);
  if (active && startRef.current === null) startRef.current = Date.now();
  if (!active) startRef.current = null;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return startRef.current === null ? "0.0s" : formatDuration(now - startRef.current);
}
