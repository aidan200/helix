/**
 * 消息流（widgets/chat-stream 聚合件）：投影 entries + SubAgent 时间轴内联卡
 * + 流式尾部气泡 + empty 态 + P-1s 分页胶囊（T3.2）。滚动语义照原型：新内容贴底
 * （scrollTop 直设，无滚动监听）；历史前插保持视口锚定（增量在上方时按
 * 高度差补偿，不跳底）；会话切换（含首连/草稿转正）恒贴底 + 锚定基线重置
 * （H-2：切换不得误判为前插吃旧会话陈旧高度）。加载更早唯一触发面 =
 * 分页胶囊点击（H-2：滚动到顶自动触发退役——scrollTop<=0 吃橡皮筋过冲/
 * 短内容恒 0/程序化落顶自触发三重误触发，且是 e2e beforeCount 竞态源头）。
 * 连接覆盖层等页面浮层经 children 挂进滚动容器（pages 层组装）。
 *
 * SubAgent 卡片插位（F1.1 + CL-1 v0.3 时间轴内联）：卡片按 DTO spawn 锚点
 * （anchorEntryId；daemon 组装期权威计算，shell 零推导）交织进 entries 序列
 * 原位渲染——锚点 id 引用抗分页前插；状态原位更新（queued→running→终态），
 * 终态卡留原位作历史；同锚点多卡保 spawn 先后序（instances 数组序）；锚 entry
 * 不在当前装载窗口（尾窗截断/翻页出窗）→ 卡片不渲染（Q-1b：无钉窗底、无
 * 占位、无补偿 UI）。
 * 同一事实单一呈现面——closure 注入文本不占消息位。
 *
 * v0.2（T3.2）：sessionId === null 的空态 = 草稿空态（P-1 draft-empty，呼吸
 * 文案 + 建会话提示）；有会话上下文的空态 = 既有 SessionEmpty 引导面。
 * 主线 thinking 流式块（F2.3 streaming 态）插在 entries 之后、streaming 气泡
 * 之前；SubAgent 实例 thinking 流式槽位归抽屉消费（F1.6 实例分流）。
 */
import { useLayoutEffect, useRef, Fragment, type ReactNode } from "react";
import type { EntryDto } from "@helix/protocol";
import { isMainChannel } from "@/entities/session/model/session-reducer";
import { selectIsEmpty, useSession } from "@/entities/session/SessionContext";
import type { InstanceCardState } from "@/entities/session/model/session-reducer";
import MessageBubble from "./MessageBubble";
import SubAgentCard from "./SubAgentCard";
import ToolCard from "@/shared/ui/ToolCard";
import DirectedSteer from "@/shared/ui/DirectedSteer";
import SessionEmpty from "./SessionEmpty";
import DraftEmpty from "./P-1-draft-empty";
import LoadEarlier from "./P-1s-load-earlier";
import CompactionBar from "./CompactionBar";
import EngineErrorCard from "./EngineErrorCard";
import NetworkRetryCard from "./NetworkRetryCard";
import { ThinkingEntryView, ThinkingLiveView } from "@/shared/ui/ThinkingBlock";
import { WorkPhaseDot } from "./WorkPhaseDot";
import { selectWorkPhase } from "@/entities/session/model/session-reducer";

