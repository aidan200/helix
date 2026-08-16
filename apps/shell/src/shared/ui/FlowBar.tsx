/**
 * flow-bar 折叠条（F2.3/F4.1 共用组件契约；AD-9「可见性三件套同构」的
 * 组件层落位）：thinking 完成折叠条与 compaction 里程碑条同一组件模式。
 *
 * 纯展示受控组件——expanded/onToggle 由调用方持有（折叠/展开为纯 UI 态，
 * 不进 reducer）；aria-expanded 随 expanded 维护；动效仅 transform/opacity
 * （chevron 旋转 / flow-body log-rise 进入）。
 *
 * 形态契约（prototype P-1 / tokens.md 09 节圆角刻度）：
 * - 条体 6px 圆角 + 边线弱描（edge 低 alpha）；hover 提亮（border/bg/text 三通道）；
 * - glyph 左置（thinking 💭 accent / compaction ⇄ violet，由 tone 区分）；
 * - meta 右槽（实例 chip · 时间 · usage 入账值，tabular-nums）；
 * - 展开体 flow-body（muted pre 风）由 CSS 门控显隐（display），children 常挂载。
 */
import { memo, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export interface FlowBarProps {
  /** 图标字形（💭 / ⇄，定论清单明文规定的符号） */
  glyph: string;
  /** 折叠条标题（i18n 词条渲染结果） */
  title: string;
  /** 右侧 meta 槽（实例 chip · 时间 · usage 等，纯展示节点） */
  meta?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
  /** 色调：accent（thinking 默认）/ violet（compaction 区分，F4.1） */
  tone?: "accent" | "violet";
  /** 语义锚点（data-kind，F 层剧本定位；沿语义类 + data-* 风格，不用 data-testid） */
  kind?: string;
  /** 条目 id 锚点（entry.id；compaction 行锚点滚动目标） */
  entryId?: string;
}

const FlowBar = memo(function FlowBar({
  glyph,
  title,
  meta,
  expanded,
  onToggle,
  children,
  tone = "accent",
  kind,
  entryId,
}: FlowBarProps) {
  return (
    <div
      className={cn("fb-wrap", tone === "violet" && "compact", expanded && "open")}
      data-kind={kind}
      data-entry-id={entryId}
    >
      <button className="flow-bar" type="button" aria-expanded={expanded} onClick={onToggle}>
        <span className="glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="fb-text">{title}</span>
        {meta != null && <span className="fb-meta">{meta}</span>}
        <span className="t-chev" aria-hidden="true" />
      </button>
      {children}
    </div>
  );
});

export default FlowBar;
