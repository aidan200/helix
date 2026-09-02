/**
 * thinking 块三态（F2.3/F2.4，CL-2 核心）。
 *
 * 三态互斥由 reducer 结构保证（TR-AD-5 纯投影，本组件零权威状态）：
 * - streaming：thinking.stream.delta 按 instanceId 累积（thinkingStreams 槽位），
 *   MessageFlow 挂 ThinkingLiveView（虚线 muted 流式 + 「思考中」标签 +
 *   accent 脉冲点 + 光标）；
 * - complete-collapsed：thinking.completed 落 ThinkingEntryDto 进 entries，
 *   EntryView 分发到 ThinkingEntryView（💭 折叠条，不可逆回 streaming——
 *   reducer completed 分支清流式槽位）；
 * - 无块：无 thinking 事件的消息零渲染（调用方按槽位/entries 判定）。
 *
 * 展开回看（F2.4）：折叠条点击展开 muted 全文（pre 风）；快照恢复的
 * thinking entry 同样可展开（重启回看）。
 */
import { memo, useState } from "react";
import type { ThinkingEntryDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import FlowBar from "./FlowBar";

/**
 * streaming 态：muted 虚线边流式块（不占独立消息位，伴随块语义）。
 * text = reducer thinkingStreams 槽位累积值（不落盘中间态的前端镜像）。
 */
export const ThinkingLiveView = memo(function ThinkingLiveView({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <div className="think-live" data-kind="thinking-live">
      <span className="tl-label">
        <span className="hud-dot hud-dot-pulse" aria-hidden="true" />
        {t("chat.think.streaming")}
      </span>
      <span className="tl-text">{text}</span>
      <span className="stream-cursor" aria-hidden="true" />
    </div>
  );
});

/** complete 态：折叠条「💭 已思考 Ns」+ 实例 chip（AD-3），
 *  点击展开全文回看；Ns = durationMs/1000 取整秒（CAND-35：token 消耗
 *  不再随块显示——账目唯一权威源 usage.recorded，思考条不展示）。 */
export const ThinkingEntryView = memo(function ThinkingEntryView({
  entry,
}: {
  entry: ThinkingEntryDto;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <FlowBar
      glyph="💭"
      kind="thinking"
      entryId={entry.id}
      title={t("chat.think.done", {
        s: Math.round(entry.durationMs / 1000),
      })}
      meta={<span className="who-chip">{entry.instanceId}</span>}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <div className="flow-body">{entry.text}</div>
    </FlowBar>
  );
});

export default ThinkingEntryView;
