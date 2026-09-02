/**
 * running 态耗时计时（视图本地展示；1s 步进，纯信息量非动效，reduced-motion 不豁免）。
 *
 * 从 SubAgentCard 提取为 shared 原语（T4.3）：卡片与抽屉头共用同一耗时口径。
 * 真实口径（真实执行时长锚点）：startedAtMs = daemon 域模型记账的当前 running
 * 段起点（agent.started/resumed 帧与快照 instances 携带），elapsedMs = park/resume
 * 结算的累计基线——总时长 = 基线 + (now - 段起点)。
 * 旧剧本兼容：锚点缺省（undefined）时回落挂载起算 best-effort（修复前行为）。
 */
import { useEffect, useRef, useState } from "react";
import { formatDuration } from "./format";

export function useRunningElapsed(
  active: boolean,
  startedAtMs?: number,
  baseMs: number = 0,
): string {
  const [now, setNow] = useState(() => Date.now());
  const mountRef = useRef<number | null>(null);
  if (active && mountRef.current === null) mountRef.current = Date.now();
  if (!active) mountRef.current = null;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  // 锚点优先级：daemon 真实段起点 > 挂载钟（旧剧本兼容）；基线仅在有真实锚点时参与
  const anchor = startedAtMs ?? mountRef.current;
  if (anchor === null || anchor === undefined) return "0.0s";
  return formatDuration(baseMs + (now - anchor));
}
