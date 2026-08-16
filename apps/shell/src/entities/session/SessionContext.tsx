/**
 * entities/session —— 会话上下文（store 拓扑 reducer × WS 客户端接线）。
 *
 * 拓扑（AD-3 §3.4，T3.1）：TopologyState = 活跃会话完整 store（state 字段，
 * 既有消费面零改动）× 后台会话轻量 store × 会话清单。帧经 dispatcher
 * （dispatchFrame）按信封 sessionId 路由；切换 = unsubscribe 旧 + subscribe
 * 新（契约 B §1.2 定稿形态——daemon subscribeSession 为订阅集累加，须显式
 * 退订旧会话）+ 目标尾窗重建（P-1s 两阶段）。
 *
 * 发送语义按生成态自动分流：空闲 → chat.send（气泡由 daemon 事件投影）；
 * 生成中 → chat.steer（本地 echo + STEER 徽标）。v0.2 起命令带信封
 * sessionId（活跃会话）；无会话上下文（草稿）首条消息 = draft:true +
 * 无信封 sessionId（契约 B §1.5）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import { HelixWsClient } from "@/shared/api/helix-ws";
import type { Transport, TransportFactory } from "@/shared/api/helix-ws";
import {
  chatAbortCommand,
  chatSendCommand,
  chatSendDraftCommand,
  chatSteerCommand,
  sessionDeleteCommand,
  sessionListCommand,
  sessionLoadHistoryCommand,
  sessionSubscribeCommand,
  sessionUnsubscribeCommand,
} from "@/shared/api/commands";
import { DAEMON_PORT, FAKE_TRANSPORT_DEFINE, fakeTransportScript, isDev } from "@/shared/config/env";
import {
  createInitialTopologyState,
  selectCanLoadEarlier,
  topologyReducer,
  type TopologyState,
} from "./model/topology";
import {
  selectIsGenerating,
  type SessionState,
} from "./model/session-reducer";

export type { ConnState, SessionState, StreamingState } from "./model/session-reducer";
export {
  selectCanSend,
  selectIsEmpty,
  selectIsGenerating,
} from "./model/session-reducer";
export { selectCanLoadEarlier } from "./model/topology";
export type { BackgroundSessionState, TopologyState } from "./model/topology";

interface SessionContextValue {
  /** 活跃会话完整 store（既有消费面；= topology.active） */
  state: SessionState;
  /** store 拓扑（后台轻量 store / 会话清单——T3.2 侧栏消费面） */
  topology: TopologyState;
  setDraft: (text: string) => void;
  /** 提交输入：生成中自动转 steer（F(7).3），否则 chat.send（草稿 = draft:true 建会话） */
  submit: (text: string) => void;
  /** 失败卡「重试连接」（仅 error 态有意义；SM-2 手动重试路径） */
  retry: () => void;
  /** 中断当前生成（chat.abort 信封 sessionId；T3.2 停止按钮消费） */
  abort: () => void;
  /** 切换会话（unsubscribe 旧 + subscribe 新 + 尾窗重建 loading→success） */
  switchSession: (sessionId: string) => void;
  /** 新建草稿（F(1.2).1）：unsubscribe 旧会话 + 活跃 store 置草稿态（零建会话
   *  帧——首条消息发送时才 chat.send{draft:true}）；旧会话转后台照常执行 */
  newDraft: () => void;
  /** 删除会话（F(1.2).4）：发 session.delete（daemon 取消全部执行 → 删库 →
   *  list_changed{deleted}）；删活跃会话则本地先切草稿态（视图即转空态） */
  deleteSession: (sessionId: string) => void;
  /** 滚动到顶加载更早历史（selectCanLoadEarlier 门控；发 session.loadHistory） */
  loadEarlierHistory: () => void;
  /** 拉取会话清单（session.list 全局命令；结果 = session.list.result 点对点回推） */
  requestSessionList: () => void;
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
  // v0.2（T3.1）：useReducer 挂拓扑根——帧经 dispatcher 按 sessionId 路由
  //（活跃完整 store / 后台轻量 store / 系统帧）；conn/ui action 透传活跃 store
  const [topology, dispatch] = useReducer(topologyReducer, undefined, createInitialTopologyState);
  const clientRef = useRef<HelixWsClient | null>(null);
  // 命令构造读点（发送面需要当前活跃会话 id / 分页游标；避免 effect 链）
  const topologyRef = useRef(topology);
  topologyRef.current = topology;
  const generatingRef = useRef(false);
  generatingRef.current = selectIsGenerating(topology.active);

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
    const { sessionId } = topologyRef.current.active;
    if (mode === "steer") {
      // 生成中注入：活跃会话信封（理论上必有会话；防御性缺省 = daemon 当前会话）
      clientRef.current!.send(
        sessionId !== null
          ? chatSteerCommand(text, sessionId)
          : { v: PROTOCOL_VERSION, type: "chat.steer", payload: { text } },
      );
    } else if (sessionId === null) {
      // 草稿首条消息（契约 B §1.5）：无信封 sessionId + draft:true →
      // daemon 建聚合 + list_changed{created} + 订阅切换 + 新会话快照回推
      clientRef.current!.send(chatSendDraftCommand(text));
    } else {
      clientRef.current!.send(chatSendCommand(text, sessionId));
    }
  }, []);

  const retry = useCallback(() => {
    dispatch({ type: "conn/manual-retry" });
    clientRef.current!.retry();
  }, []);

  const abort = useCallback(() => {
    const { sessionId } = topologyRef.current.active;
    if (sessionId !== null) clientRef.current!.send(chatAbortCommand(sessionId));
  }, []);

  const switchSession = useCallback((sessionId: string) => {
    const prev = topologyRef.current.active.sessionId;
    if (prev === sessionId) return;
    // 契约 B §1.2 定稿：unsubscribe 旧 + subscribe 新（daemon subscribeSession
    // 为订阅集累加，不显式退订会继续收旧会话帧）；subscribe 触发 daemon 重推
    // 目标会话全量快照（尾窗）——loading 骨架随之转 success（P-1s 两阶段）
    if (prev !== null) clientRef.current!.send(sessionUnsubscribeCommand(prev));
    clientRef.current!.send(sessionSubscribeCommand(sessionId));
    dispatch({ type: "session/switch-started", sessionId });
  }, []);

  const newDraft = useCallback(() => {
    const prev = topologyRef.current.active.sessionId;
    if (prev === null) return; // 已在草稿：原样（无帧无动作）
    // 退订旧会话（不再收帧；后台轻量 store 由清单元数据 + 广播驱动）
    clientRef.current!.send(sessionUnsubscribeCommand(prev));
    dispatch({ type: "session/new-draft" });
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    // daemon 顺序：取消全部执行 → 删库 → list_changed{deleted}（前端零权威：
    // 卡片移除由事件驱动）；删的是活跃会话 → 本地先切草稿态（原型 F(1.2).4：
    // 视图即转空态，不等事件）
    if (topologyRef.current.active.sessionId === sessionId) {
      dispatch({ type: "session/new-draft" });
    }
    clientRef.current!.send(sessionDeleteCommand(sessionId));
  }, []);

  const loadEarlierHistory = useCallback(() => {
    const active = topologyRef.current.active;
    if (!selectCanLoadEarlier(active)) return; // hasMore=false 禁用 / 在途去重
    const cursor = active.history.nextCursor;
    if (cursor === null || active.sessionId === null) return;
    clientRef.current!.send(sessionLoadHistoryCommand(active.sessionId, cursor));
    dispatch({ type: "ui/load-earlier" });
  }, []);

  const requestSessionList = useCallback(() => {
    clientRef.current!.send(sessionListCommand());
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

  const state = topology.active;
  const value = useMemo(
    () => ({
      state,
      topology,
      setDraft,
      submit,
      retry,
      abort,
      switchSession,
      newDraft,
      deleteSession,
      loadEarlierHistory,
      requestSessionList,
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
      topology,
      setDraft,
      submit,
      retry,
      abort,
      switchSession,
      newDraft,
      deleteSession,
      loadEarlierHistory,
      requestSessionList,
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
