/**
 * 进度条填充件（scaleX 入场动画：挂载置 0，双 rAF 后落目标值——原型同款；
 * reduced-motion 下 transition 由 project.css 关停为离散跳变）。 */
import { useEffect, useRef } from "react";

export function ProgressFill({ ratio }: { ratio: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
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
  }, [ratio]);
  return <div className="kg-progress-fill" ref={ref} />;
}
