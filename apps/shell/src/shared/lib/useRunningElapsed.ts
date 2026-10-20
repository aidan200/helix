/**
 * running 态耗时计时（视图本地展示；1s 步进，纯信息量非动效，reduced-motion 不豁免）。
 *
 * 从 SubAgentCard 提取为 shared 原语（T4.3）：卡片与抽屉头共用同一耗时口径。
 * 真实口径（真实执行时长锚点）：startedAtMs = daemon 域模型记账的当前 running
 * 段起点（agent.started/resumed 帧与快照 instances 携带），elapsedMs = park/resume
 * 结算的累计基线——总时长 = 基线 + (now - 段起点)。
 * 旧剧本兼容：锚点缺省（undefined）时回落挂载起算 best-effort（修复前行为）。
 */
import { useEffect, useState } from "react";
import { formatDuration } from "./format";

export function useRunningElapsed(
  active: boolean,
  startedAtMs?: number,
  baseMs: number = 0,
): string {
  const [now, setNow] = useState(() => Date.now());
  // 挂载钟（旧剧本兼容锚点）：state 而非 render 期写 ref（render 纯净性——
  // 并发渲染下 render 期捕获时刻依赖渲染时序）。惰性初始值捕获「挂载即活跃」
  // 的首渲染时刻；后续 active 段切换由 effect 收锚/重置。
  const [mountAnchor, setMountAnchor] = useState<number | null>(() => (active ? Date.now() : null));
  useEffect(() => {
    if (!active) {
      setMountAnchor(null);
      return;
    }
    const at = Date.now();
    setMountAnchor((prev) => prev ?? at);
    // 翻转拍同刻收 now：停表期 now 停留在旧刻（interval 已清），若只抬 anchor
    // 则 now-anchor 为负 → 首秒闪现负数耗时；重锚那拍一并抬 now。
    setNow(at);
    // 取舍（钉死）：不按页面可见性/活跃路由门控本 interval——now 仅驱动显示
    // 刷新，耗时精度由真实锚点（startedAtMs/baseMs）保证，隐藏期空转的 1s
    // timer 无精度损失；门控需接 visibilitychange + 路由活跃面，复杂度大于
    // 收益（低危保守取舍：单 timer 级成本可忽略）。
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  // 锚点优先级：daemon 真实段起点 > 挂载钟（旧剧本兼容）；基线仅在有真实锚点时参与
  const anchor = startedAtMs ?? mountAnchor;
  if (anchor === null || anchor === undefined) return "0.0s";
  return formatDuration(baseMs + (now - anchor));
}