function EntryView({ entry, mainInstanceId }: { entry: EntryDto; mainInstanceId: string }) {
  // 正向穷尽分发（EntryDto 四成员；新增 kind 时 default 分支编译报错）
  switch (entry.kind) {
    case "tool-call":
      return <ToolCard entry={entry} />;
    case "message":
      // CL-3 定向 steer（契约 §3.2 Q-3a 时间轴侧）：isSteer（DTO 面 = user +
      // steerState 携带）且非主实例（kind 判别：isMainChannel 单点，含 legacy
      // 缺省/"main" 推断）→ 定向细条（非气泡；判别不用 steerState——定向
      // entry steerState 恒 drained，T2.3 边界注记）；主线 steer / 普通消息沿既有气泡形态
      if (
        entry.role === "user" &&
        entry.steerState !== undefined &&
        entry.instanceId !== undefined &&
        !isMainChannel(entry.instanceId, mainInstanceId)
      ) {
        return <DirectedSteer target={entry.instanceId} text={entry.content} />;
      }
      return <MessageBubble entry={entry} />;
    case "thinking":
      return <ThinkingEntryView entry={entry} />;
    case "compaction":
      return <CompactionBar entry={entry} />;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

const noop = () => {};

interface MessageFlowProps {
  children?: ReactNode;
  /** 开实例抽屉（T4.3 接线；当前占位）——payload = instanceId（≡ agentId，AD-3） */
  onOpenInstance?: (instanceId: string) => void;
}

const MessageFlow = function MessageFlow({ children, onOpenInstance = noop }: MessageFlowProps) {
  const { state, loadEarlierHistory } = useSession();
  const flowRef = useRef<HTMLElement>(null);
  // 历史前插视口锚定：上一次布局后高度 + 首条 id（区分贴底与前插补偿）；
  // 会话基线（H-2：切换判定源——ref 不随会话切换重置会把旧会话高度/首条
  // id 喂给补偿公式，落点错乱）
  const prevHeightRef = useRef(0);
  const prevFirstIdRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = flowRef.current;
    if (!el) return;
    // H-2：会话切换（含首连/草稿转正/切草稿）= 新视图——恒贴底 + 锚定基线
    // 重置并直返：本 commit 可能仍是旧 entries/loading 坍塌态（.session-active
    // display:none 高度≈0），基线采样一律推迟到同会话的下一个 commit
    if (state.sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = state.sessionId;
      prevFirstIdRef.current = null;
      prevHeightRef.current = 0;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const firstId = state.entries[0]?.id ?? null;
    const isPrepend =
      prevFirstIdRef.current !== null && firstId !== null && firstId !== prevFirstIdRef.current;
    if (isPrepend && prevHeightRef.current > 0) {
      // AD-1 前插：保持原首条在视口内的位置（高度差补偿，不跳底）
      el.scrollTop = el.scrollHeight - prevHeightRef.current + el.scrollTop;
    } else {
      el.scrollTop = el.scrollHeight;
    }
    prevHeightRef.current = el.scrollHeight;
    prevFirstIdRef.current = firstId;
  }, [
    state.sessionId, // H-2：切换 commit 必入（loading 坍塌期重采基线）
    state.view, // H-2：快照到达（loading→ready）必入——entries 等长切换不失聪
    state.entries.length,
    state.streaming?.text,
    state.instances.length,
    state.mainInstanceId, // T10c：主实例 id 习得（快照）变化时重采基线（thinking 槽位键随之切换）
    state.thinkingStreams[state.mainInstanceId],
    state.engineError !== null, // 终验热修：错误卡出入视口同样贴底
  ]);

  // H-2：滚动到顶自动加载更早已退役（三重误触发 + e2e 竞态源头），加载更早
  // 唯一触发面 = 分页胶囊点击（LoadEarlier onLoad → loadEarlierHistory；
  // hasMore/loading 门控归 provider selectCanLoadEarlier）

  const empty = selectIsEmpty(state);
  // 主线 thinking 流式槽位（T10c：键 = 快照习得的主实例 id；局部常量供窄化）
  const mainThinkingStream = state.thinkingStreams[state.mainInstanceId];
  // 工作段位呼吸光点（右下角；idle 熄灭不渲染）
  const workPhase = selectWorkPhase(state);

  // ── CL-1 v0.3 时间轴内联：按 DTO spawn 锚点把卡片交织进 entries 序列 ──
  // head = 流首锚点（null）；byAnchor = entry id → 该 entry 之后渲染的卡；
  // 锚 entry ∉ 当前装载窗口（尾窗截断/翻页出窗）→ 不进任何桶，卡片不渲染。
  const headCards: InstanceCardState[] = [];
  const byAnchor = new Map<string, InstanceCardState[]>();
  const entryIds = new Set(state.entries.map((e) => e.id));
  for (const card of state.instances) {
    if (card.anchorEntryId === null) {
      headCards.push(card);
    } else if (entryIds.has(card.anchorEntryId)) {
      const list = byAnchor.get(card.anchorEntryId) ?? [];
      list.push(card);
      byAnchor.set(card.anchorEntryId, list);
    }
    // else：锚出窗 → 卡片不渲染（无兜底桶）
  }
  const renderCard = (card: InstanceCardState) => (
    <SubAgentCard key={card.instanceId} card={card} onOpenDrawer={onOpenInstance} />
  );

  return (
    <div className="msg-flow-wrap">
      <main className="msg-flow" ref={flowRef}>
      <div className="flow-inner">
        <div className="session-active">
          <LoadEarlier
            paged={state.history.paged}
            hasMore={state.history.hasMore}
            loading={state.history.loading}
            loaded={state.entries.length}
            total={state.history.total}
            onLoad={loadEarlierHistory}
          />
          {headCards.map(renderCard)}
          {state.entries.map((entry) => (
            <Fragment key={entry.id}>
              <EntryView entry={entry} mainInstanceId={state.mainInstanceId} />
              {byAnchor.get(entry.id)?.map(renderCard)}
            </Fragment>
          ))}
          {mainThinkingStream !== undefined && (
            <ThinkingLiveView text={mainThinkingStream} />
          )}
          {state.streaming && (
            <MessageBubble
              entry={{
                kind: "message",
                id: `streaming-${state.streaming.messageId}`,
                role: "assistant",
                content: "",
                ts: Date.now(),
              }}
              streaming
              streamingText={state.streaming.text}
            />
          )}
          {/* P2 ⑦ 网络重试批：退避等待状态卡（瞬态；流恢复即清，最终失败换错误卡） */}
          <NetworkRetryCard />
          {/* 终验热修：引擎/模型失败卡（瞬态；随轮清除） */}
          <EngineErrorCard />
        </div>
        {empty && (state.sessionId === null ? <DraftEmpty /> : <SessionEmpty />)}
      </div>
      {children /* conn-overlay 等浮层（pages 层组装） */}
      </main>
      {/* 工作段位呼吸光点（右下角；idle 炄灭不渲染）。T-webkit-repaint：
          光点在滚动容器外、absolute 钉 wrap 右下——旧形态（sticky 驻滚动容器内）
          在 WKWebView（Tauri 桌面端）命中 WebKit 对 sticky 元素内文本更新
          不重绘的缺陷（颜色随 data-phase 样式失效正常、文字纹理陈旧；
          resize/DevTools 开关强制重绘才恢复）；脱离滚动流同时修复内容不满
          一屏时 sticky 不钉底的视觉偏差 */}
      {workPhase !== "idle" && <WorkPhaseDot phase={workPhase} />}
    </div>
  );
};

export default MessageFlow;
