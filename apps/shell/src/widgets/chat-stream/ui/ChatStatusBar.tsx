/**
 * chat 状态行（T1）：消息流与输入框之间的常驻条——三槽 flex 布局
 * （左 SteerQueueDock / 中 diff 预留空占位 / 右 WorkPhaseDot）。
 *
 * 常驻占位纪律：高度恒定（height:28px + flex-shrink:0）、无条件渲染——
 * 内容有无不影响布局（对话气泡卡片与输入框间距恒定）。
 *
 * E-89 教训（承 SteerQueueDock/WorkPhaseDot 浮动旧形态）：状态行位于滚动
 * 容器（.msg-flow）之外——常驻/钉位元素不得驻滚动容器内（WKWebView 对
 * sticky 类元素文本更新不重绘 + 内容不满一屏时 sticky 不钉底）。旧形态
 * 各自 absolute 钉 .msg-flow-wrap 左下/右下，T1 收拢为本行行内槽位，
 * 同样不进滚动流。dock 展开清单经 absolute 向上弹出（bottom:100% 锚
 * dock 上沿，覆盖消息流而非推挤——WorkLedgerBar wl-items 浮窗同纪律）。
 *
 * 数据源：左槽 state.steerQueue（SteerQueueDock 自取）；右槽
 * selectWorkPhase 槽位活跃推导（idle 时槽位空——WorkPhaseDot 现状
 * 「idle 不渲染」逻辑保留）；中槽纯结构占位（后续任务接 diff 统计）。
 */
import { memo } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { selectWorkPhase } from "@/entities/session/model/session-reducer";
import SteerQueueDock from "./SteerQueueDock";
import { WorkPhaseDot } from "./WorkPhaseDot";

const ChatStatusBar = memo(function ChatStatusBar() {
  const { state } = useSession();
  // 工作段位（右槽；idle → 槽位空，组件不渲染——现状逻辑保留）
  const workPhase = selectWorkPhase(state);
  return (
    <div className="chat-status-bar" data-testid="chat-status-bar">
      {/* 左槽：steer 队列坞（行内形态；空队列时槽位空、行仍在） */}
      <div className="csb-slot csb-left" data-testid="chat-status-left">
        <SteerQueueDock />
      </div>
      {/* 中槽：diff 统计预留占位（本任务只做结构占位，不接数据） */}
      <div className="csb-slot csb-mid" data-testid="chat-status-diff-slot" />
      {/* 右槽：工作段位呼吸光点（行内形态） */}
      <div className="csb-slot csb-right" data-testid="chat-status-right">
        {workPhase !== "idle" && <WorkPhaseDot phase={workPhase} />}
      </div>
    </div>
  );
});

export default ChatStatusBar;
