/**
 * 消息流（widgets/chat-stream 聚合件）：投影 entries + 流式尾部气泡 + SubAgent
 * 卡片区 + empty 态。滚动语义照原型：新内容贴底（scrollTop 直设，无滚动监听）；
 * 连接覆盖层等页面浮层经 children 挂进滚动容器（pages 层组装）。
 *
 * 卡片区插位（F1.1）：entries → 主线 streaming 气泡 → SA 卡片区（spawn 时序
 * 追加，新卡 log-rise 进入；同一事实单一呈现面——closure 注入文本不占消息位）。
 */
import { useEffect, useRef, type ReactNode } from "react";
import type { EntryDto } from "@helix/protocol";
import { selectIsEmpty, useSession } from "@/entities/session/SessionContext";
import MessageBubble from "./MessageBubble";
import SubAgentCard from "./SubAgentCard";
import ToolCard from "./ToolCard";
import SessionEmpty from "./SessionEmpty";

function EntryView({ entry }: { entry: EntryDto }) {
  // v0.1（T1.1）注：EntryDto 扩四成员后改为正向穷尽分发；thinking/compaction
  // 的可见性投影（折叠条/展开全文）由 T4.x（F2.3/F4.1）落位，协议期不渲染。
  switch (entry.kind) {
    case "tool-call":
      return <ToolCard entry={entry} />;
    case "message":
      return <MessageBubble entry={entry} />;
    default:
      return null;
  }
}

const noop = () => {};

interface MessageFlowProps {
  children?: ReactNode;
  /** 开实例抽屉（T4.3 接线；当前占位）——payload = instanceId（≡ agentId，AD-3） */
  onOpenInstance?: (instanceId: string) => void;
}

const MessageFlow = function MessageFlow({ children, onOpenInstance = noop }: MessageFlowProps) {
  const { state } = useSession();
  const flowRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.entries.length, state.streaming?.text, state.instances.length]);

  const empty = selectIsEmpty(state);

  return (
    <main className="msg-flow" ref={flowRef}>
      <div className="flow-inner">
        <div className="session-active">
          {state.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} />
          ))}
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
          {state.instances.length > 0 && (
            <div className="sa-cards">
              {state.instances.map((card) => (
                <SubAgentCard key={card.instanceId} card={card} onOpenDrawer={onOpenInstance} />
              ))}
            </div>
          )}
        </div>
        {empty && <SessionEmpty />}
      </div>
      {children /* conn-overlay 等浮层（pages 层组装） */}
    </main>
  );
};

export default MessageFlow;
