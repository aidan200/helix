/**
 * entities/session —— 会话上下文（reducer × WS 客户端接线）。
 *
 * 会话投影唯一入口：useSession() 暴露纯投影 state 与三类意图动作
 * （setDraft / submit / retry）。发送语义按生成态自动分流：
 * 空闲 → chat.send（气泡由 daemon 事件投影）；生成中 → chat.steer
 * （本地 echo + STEER 徽标，对账靠 steer.queued/drained 事件）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { HelixWsClient } from "@/shared/api/helix-ws";
import { DAEMON_PORT } from "@/shared/config/env";
import {
  createInitialSessionState,
  selectIsGenerating,
  sessionReducer,
  type SessionState,
} from "./model/session-reducer";

export type { ConnState, SessionState, StreamingState } from "./model/session-reducer";
export {
  selectCanSend,
  selectIsEmpty,
  selectIsGenerating,
} from "./model/session-reducer";

interface SessionContextValue {
  state: SessionState;
  setDraft: (text: string) => void;
  /** 提交输入：生成中自动转 steer（F(7).3），否则 chat.send */
  submit: (text: string) => void;
  /** 失败卡「重试连接」（仅 error 态有意义；SM-2 手动重试路径） */
  retry: () => void;
  consumeRestoreToast: () => void;
  /** spawn 秒回 toast 消费（ChatPage 渲染后置空；F1.5，v0.1） */
  consumeSpawnToast: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, undefined, createInitialSessionState);
  const clientRef = useRef<HelixWsClient | null>(null);
  const generatingRef = useRef(false);
  generatingRef.current = selectIsGenerating(state);

  if (clientRef.current === null) {
    clientRef.current = new HelixWsClient({ port: DAEMON_PORT });
  }

  useEffect(() => {
    const client = clientRef.current!;
    const offFrame = client.onFrame((event) => dispatch({ type: "event", event }));
    const offConn = client.onConn((c) => {
      switch (c.kind) {
        case "connecting":
          dispatch({ type: "conn/connecting", attempt: c.attempt });
          break;
        case "disconnected":
          dispatch({ type: "conn/disconnected" });
          break;
        case "gave-up":
          dispatch({ type: "conn/gave-up", message: c.message, attempts: c.attempts });
          break;
      }
    });
    client.start();
    return () => {
      offFrame();
      offConn();
      client.stop();
    };
  }, []);

  const setDraft = useCallback((text: string) => dispatch({ type: "ui/set-draft", text }), []);

  const submit = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const mode = generatingRef.current ? "steer" : "turn";
    dispatch({ type: "ui/send", text, mode, ts: Date.now() });
    clientRef.current!.send({
      v: PROTOCOL_VERSION,
      type: mode === "steer" ? "chat.steer" : "chat.send",
      payload: { text },
    });
  }, []);

  const retry = useCallback(() => {
    dispatch({ type: "conn/manual-retry" });
    clientRef.current!.retry();
  }, []);

  const consumeRestoreToast = useCallback(
    () => dispatch({ type: "ui/consume-restore-toast" }),
    [],
  );

  const consumeSpawnToast = useCallback(
    () => dispatch({ type: "ui/consume-spawn-toast" }),
    [],
  );

  const value = useMemo(
    () => ({ state, setDraft, submit, retry, consumeRestoreToast, consumeSpawnToast }),
    [state, setDraft, submit, retry, consumeRestoreToast, consumeSpawnToast],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
