/**
 * channel 五物种单一时间线（F1.2；P-2 channel 滚动区内容件）。
 *
 * 数据 = reducer instanceChannels 纯投影（零本地态）：
 * - lifecycle 行（spawned/模型解析/stalled warn/crashed·terminated err，
 *   2px 竖线 + StatusDot + micro 时间戳）；
 * - SA 消息（22px 紧凑 avatar + violet 气泡；流式中间态走 stream 槽位尾块）；
 * - steer 注入标记（violet 虚线框 + 「⇦ 主线 steer 注入」+ 文本 + 时间戳；
 *   user 消息回放 = 主线 agent_send 转投，F1.2）；
 * - thinking 块（复用 T4.2 FlowBar 契约：完成折叠条 / 流式伴随块）；
 * - 工具卡（P-1 同款三态）+ closure 卡（五字段）。
 * queued 实例：ch-hint 产品空态（状态交代，非演示解释）。
 */
import { memo } from "react";
import { useI18n } from "@/shared/i18n";
import { formatDuration, formatTs } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";
import ThinkingEntryView, { ThinkingLiveView } from "@/shared/ui/ThinkingBlock";
import ToolCard from "@/shared/ui/ToolCard";
import type {
  ChannelItem,
  ChannelLcKey,
  ChannelStream,
} from "@/entities/session/model/session-reducer";
import ClosureCard from "./ClosureCard";

interface ChannelTimelineProps {
  agentId: string;
  profileKind: string;
  items: ChannelItem[];
  /** 流式消息中间态（chat.stream.delta 镜像；尾块 violet 气泡 + 光标） */
  stream?: ChannelStream;
  /** thinking 流式中间态（thinkingStreams 槽位；尾块伴随） */
  thinkingLive?: string;
  /** queued 空态（产品空态 ch-hint） */
  queued: boolean;
}

/** lifecycle 行文本（键 → drawer.lc.* 词条；slot 声明键按来源分支）。 */
function useLcText(profileKind: string): (item: Extract<ChannelItem, { kind: "lifecycle" }>) => string {
  const { t } = useI18n();
  return (item) => {
    switch (item.lc as ChannelLcKey) {
      case "spawned":
        return t("chat.drawer.lc.spawned", { profile: profileKind });
      case "modelResolved":
        return t("chat.drawer.lc.modelResolved", {
          model: item.model ?? "",
          slot: t(
            item.slot === "declared"
              ? "chat.drawer.slotDeclared"
              : "chat.drawer.slotInherited",
          ),
        });
      case "stalled":
        return t("chat.drawer.stalledLc", { dur: formatDuration(item.idleMs ?? 0) });
      case "crashed":
        return t("chat.drawer.lc.crashed", { error: item.error ?? "" });
      case "terminated":
        return t("chat.drawer.lc.terminated");
    }
  };
}

const ChannelTimeline = memo(function ChannelTimeline({
  agentId,
  profileKind,
  items,
  stream,
  thinkingLive,
  queued,
}: ChannelTimelineProps) {
  const { t } = useI18n();
  const lcText = useLcText(profileKind);
  return (
    <div className="d-channel">
      {items.map((item) => {
        switch (item.kind) {
          case "lifecycle":
            return (
              <div className={cn("ch-item", "lc-row", item.tone)} key={item.seq} data-lc={item.lc}>
                <span className="lc-dot" aria-hidden="true" />
                <span>{lcText(item)}</span>
                {item.ts !== undefined && (
                  <span className="lc-ts">{formatTs(item.ts, t("chat.tsFormat"))}</span>
                )}
              </div>
            );
          case "message":
            return (
              <div className="ch-item ch-msg" key={item.seq} data-kind="ch-message">
                <div className="avatar">SA</div>
                <div className="col">
                  <div className="meta">
                    <span className="who">{agentId}</span>
                    {item.ts !== undefined && (
                      <span className="ts">{formatTs(item.ts, t("chat.tsFormat"))}</span>
                    )}
                  </div>
                  <div className="bubble">{item.text}</div>
                </div>
              </div>
            );
          case "steer":
            return (
              <div className="ch-item steer-mark" key={item.seq} data-kind="steer-mark">
                <span className="sm-label">
                  <span className="hud-dot hud-dot-pulse" aria-hidden="true" />
                  {t("chat.drawer.steerMark")}
                </span>
                <span className="sm-text">{item.text}</span>
                {item.ts !== undefined && (
                  <span className="sm-ts">{formatTs(item.ts, t("chat.tsFormat"))}</span>
                )}
              </div>
            );
          case "thinking-entry":
            return <ThinkingEntryView key={item.seq} entry={item.entry} />;
          case "tool":
            return <ToolCard key={item.seq} entry={item.entry} />;
          case "closure":
            return <ClosureCard key={item.seq} closure={item.closure} />;
          default: {
            const exhaustive: never = item;
            return exhaustive;
          }
        }
      })}
      {/* queued 实例产品空态：空位释放后展开（状态交代，非演示解释） */}
      {queued && (
        <div className="ch-hint" data-kind="queued-hint">
          <span className="hud-dot hud-dot-pulse" aria-hidden="true" />
          {t("chat.drawer.queuedHint")}
        </div>
      )}
      {/* 流式尾块：thinking 伴随块 + SA 消息 violet 气泡（光标态） */}
      {thinkingLive !== undefined && <ThinkingLiveView key="think-live" text={thinkingLive} />}
      {stream !== undefined && (
        <div className="ch-item ch-msg live" data-kind="ch-message" data-streaming="1">
          <div className="avatar">SA</div>
          <div className="col">
            <div className="meta">
              <span className="who">{agentId}</span>
            </div>
            <div className="bubble">
              {stream.text}
              <span className="stream-cursor" aria-hidden="true" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default ChannelTimeline;
