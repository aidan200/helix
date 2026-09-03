/**
 * 消息流（widgets/chat-stream 聚合件）：投影 entries + SubAgent 时间轴内联卡
 * + 流式尾部气泡 + empty 态 + P-1s 分页胶囊（T3.2）。滚动语义：吸附态
 * （atBottomRef）下新内容贴底（scrollTop 直设）；用户上滚脱附后流式新内容
 * 不再拽回底部（scrollTop 保持），滚回底部经 1s 驻留（呼吸底线视觉提示）
 * 才恢复吸附——避免误触阈值即拽回的画面抖动；驻留期取消条件 = 用户主动
 * 滚离（scroll 事件采样——内容增长不触发 scroll 事件，驻留不被流式增长
 * 误取消）。历史前插保持视口锚定（增量在上方时按高度差补偿，不跳底）；
 * 会话切换（含首连/草稿转正）恒贴底 + 锚定基线重置 + 吸附态复位
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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, Fragment, type ReactNode } from "react";
import type { EntryDto, UsageDto } from "@helix/protocol";
import { isMainChannel } from "@/entities/session/model/session-reducer";
import { selectIsEmpty, useSession } from "@/entities/session/SessionContext";
import type { InstanceCardState } from "@/entities/session/model/session-reducer";
import MessageBubble from "./MessageBubble";
import SubAgentCard from "./SubAgentCard";
import ToolCard from "@/shared/ui/ToolCard";
import DirectedSteer from "@/shared/ui/DirectedSteer";
import SystemInjectBar from "@/shared/ui/SystemInjectBar";
import SessionEmpty from "./SessionEmpty";
import DraftEmpty from "./P-1-draft-empty";
import LoadEarlier from "./P-1s-load-earlier";
import CompactionBar from "./CompactionBar";
import EngineErrorCard, { ErrorEntryBar } from "./EngineErrorCard";
import NetworkRetryCard from "./NetworkRetryCard";
import { ThinkingEntryView, ThinkingLiveView } from "@/shared/ui/ThinkingBlock";
import GeneratingPlaceholder from "./GeneratingPlaceholder";
import SteerQueueDock from "./SteerQueueDock";
import { WorkPhaseDot } from "./WorkPhaseDot";
import { selectWorkPhase } from "@/entities/session/model/session-reducer";

function EntryView({
  entry,
  mainInstanceId,
  turnUsage,
}: {
  entry: EntryDto;
  mainInstanceId: string;
  /** per-turn 账目表（SessionState.turnUsage；轮末 token 用量显示面查表源） */
  turnUsage: Record<string, UsageDto>;
}) {
  // 正向穷尽分发（EntryDto 四成员；新增 kind 时 default 分支编译报错）
  switch (entry.kind) {
    case "tool-call":
      return <ToolCard entry={entry} />;
    case "message":
      // 时间轴语义分层：气泡 = 人说的话，细条 = 系统的注入。source=closure/
      // progress 条目（SubAgent 收口/进展报告注入）渲染系统注入细条——判别
      // 优先于定向 steer（定向 entry source 缺省，两条件不重叠）
      if (entry.role === "user" && (entry.source === "closure" || entry.source === "progress")) {
        return <SystemInjectBar source={entry.source} text={entry.content} steerState={entry.steerState} />;
      }
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
      // 轮末 token 用量（assistant 气泡 meta 行）：按 entry.turnId 查表——
      // 未到账/无 turnId/无账目 = undefined → 气泡不显示（骨架免闪烁）
      const bubbleTurnUsage =
        entry.role === "assistant" && entry.turnId !== undefined ? turnUsage[entry.turnId] : undefined;
      return <MessageBubble entry={entry} turnUsage={bubbleTurnUsage} />;
    case "thinking":
      return <ThinkingEntryView entry={entry} />;
    case "compaction":
      return <CompactionBar entry={entry} />;
    case "error":
      // error entry 批：错误条目时间轴原位红条（复用 EngineErrorCard 红系视觉）
      return <ErrorEntryBar entry={entry} />;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

const noop = () => {};

/** 贴底判定阈值（px）：距底 ≤ 40 视为在底部（SubagentDrawer 同口径）。 */
const AT_BOTTOM_PX = 40;
/** 回底驻留时长（ms）：用户滚回底部后驻留满 1s 才恢复吸附（防误触阈值即拽回的抖动）。 */
const STICK_DWELL_MS = 1000;

interface MessageFlowProps {
  children?: ReactNode;
  /** 开实例抽屉（T4.3 接线；当前占位）——payload = instanceId（≡ agentId，AD-3） */
  onOpenInstance?: (instanceId: string) => void;
  /** M52：空态建议 chip 聚焦输入框回调（pages 层接线 Composer ref）。 */
  onFocusInput?: () => void;
}

const MessageFlow = function MessageFlow({ children, onOpenInstance = noop, onFocusInput }: MessageFlowProps) {
  const { state, loadEarlierHistory } = useSession();
  const flowRef = useRef<HTMLElement>(null);
  // 历史前插视口锚定：上一次布局后高度 + 首条 id（区分贴底与前插补偿）；
  // 会话基线（H-2：切换判定源——ref 不随会话切换重置会把旧会话高度/首条
  // id 喂给补偿公式，落点错乱）
  const prevHeightRef = useRef(0);
  const prevFirstIdRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  // 贴底吸附态（初始吸附：新会话/流式默认跟随）；驻留计时与视觉提示态
  const atBottomRef = useRef(true);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stickPending, setStickPending] = useState(false);

  const cancelStickDwell = useCallback(() => {
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    setStickPending(false);
  }, []);

  // 滚动监听只维护吸附态/驻留（不触发加载更早——H-2 退役语义保持）：
  // 已吸附时用户滚离 → 脱附；未吸附时用户滚回底部 → 1s 驻留（视觉提示）后
  // 正式吸附（直设贴底）；驻留期内用户主动滚离 → 取消。距底判定只在 scroll
  // 事件采样——内容增长不触发 scroll 事件，驻留不会被流式增长误取消。
  const onFlowScroll = useCallback(() => {
    const el = flowRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
    if (atBottomRef.current) {
      // 程序化贴底触发的 scroll 距底恒 ≈0，不会误入脱附分支
      if (!atBottom) atBottomRef.current = false;
      return;
    }
    if (!atBottom) {
      if (dwellTimerRef.current !== null) cancelStickDwell();
      return;
    }
    if (dwellTimerRef.current === null) {
      setStickPending(true);
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        setStickPending(false);
        atBottomRef.current = true;
        const cur = flowRef.current;
        if (cur) cur.scrollTop = cur.scrollHeight;
      }, STICK_DWELL_MS);
    }
  }, [cancelStickDwell]);

  // 卸载清驻留计时（防泄漏/卸载后 setState）
  useEffect(() => cancelStickDwell, [cancelStickDwell]);

  // 主线 thinking 流式槽位（T10c：键 = 快照习得的主实例 id；局部常量供窄化）
  const mainThinkingStream = state.thinkingStreams[state.mainInstanceId];
  // 生成中占位卡（切回/刷新仍生成的会话）：快照 agentState 活跃但流式槽全空
  // （streaming 不落盘、切走即弃，快照重建 streaming=null）——与 streaming
  // 气泡/ThinkingLiveView 互斥派生，message.completed 到达后自然让位转正。
  const showGeneratingPlaceholder =
    state.view === "ready" &&
    state.agentState !== "idle" &&
    state.agentState !== "stopped" &&
    state.streaming === null &&
    mainThinkingStream === undefined;

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
      atBottomRef.current = true; // 新视图复位吸附态（取消未决驻留）
      cancelStickDwell();
      el.scrollTop = el.scrollHeight;
      return;
    }
    const firstId = state.entries[0]?.id ?? null;
    const isPrepend =
      prevFirstIdRef.current !== null && firstId !== null && firstId !== prevFirstIdRef.current;
    if (isPrepend && prevHeightRef.current > 0) {
      // AD-1 前插：保持原首条在视口内的位置（高度差补偿，不跳底）
      el.scrollTop = el.scrollHeight - prevHeightRef.current + el.scrollTop;
    } else if (atBottomRef.current) {
      // 仅吸附态贴底：用户上滚脱附后流式新内容不拽回底部
      el.scrollTop = el.scrollHeight;
    }
    prevHeightRef.current = el.scrollHeight;
    prevFirstIdRef.current = firstId;
  }, [
    cancelStickDwell,
    state.sessionId, // H-2：切换 commit 必入（loading 坍塌期重采基线）
    state.view, // H-2：快照到达（loading→ready）必入——entries 等长切换不失聪
    state.entries.length,
    state.streaming?.text,
    state.instances.length,
    state.mainInstanceId, // T10c：主实例 id 习得（快照）变化时重采基线（thinking 槽位键随之切换）
    state.thinkingStreams[state.mainInstanceId],
    state.engineError !== null, // 终验热修：错误卡出入视口同样贴底
    showGeneratingPlaceholder, // 占位卡出入（agentState 切换不吃条目变化时）同样贴底
  ]);

  // H-2：滚动到顶自动加载更早已退役（三重误触发 + e2e 竞态源头），加载更早
  // 唯一触发面 = 分页胶囊点击（LoadEarlier onLoad → loadEarlierHistory；
  // hasMore/loading 门控归 provider selectCanLoadEarlier）

  const empty = selectIsEmpty(state);
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
      <main className="msg-flow" ref={flowRef} onScroll={onFlowScroll}>
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
              <EntryView entry={entry} mainInstanceId={state.mainInstanceId} turnUsage={state.turnUsage} />
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
          {/* 生成中占位卡：与上两块互斥（条件派生）；错误卡/重试卡独立共存 */}
          {showGeneratingPlaceholder && <GeneratingPlaceholder />}
          {/* P2 ⑦ 网络重试批：退避等待状态卡（瞬态；流恢复即清，最终失败换错误卡） */}
          <NetworkRetryCard />
          {/* 终验热修：引擎/模型失败卡（瞬态；随轮清除） */}
          <EngineErrorCard />
        </div>
        {empty && (state.sessionId === null ? <DraftEmpty /> : <SessionEmpty onFocusInput={onFocusInput} />)}
      </div>
      {children /* conn-overlay 等浮层（pages 层组装） */}
      </main>
      {/* 回底驻留视觉提示：用户滚回底部后 1s 驻留期的呼吸底线（正式吸附即消）；
          钉 wrap 底部不驻滚动容器（E-89 同构——勿 sticky/absolute 进滚动流） */}
      {stickPending && <div className="snap-dwell" data-testid="snap-dwell" aria-hidden="true" />}
      {/* steer 队列坞（左下角；queued 注入的观察面，与 WorkPhaseDot 对称钉位） */}
      <SteerQueueDock />
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
