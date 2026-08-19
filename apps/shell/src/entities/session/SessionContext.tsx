/**
 * entities/session —— 会话上下文（store 拓扑 reducer × WS 客户端接线）。
 *
 * 拓扑（AD-3 §3.4，T3.1）：TopologyState = 活跃会话完整 store（state 字段，
 * 既有消费面零改动）× 后台会话轻量 store × 会话清单。帧经 dispatcher
 * （dispatchFrame）按信封 sessionId 路由；v0.3（T3.2，契约 v0.3 §2）订阅
 * 生命周期 = 全图订阅模型：启动 list 后活跃 full + 其余全部 monitor /
 * created 补订 monitor / deleted 退订 / 切换先升后降（subscribe(new,full)
 * ack——session.snapshot 帧——后才 subscribe(old,monitor)，瞬时双 full）/
 * 断连重连重放全订阅图（helix-ws onReconnect 挂点）。簿记归
 * model/subscription-ledger（纯函数可单测）；daemon 对每次 subscribe 重推
 * 快照，monitor 档 ack 快照经 ledger 判定吞帧（不进 dispatcher 防串台）。
 *
 * 发送语义按生成态自动分流：空闲 → chat.send（气泡由 daemon 事件投影）；
 * 生成中 → chat.steer（本地 echo + STEER 徽标）。v0.2 起命令带信封
 * sessionId（活跃会话）；无会话上下文（草稿）首条消息 = draft:true +
 * 无信封 sessionId（契约 B §1.5）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import { PROTOCOL_VERSION } from "@helix/protocol";
import type { CommandEnvelope, EventEnvelope, TraceQueryPayload } from "@helix/protocol";
import { HelixWsClient } from "@/shared/api/helix-ws";
import type { Transport, TransportFactory } from "@/shared/api/helix-ws";
import {
  authDeleteKeyCommand,
  authListCommand,
  authSetKeyCommand,
  authVerifyCommand,
  chatAbortCommand,
  chatSendCommand,
  chatSendDraftCommand,
  chatSteerCommand,
  modelCatalogCommand,
  modelCatalogRefreshCommand,
  modelGetDefaultCommand,
  modelSetCommand,
  modelSetDefaultCommand,
  sessionDeleteCommand,
  sessionListCommand,
  sessionLoadHistoryCommand,
  traceQueryCommand,
} from "@/shared/api/commands";
import { DAEMON_PORT, FAKE_TRANSPORT_DEFINE, fakeTransportScript } from "@/shared/config/env";
import {
  createInitialTopologyState,
  selectCanLoadEarlier,
  topologyReducer,
  type TopologyState,
} from "./model/topology";
import { SubscriptionLedger } from "./model/subscription-ledger";
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
  /** 抽屉定向 steer（CL-3 F(3.3).3，契约 v0.3 §3.3）：chat.steer 携带
   *  instanceId 定向寻址 + 本地 echo 双投影（主轴细条 + 实例 channel 标记）；
   *  发送即清空无阻塞态——失败回执（connection.error）走既有错误提示通道 */
  steerInstance: (text: string, instanceId: string) => void;
  // ── model / auth 命令面板（契约 C；T3.3 P-3/P-4）──
  /** 会话模型运行期切换（P-3 选中即切 / 重置为默认；下一 turn 生效）。 */
  setSessionModel: (model: string) => void;
  /** 目录 + 全局默认拉取（P-3 打开 / P-4 进入；未请求态才发，重复打开零重发）。 */
  requestModelConfig: () => void;
  /** provider 凭据清单拉取（P-4 进入；auth.list 全局命令）。 */
  requestAuthList: () => void;
  /** 目录强制刷新（P-4 刷新按钮；绕过 4h 缓存）。 */
  refreshModelCatalog: () => void;
  /** 全局默认写入（P-4 选择器；乐观更新 + 回执锁定）。 */
  setDefaultModel: (model: string) => void;
  /** 连通验证（P-4 测试连通；started 先清旧态）。 */
  verifyProvider: (providerId: string) => void;
  /** key 保存（P-4 弹层；写 ~/.helix/auth.json）。 */
  setProviderKey: (providerId: string, apiKey: string) => void;
  /** key 删除（P-4 两段式二击；回执后转未配置）。 */
  deleteProviderKey: (providerId: string) => void;
  // ── trace 查询面（CL-5，T2.2；连接私有读面）──
  /** 发送 trace.query（点对点回执；send 失败返回 false）。单飞纪律在页面侧。 */
  sendTraceQuery: (payload: TraceQueryPayload) => boolean;
  /** 订阅 trace 族点对点回执（trace.query.result；另转发 connection.error
   *  供在途查询错误态判定——关联靠页面单飞：仅在 pending 非空时消费）。 */
  subscribeTraceFrames: (listener: (e: EventEnvelope) => void) => () => void;
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
  // v0.3 订阅图簿记（T3.2）：全图订阅生命周期唯一权威（见 model/subscription-ledger）
  const ledgerRef = useRef<SubscriptionLedger | null>(null);
  if (ledgerRef.current === null) ledgerRef.current = new SubscriptionLedger();
  const generatingRef = useRef(false);
  generatingRef.current = selectIsGenerating(topology.active);
  // trace 族点对点回执订阅表（T2.2；页面私有消费，不进会话 store）
  const traceListenersRef = useRef(new Set<(e: EventEnvelope) => void>());

  if (clientRef.current === null) {
    // prod define 摇除：FAKE_TRANSPORT_DEFINE 构建期为 "" 字面量 → 本比较折叠
    // 为 false → fakeTransportScript() 调用点消除 → fake 模块动态 import 站点
    // treeshake（生产 bundle 零 mock 代码路径，T4.4 验收项）。
    const fakeScript = FAKE_TRANSPORT_DEFINE !== "" ? fakeTransportScript() : null;
    clientRef.current = new HelixWsClient({
      port: DAEMON_PORT,
      // 重连挂点（TR-AD-5）：daemon 不持跨连接订阅状态 → 重放全订阅图
      // （幂等 subscribe 天然收敛；侧栏 session.list 重拉后 syncList 兜底对齐）
      onReconnect: () => {
        const ledger = ledgerRef.current!;
        for (const cmd of ledger.replay()) {
          clientRef.current!.send(cmd);
        }
      },
      // mock mode 标准注入点（T4.4）：经既有 TransportFactory 接缝注入 fake
      // transport（env/URL 双形态解析见 env.fakeTransportScript）
      ...(fakeScript !== null ? { transportFactory: fakeTransportEntry(fakeScript) } : {}),
    });
  }

  useEffect(() => {
    const client = clientRef.current!;
    // v0.3 订阅生命周期副作用（T3.2）：帧 → ledger 簿记/出站命令 → 吞帧判定
    // → dispatch。返 true = monitor 档 ack 快照（纯回执噪声，不进 dispatcher）。
    const applySubscriptionSideEffects = (event: EventEnvelope): boolean => {
      const ledger = ledgerRef.current!;
      const sendAll = (cmds: readonly CommandEnvelope[]) => {
        for (const c of cmds) client.send(c);
      };
      switch (event.type) {
        case "session.list.result":
          // 启动/重连全图订阅（活跃 full 先行 + 其余 monitor + 清单外退订）
          sendAll(ledger.syncList(event.payload.sessions.map((s) => s.sessionId)));
          return false;
        case "session.list_changed": {
          const { kind, sessionId } = event.payload;
          if (typeof sessionId !== "string" || sessionId === "") return false;
          if (kind === "created") sendAll(ledger.addCreated(sessionId)); // 补订 monitor
          else if (kind === "deleted") sendAll(ledger.removeDeleted(sessionId)); // 退订
          return false;
        }
        case "session.snapshot": {
          // 快照 = subscribe 回执（ack）：先升后降收口 / 激活升档 / monitor 档吞帧
          const sid = typeof event.sessionId === "string" ? event.sessionId : event.payload.snapshot.sessionId;
          const verdict = ledger.onSnapshot(sid);
          sendAll(verdict.commands);
          return !verdict.dispatch;
        }
        default:
          return false;
      }
    };
    // ts 随 action 注入（重放确定性：同序列同帧；channel 时间戳展示面，T4.3）
    const offFrame = client.onFrame((event) => {
      if (applySubscriptionSideEffects(event)) return; // 吞帧（monitor 档 ack 快照）
      // trace 族点对点回执转发（T2.2）：页面私有 reducer 消费；dispatcher 侧
      // 保持 no-op 注册（守护绿），会话 store 零写入
      if (event.type === "trace.query.result" || event.type === "connection.error") {
        for (const l of traceListenersRef.current) l(event);
      }
      dispatch({ type: "event", event, ts: Date.now() });
    });
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
    // v0.3 先升后降（契约 §2.3 / Q-2b③）：subscribe(new, full) 立即发；旧活跃
    // 降档 subscribe(old, monitor) 挂起至 ack（session.snapshot 帧到达，见
    // 上方 onFrame 快照分支）——瞬时双 full 窗口内旧会话帧不丢。subscribe
    // 触发 daemon 重推目标全量快照（尾窗）→ loading 骨架转 success（P-1s）
    for (const cmd of ledgerRef.current!.switchTo(sessionId)) {
      clientRef.current!.send(cmd);
    }
    dispatch({ type: "session/switch-started", sessionId });
  }, []);

  const newDraft = useCallback(() => {
    const prev = topologyRef.current.active.sessionId;
    if (prev === null) return; // 已在草稿：原样（无帧无动作）
    // 旧活跃即降 monitor（v0.3：后台照跑 + 未读徽标语义；取代旧 unsubscribe）
    for (const cmd of ledgerRef.current!.newDraft()) {
      clientRef.current!.send(cmd);
    }
    dispatch({ type: "session/new-draft" });
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    // daemon 顺序：取消全部执行 → 删库 → list_changed{deleted}（前端零权威：
    // 卡片移除由事件驱动）；删的是活跃会话 → 本地先切草稿态（原型 F(1.2).4：
    // 视图即转空态，不等事件）
    if (topologyRef.current.active.sessionId === sessionId) {
      ledgerRef.current!.dropActive(); // 订阅簿记活跃位置零（退订归 deleted 帧驱动）
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

  // trace 查询面（T2.2；连接私有读面——直发命令 + 订阅点对点回执）
  const sendTraceQuery = useCallback(
    (payload: TraceQueryPayload) => clientRef.current!.send(traceQueryCommand(payload)),
    [],
  );
  const subscribeTraceFrames = useCallback((listener: (e: EventEnvelope) => void) => {
    traceListenersRef.current.add(listener);
    return () => {
      traceListenersRef.current.delete(listener);
    };
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

  // 抽屉定向 steer（CL-3）：echo 先进共享 store（双处立即可见）再发出站帧；
  // 草稿无会话上下文 = 零帧零动作（抽屉在正常流中不会处于草稿态，防御分支）
  const steerInstance = useCallback((raw: string, instanceId: string) => {
    const text = raw.trim();
    if (text === "") return;
    const { sessionId } = topologyRef.current.active;
    if (sessionId === null) return;
    dispatch({ type: "ui/steer-instance", text, instanceId, ts: Date.now() });
    clientRef.current!.send(chatSteerCommand(text, sessionId, instanceId));
  }, []);

  // ── model / auth 命令面板（T3.3）：命令发送同刻 dispatch started action
  //（in-flight 锁定 + 乐观面；结果帧到达由 model-config 消费者接管）──
  const setSessionModel = useCallback((model: string) => {
    const { sessionId } = topologyRef.current.active;
    if (sessionId === null) return; // 草稿无会话上下文：零帧零动作
    clientRef.current!.send(modelSetCommand(model, sessionId));
  }, []);

  const requestModelConfig = useCallback(() => {
    const mc = topologyRef.current.modelConfig;
    if (mc.catalog === null) clientRef.current!.send(modelCatalogCommand());
    if (mc.defaultModel === "") clientRef.current!.send(modelGetDefaultCommand());
  }, []);

  const requestAuthList = useCallback(() => {
    clientRef.current!.send(authListCommand());
  }, []);

  const refreshModelCatalog = useCallback(() => {
    if (topologyRef.current.modelConfig.catalogRefreshing) return; // 在途去重
    dispatch({ type: "model/catalog-refresh-started" });
    clientRef.current!.send(modelCatalogRefreshCommand());
  }, []);

  const setDefaultModel = useCallback((model: string) => {
    dispatch({ type: "model/set-default-started", model }); // 乐观更新（选择器即时反映）
    clientRef.current!.send(modelSetDefaultCommand(model));
  }, []);

  const verifyProvider = useCallback((providerId: string) => {
    dispatch({ type: "model/verify-started", providerId }); // 先清旧态置 verifying
    clientRef.current!.send(authVerifyCommand(providerId));
  }, []);

  const setProviderKey = useCallback((providerId: string, apiKey: string) => {
    dispatch({ type: "model/set-key-started", providerId });
    clientRef.current!.send(authSetKeyCommand(providerId, apiKey));
  }, []);

  const deleteProviderKey = useCallback((providerId: string) => {
    dispatch({ type: "model/delete-key-started", providerId });
    clientRef.current!.send(authDeleteKeyCommand(providerId));
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
      steerInstance,
      setSessionModel,
      requestModelConfig,
      requestAuthList,
      refreshModelCatalog,
      setDefaultModel,
      verifyProvider,
      setProviderKey,
      deleteProviderKey,
      sendTraceQuery,
      subscribeTraceFrames,
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
      steerInstance,
      setSessionModel,
      requestModelConfig,
      requestAuthList,
      refreshModelCatalog,
      setDefaultModel,
      verifyProvider,
      setProviderKey,
      deleteProviderKey,
      sendTraceQuery,
      subscribeTraceFrames,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
