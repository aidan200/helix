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
import type { EventEnvelope } from "@helix/protocol";
import { HelixWsClient } from "@/shared/api/helix-ws";
import type { Transport, TransportFactory } from "@/shared/api/helix-ws";
import { DAEMON_PORT, FAKE_TRANSPORT_DEFINE, fakeTransportScript, isDev } from "@/shared/config/env";
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
  /** kill toast 消费（ChatPage 渲染后置空；agent.killed 终止链末端，T4.3） */
  consumeKillToast: () => void;
  /** agent.kill 命令（抽屉两步确认后发送；终态回流经 agent.killed 事件，契约 §4） */
  killInstance: (agentId: string) => void;
  /** agent.subscribe（抽屉打开；v0.1 通路语义，契约 §8-1） */
  subscribeInstance: (agentId: string) => void;
  /** agent.unsubscribe（抽屉关闭/换订） */
  unsubscribeInstance: (agentId: string) => void;
  /** dev 演示控件专用：合成协议事件直投 reducer（isDev 门控；prod 零路径）。
   *  与 fake transport 同构的帧注入点（F 层剧本驱动面），走真实投影路径。 */
  devDispatchEvent: (event: EventEnvelope) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** fake transport 懒装配（T4.4 标准注入点）：占位 transport 先行，mock 模块
 *  异步加载后接管（首次连接前就绪；spec 驱动面 __helixMock 就绪前
 *  MockController 会 await）。模块不进生产 bundle——define 摇除后调用点
 *  编译期消除（见 SessionProvider 内 FAKE_TRANSPORT_DEFINE 门控），动态
 *  import 站点随分支 treeshake（生产构建零 mock 代码路径，T4.4 验收项）。 */
function fakeTransportEntry(script: string): TransportFactory {
  return (url, handlers) => {
    let impl: Transport | null = null;
    void import("@/shared/api/fake-transport").then((m) => {
      impl = m.createFakeTransport(script)(url, handlers);
      impl.connect();
    });
    return {
      connect() {
        /* 就绪由模块接管（见上） */
      },
      send(data) {
        impl?.send(data);
      },
      close() {
        impl?.close();
      },
    };
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, undefined, createInitialSessionState);
  const clientRef = useRef<HelixWsClient | null>(null);
  const generatingRef = useRef(false);
  generatingRef.current = selectIsGenerating(state);

  if (clientRef.current === null) {
    // prod define 摇除：FAKE_TRANSPORT_DEFINE 构建期为 "" 字面量 → 本比较折叠
    // 为 false → fakeTransportScript() 调用点消除 → fake 模块动态 import 站点
    // treeshake（生产 bundle 零 mock 代码路径，T4.4 验收项）。
    const fakeScript = FAKE_TRANSPORT_DEFINE !== "" ? fakeTransportScript() : null;
    clientRef.current = new HelixWsClient({
      port: DAEMON_PORT,
      // mock mode 标准注入点（T4.4）：经既有 TransportFactory 接缝注入 fake
      // transport（env/URL 双形态解析见 env.fakeTransportScript）
      ...(fakeScript !== null ? { transportFactory: fakeTransportEntry(fakeScript) } : {}),
    });
  }

  useEffect(() => {
    const client = clientRef.current!;
    // ts 随 action 注入（重放确定性：同序列同帧；channel 时间戳展示面，T4.3）
    const offFrame = client.onFrame((event) => dispatch({ type: "event", event, ts: Date.now() }));
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

  const consumeKillToast = useCallback(
    () => dispatch({ type: "ui/consume-kill-toast" }),
    [],
  );

  const sendAgentCommand = useCallback(
    (type: "agent.kill" | "agent.subscribe" | "agent.unsubscribe", agentId: string) => {
      clientRef.current!.send({ v: PROTOCOL_VERSION, type, payload: { agentId } });
    },
    [],
  );

  const killInstance = useCallback((agentId: string) => sendAgentCommand("agent.kill", agentId), [sendAgentCommand]);
  const subscribeInstance = useCallback(
    (agentId: string) => sendAgentCommand("agent.subscribe", agentId),
    [sendAgentCommand],
  );
  const unsubscribeInstance = useCallback(
    (agentId: string) => sendAgentCommand("agent.unsubscribe", agentId),
    [sendAgentCommand],
  );

  const devDispatchEvent = useCallback((event: EventEnvelope) => {
    if (!isDev()) return; // prod 零路径（演示控件门控）
    dispatch({ type: "event", event, ts: Date.now() });
  }, []);

  const value = useMemo(
    () => ({
      state,
      setDraft,
      submit,
      retry,
      consumeRestoreToast,
      consumeSpawnToast,
      consumeKillToast,
      killInstance,
      subscribeInstance,
      unsubscribeInstance,
      devDispatchEvent,
    }),
    [
      state,
      setDraft,
      submit,
      retry,
      consumeRestoreToast,
      consumeSpawnToast,
      consumeKillToast,
      killInstance,
      subscribeInstance,
      unsubscribeInstance,
      devDispatchEvent,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
