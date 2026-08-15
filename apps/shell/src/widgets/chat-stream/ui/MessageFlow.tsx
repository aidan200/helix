/**
 * 消息流（widgets/chat-stream 聚合件）：投影 entries + 流式尾部气泡 + empty 态。
 * 滚动语义照原型：新内容贴底（scrollTop 直设，无滚动监听）；
 * 连接覆盖层等页面浮层经 children 挂进滚动容器（pages 层组装）。
 */
import { useEffect, useRef, type ReactNode } from "react";
import type { EntryDto } from "@helix/protocol";
import { selectIsEmpty, useSession } from "@/entities/session/SessionContext";
import MessageBubble from "./MessageBubble";
import ToolCard from "./ToolCard";
import SessionEmpty from "./SessionEmpty";

function EntryView({ entry }: { entry: EntryDto }) {
  if (entry.kind === "tool-call") return <ToolCard entry={entry} />;
  return <MessageBubble entry={entry} />;
}

const MessageFlow = function MessageFlow({ children }: { children?: ReactNode }) {
  const { state } = useSession();
  const flowRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.entries.length, state.streaming?.text]);

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
        </div>
        {empty && <SessionEmpty />}
      </div>
      {children /* conn-overlay 等浮层（pages 层组装） */}
    </main>
  );
};

export default MessageFlow;
