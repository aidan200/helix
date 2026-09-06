/**
 * 进度条填充件（scaleX 入场动画：挂载置 0 仅首次，双 rAF 后落目标值——原型
 * 同款；M9 #2.31 修复：旧实现 effect 依赖含 ratio，building 轮询每 tick 先重置
 * scaleX(0) 再重播动画——后续 ratio 变更直接落值，交 CSS transition 平滑过渡；
 * reduced-motion 下 transition 由 project.css 关停为离散跳变）。
 * indeterminate=true：无真实进度时的不确定态（跳过 rAF 逻辑，动画纯 CSS）。 */
import { useEffect, useRef } from "react";

export function ProgressFill({ ratio = 0, indeterminate = false }: { ratio?: number; indeterminate?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  /** 挂载置零只跑一次（ref 标记）；其后 ratio 更新不再跳 0 重播。 */
  const enteredRef = useRef(false);
  useEffect(() => {
    if (indeterminate) return;
    const el = ref.current;
    if (el === null) return;
    if (enteredRef.current) {
      // 后续进度更新：直接落新值（CSS transition 承载过渡，不重置 0）
      el.style.transform = `scaleX(${ratio})`;
      return;
    }
    enteredRef.current = true;
    el.style.transform = "scaleX(0)";
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        el.style.transform = `scaleX(${ratio})`;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [ratio, indeterminate]);
  if (indeterminate) return <div className="kg-progress-fill indeterminate" />;
  return <div className="kg-progress-fill" ref={ref} />;
}
