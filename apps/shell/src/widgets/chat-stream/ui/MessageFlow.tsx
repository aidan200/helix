/**
 * 消息流（widgets/chat-stream 聚合件）：投影 entries + 流式尾部气泡 + SubAgent
 * 卡片区 + empty 态 + P-1s 分页胶囊（T3.2）。滚动语义照原型：新内容贴底
 * （scrollTop 直设，无滚动监听）；历史前插保持视口锚定（增量在上方时按
 * 高度差补偿，不跳底）；连接覆盖层等页面浮层经 children 挂进滚动容器
 * （pages 层组装）。
 *
 * 卡片区插位（F1.1）：entries → 主线 streaming 气泡 → SA 卡片区（spawn 时序
 * 追加，新卡 log-rise 进入；同一事实单一呈现面——closure 注入文本不占消息位）。
 *
 * v0.2（T3.2）：sessionId === null 的空态 = 草稿空态（P-1 draft-empty，呼吸
 * 文案 + 建会话提示）；有会话上下文的空态 = 既有 SessionEmpty 引导面。
 * 主线 thinking 流式块（F2.3 streaming 态）插在 entries 之后、streaming 气泡
 * 之前；SubAgent 实例 thinking 流式槽位归抽屉消费（F1.6 实例分流）。
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { EntryDto } from "@helix/protocol";
import { MAIN_INSTANCE_ID } from "@/entities/session/model/session-reducer";
import { selectIsEmpty, useSession } from "@/entities/session/SessionContext";import MessageBubble from "./MessageBubble";
import SubAgentCard from "./SubAgentCard";
import ToolCard from "@/shared/ui/ToolCard";
import SessionEmpty from "./SessionEmpty";
import DraftEmpty from "./P-1-draft-empty";
import LoadEarlier from "./P-1s-load-earlier";
import CompactionBar from "./CompactionBar";
import EngineErrorCard from "./EngineErrorCard";
import { ThinkingEntryView, ThinkingLiveView } from "@/shared/ui/ThinkingBlock";

function EntryView({ entry }: { entry: EntryDto }) {
  // 正向穷尽分发（EntryDto 四成员；新增 kind 时 default 分支编译报错）
  switch (entry.kind) {
    case "tool-call":
      return <ToolCard entry={entry} />;
    case "message":
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
  // 历史前插视口锚定：上一次布局后高度 + 首条 id（区分贴底与前插补偿）
  const prevHeightRef = useRef(0);
  const prevFirstIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = flowRef.current;
    if (!el) return;
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
    state.entries.length,
    state.streaming?.text,
    state.instances.length,
    state.thinkingStreams[MAIN_INSTANCE_ID],
    state.engineError !== null, // 终验热修：错误卡出入视口同样贴底
  ]);

  // 向上滚动到顶 → 加载更早历史（AD-1 分页；selectCanLoadEarlier 门控在
  // provider 侧：hasMore=false 禁用 / 在途去重。P-1s「加载更早」指示器与
  // 骨架 UI 归 T3.2，本挂点为滚动触发的最小接线）
  useEffect(() => {
    const el = flowRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop <= 0) loadEarlierHistory();
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadEarlierHistory]);

  const empty = selectIsEmpty(state);

  return (
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
          {state.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} />
          ))}
          {state.thinkingStreams[MAIN_INSTANCE_ID] !== undefined && (
            <ThinkingLiveView text={state.thinkingStreams[MAIN_INSTANCE_ID]} />
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
          {/* 终验热修：引擎/模型失败卡（瞬态；随轮清除） */}
          <EngineErrorCard />
          {state.instances.length > 0 && (
            <div className="sa-cards">
              {state.instances.map((card) => (
                <SubAgentCard key={card.instanceId} card={card} onOpenDrawer={onOpenInstance} />
              ))}
            </div>
          )}
        </div>
        {empty && (state.sessionId === null ? <DraftEmpty /> : <SessionEmpty />)}
      </div>
      {children /* conn-overlay 等浮层（pages 层组装） */}
    </main>
  );
};

export default MessageFlow;
