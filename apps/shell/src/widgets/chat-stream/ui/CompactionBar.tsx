/**
 * compaction 里程碑条（F4.1/AD-9，CL-4 UI 面）：与 thinking 折叠条同构
 * （FlowBar 组件模式），⇄ glyph 走 violet 区分 thinking 的 💭 accent。
 *
 * meta = 实例 chip · 时间 · usage 入账值（entry.usage 为展示面；账目聚合
 * 唯一驱动在 usage.recorded/快照，此处不双计——reducer compaction 分支
 * 不触碰 usage，AD-9③ 防线）。展开显示 summary 全文 + 保留尾部注
 * （v0.1 CompactionEntryDto 无尾部/文件计数字段 → 无数字变体词条）。
 */
import { memo, useState } from "react";
import type { CompactionEntryDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { fmtTokens, formatTs } from "@/shared/lib/format";
import FlowBar from "./FlowBar";

const CompactionBar = memo(function CompactionBar({ entry }: { entry: CompactionEntryDto }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  // createdAt 为 ISO 字符串（DTO 契约）；解析失败退化为无时间 meta
  const ts = Date.parse(entry.createdAt);
  return (
    <FlowBar
      glyph="⇄"
      tone="violet"
      kind="compaction"
      entryId={entry.id}
      title={t("chat.compact.bar", {
        before: fmtTokens(entry.tokensBefore),
        after: fmtTokens(entry.tokensAfter),
      })}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      meta={
        <>
          <span className="who-chip">{entry.instanceId}</span>
          {Number.isFinite(ts) && <span>{formatTs(ts, t("chat.tsFormat"))}</span>}
          <span>
            {t("chat.stats.badge", {
              tokens: fmtTokens(entry.usage.totalTokens),
              cost: entry.usage.cost.toFixed(2),
            })}
          </span>
        </>
      }
    >
      <div className="flow-body">
        {entry.summary}
        <span className="fb-note">{t("chat.compact.note")}</span>
      </div>
    </FlowBar>
  );
});

export default CompactionBar;
