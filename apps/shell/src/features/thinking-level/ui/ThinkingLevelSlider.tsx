/**
 * ThinkingLevelSlider —— 推理强度档位滑块（thinking 批 T2.1；features/thinking-level
 * 共用原子组件，P-1 composer popover 消费位（P-2 已改开关形态不再消费）——props 契约
 * 稳定：levels/value/ghostValue/disabled/peak/onSelect，T2.2 直接消费）。
 *
 * 形态契约（review.md §2-3，prototype P-1-chat-thinking-slider.html 同源）：
 * 2px 轨道 + accent 填充段 + 1px 刻度竖线 + 档位标签（pi-ai 英文名小写 mono
 * text-micro）+ 11px 菱形 thumb（45° 旋转、accent 描边）；当前档标签 accent
 * 高亮（.cur），已过刻度 .on。
 *
 * 行为规则（test-design §2.6）：
 * - 能力位驱动：刻度数 = levels.length（CatalogModel.thinkingLevels 防腐字段
 *   消费，不硬编码六档；单档 pct 防除零）；
 * - 选档三通道：拖动（pointerdown/move 最近刻度吸附，同档去重不重发，up 收束）
 *   / 点刻度 / 方向键（ArrowRight/Up 升、ArrowLeft/Down 降，边界钳制不发令）；
 * - value = 生效档（强调位）；ghostValue = 未配置兜底预览位（P-1 默认关：
 *   空心 thumb + 刻度去强调，仅预览不可提交语义由消费方定）；
 * - disabled → 三通道全不响应 + 不可聚焦；peak → .peak class（thumb 辉光）。
 * 纯展示组件：零 SessionContext 依赖（onSelect 回调由消费方接命令链）。
 */
import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { cn } from "@/shared/lib/cn";

export interface ThinkingLevelSliderProps {
  /** 档位序列（CatalogModel.thinkingLevels 升序；刻度数 = length） */
  levels: string[];
  /** 生效档（滑块位置/强调）；null = 无生效档（ghost 预览或全链不支持） */
  value: string | null;
  /** 未配置兜底预览位（P-1 默认关停 off 位；value=null 时空心 thumb 停此位） */
  ghostValue?: string;
  disabled?: boolean;
  /** PEAK 态（生效档 = 最高支持档；thumb 辉光样式挂载点） */
  peak?: boolean;
  onSelect: (level: string) => void;
  ariaLabel?: string;
}

/** 刻度定位百分比（单档防除零 → 0%）。 */
function pct(n: number, i: number): number {
  return n <= 1 ? 0 : (i / (n - 1)) * 100;
}

const ThinkingLevelSlider = function ThinkingLevelSlider({
  levels,
  value,
  ghostValue,
  disabled = false,
  peak = false,
  onSelect,
  ariaLabel,
}: ThinkingLevelSliderProps) {
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  // 拖动去重簿记（拖过同一刻度不重复发令——thinking.set 命令面防抖）
  const lastFiredRef = useRef<string | null>(null);

  const n = levels.length;
  const curIdx = value !== null ? levels.indexOf(value) : -1;
  const ghostIdx = ghostValue !== undefined ? levels.indexOf(ghostValue) : -1;
  // 展示位：生效档优先；无生效档回落 ghost 预览位（均无 → 0 位无强调）
  const shownIdx = curIdx !== -1 ? curIdx : ghostIdx;
  const shownPct = shownIdx !== -1 ? pct(n, shownIdx) : 0;
  const ghostMode = curIdx === -1 && ghostIdx !== -1;

  const fireSelect = useCallback(
    (level: string) => {
      if (lastFiredRef.current === level) return; // 同档去重
      lastFiredRef.current = level;
      onSelect(level);
    },
    [onSelect],
  );

  /** 指针 x → 最近刻度吸附（轨道矩形内比例钳制 0..1）。 */
  const nearestLevel = useCallback(
    (clientX: number): string | null => {
      const el = trackRef.current;
      if (el === null || n === 0) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return levels[Math.round(ratio * (n - 1))] ?? null;
    },
    [levels, n],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const level = nearestLevel(e.clientX);
    if (level === null) return;
    setDragging(true);
    lastFiredRef.current = null; // 新一次拖动重置去重簿记
    // jsdom/旧 WebKit 无 pointer capture 时静默降级（拖动仍经 track 上 move 工作）
    try {
      trackRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* pointer capture 不可用环境降级 */
    }
    fireSelect(level);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || disabled) return;
    const level = nearestLevel(e.clientX);
    if (level !== null) fireSelect(level);
  };
  const endDrag = () => setDragging(false);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || n === 0) return;
    const base = shownIdx !== -1 ? shownIdx : 0;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(n - 1, base + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, base - 1);
    else return;
    e.preventDefault();
    if (next !== curIdx) fireSelect(levels[next]!); // 边界钳制：无变化不发令
  };

  return (
    <div
      ref={trackRef}
      className={cn("tl-track", dragging && "dragging", peak && "peak")}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={n > 0 ? 1 : 0}
      aria-valuemax={n}
      aria-valuenow={curIdx !== -1 ? curIdx + 1 : 0}
      aria-valuetext={value ?? ghostValue ?? ""}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <div className="tl-rail" />
      <div className="tl-fill" style={{ width: `${curIdx !== -1 ? pct(n, curIdx) : 0}%` }} />
      {levels.map((level, i) => (
        <button
          key={level}
          type="button"
          className={cn(
            "tl-tick",
            !ghostMode && curIdx !== -1 && i <= curIdx && "on",
            !ghostMode && i === curIdx && "cur",
            i === 0 && "first",
            i === n - 1 && "last",
          )}
          style={{ left: `${pct(n, i)}%` }}
          data-level={level}
          tabIndex={-1}
          disabled={disabled}
          onClick={() => {
            if (!disabled) fireSelect(level);
          }}
        >
          <i />
          <span>{level}</span>
        </button>
      ))}
      <div
        className={cn("tl-thumb", ghostMode && "ghost")}
        style={{ left: `${shownPct}%` }}
      />
    </div>
  );
};

export default ThinkingLevelSlider;
