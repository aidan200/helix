/**
 * DiffStatChip（T3+T4 diff 批）——ChatStatusBar 中槽轮次 diff 两 chip 统计。
 *
 * 口径（已裁）：只有 +N（新增行，--success 完成色）/ −N（删除行，--error
 * 错误色，U+2212 减号）两维——无第三统计。数据源 state.diff（diff.changed
 * 广播帧驱动：cleared → null 隐藏 / active 累计 / frozen 灰态定格仍可点击）。
 *
 * 空态不渲染（diff=null 或全零）——常驻行高度由 ChatStatusBar 槽位占位
 * 保底（E-125），chip 零占位不破高度恒定。数值累计动画：.diff-num 按
 * key={值} 重挂触发 CSS bump（无 JS 动画库）。点击 → onOpen（DiffOverlay
 * 详情窗由 pages 层 ChatPage 持开合态——conn-overlay 同族覆盖对话区）。
 *
 * rehydrate（v0.3.1 §29）：diff.changed 是瞬态帧——会话切走期间错过不
 * 重放、活跃 store 重建 diff 归零。本组件挂载/会话/连接态变化时若
 * diff=null 发单次 diff.get{live:true}（daemon 回落语义：进行中或最近
 * 轮），回执经 consumers/diff 真消费落切片——chip 自恢复。
 */
import { memo, useEffect } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";

interface DiffStatChipProps {
  /** 点击 chip 组 → 展开详情覆盖窗（ChatPage 承接）。 */
  onOpen: () => void;
}

const DiffStatChip = memo(function DiffStatChip({ onOpen }: DiffStatChipProps) {
  const { state, sendDiffGet } = useSession();
  const { t } = useI18n();
  const diff = state.diff;
  const sid = state.sessionId;
  const conn = state.conn;
  // rehydrate：空态补拉（会话确立 + 连接就绪；回执真消费落切片后本
  // effect 因 diff 非空自然停拉；切会话重建 store → diff 重归 null → 重拉）
  const empty = diff === null;
  useEffect(() => {
    if (!empty || sid === null || conn !== "connected") return;
    sendDiffGet({ live: true });
  }, [empty, sid, conn, sendDiffGet]);
  // 空态：无记录（daemon 内存态重启丢/开轮未记账）→ 不渲染
  if (diff === null || (diff.adds === 0 && diff.dels === 0 && diff.fileCount === 0)) {
    return null;
  }
  return (
    <button
      type="button"
      className="diff-chip-group"
      data-testid="diff-stat-chips"
      data-phase={diff.phase}
      title={`${t("chat.diff.title")} · ${t("chat.diff.add", { n: diff.adds })} / ${t("chat.diff.del", { n: diff.dels })}`}
      onClick={onOpen}
    >
      <span className="diff-chip add">
        +<span className="diff-num" key={`a${diff.adds}`}>{diff.adds}</span>
      </span>
      <span className="diff-chip del">
        −<span className="diff-num" key={`d${diff.dels}`}>{diff.dels}</span>
      </span>
    </button>
  );
});

export default DiffStatChip;
