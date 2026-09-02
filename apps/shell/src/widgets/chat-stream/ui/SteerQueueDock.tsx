/**
 * steer 队列坞（drain 落盘语义的 queued 观察面）：
 * 排队中的注入不上时间轴——收在聊天区左下角的浮动坞（与右下角
 * WorkPhaseDot 对称；E-89 教训：absolute 钉 .msg-flow-wrap，勿 sticky
 * 驻滚动容器内）。折叠态 = 计数 chip（脉冲点），点击向上展开清单
 * （来源 chip + 正文 + 状态小字：已入队 / 待确认）。
 *
 * 数据源：state.steerQueue（本地 echo → steer.queued 确认对账 →
 * steer.drained/快照重建移除）；展开/折叠为纯 UI 态（不进 reducer，
 * FlowBar 同纪律）。drain 落盘后条目进时间轴原位（生效时机），
 * 坞内同步出账——两态衔接由 reducer 链保证。
 */
import { memo, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";

const SteerQueueDock = memo(function SteerQueueDock() {
  const { t } = useI18n();
  const { state } = useSession();
  const [expanded, setExpanded] = useState(false);
  const queue = state.steerQueue;
  if (queue.length === 0) return null;
  return (
    <div className={cn("steer-dock", expanded && "open")} data-kind="steer-dock">
      {expanded && (
        <div className="sdq-list">
          {queue.map((item) => (
            <div className="sdq-item" key={item.id} data-source={item.source}>
              {(item.source === "closure" || item.source === "progress") && (
                <span className={cn("sdq-src", item.source)}>
                  {item.source === "closure" ? t("chat.steer.closureBadge") : t("chat.steer.progressBadge")}
                </span>
              )}
              <span className="sdq-text">{item.text}</span>
              <span className="sdq-state">
                {item.confirmed ? t("chat.steer.queued") : t("chat.steer.dockPending")}
              </span>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="sdq-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="q-dot" aria-hidden />
        {t("chat.steer.dockTitle", { n: queue.length })}
      </button>
    </div>
  );
});

export default SteerQueueDock;
