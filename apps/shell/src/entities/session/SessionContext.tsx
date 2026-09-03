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
 *
 * M38 注册表化：命令/订阅面收敛为 command-surface.ts 两注册表
 * （COMMAND_SURFACE / LISTEN_SURFACE）——方法实现按域声明在注册表项内，
 * SessionContextValue 面类型由注册表键派生，provider 一次性构建整面摊入
 * context value。注册表项 = 唯一登记点：新增域命令不存在漏登 value 对象 /
 * 漏登 deps 数组的结构性缺陷面（原 sendKgCandidatesList 漏 deps 类缺陷由
 * 结构本身免疫）。
 */
import { createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import type { CommandEnvelope, EventEnvelope } from "@helix/protocol";
import { HelixWsClient } from "@/shared/api/helix-ws";
import type { Transport, TransportFactory } from "@/shared/api/helix-ws";
import { agentConfigListCommand, thinkingSetCommand, webStatusCommand } from "@/shared/api/commands";
import { DAEMON_PORT, FAKE_TRANSPORT_DEFINE, fakeTransportScript } from "@/shared/config/env";
import {
  createInitialTopologyState,
  topologyReducer,
  type TopologyState,
} from "./model/topology";
import { SubscriptionLedger } from "./model/subscription-ledger";
import {
  selectIsGenerating,
  type SessionState,
} from "./model/session-reducer";
import {
  buildCommandSurface,
  LISTEN_SURFACE,
  type CommandSurface,
  type FrameListener,
  type ListenDomain,
  type ListenSurface,
} from "./command-surface";

export type { ConnState, SessionState, StreamingState } from "./model/session-reducer";
export {
  selectCanSend,
  selectIsEmpty,
  selectIsGenerating,
} from "./model/session-reducer";
export { selectCanLoadEarlier } from "./model/topology";
export type { BackgroundSessionState, TopologyState } from "./model/topology";

interface SessionContextValue extends CommandSurface, ListenSurface {
  /** 活跃会话完整 store（既有消费面；= topology.active） */
  state: SessionState;
  /** store 拓扑（后台轻量 store / 会话清单——T3.2 侧栏消费面） */
  topology: TopologyState;
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
  // M38：连接私有回执/广播域听众集——按 LISTEN_SURFACE 注册表键一次建齐
  //（trace / agent.config / kg / task / workspace；页面私有消费，不进会话 store）
  const listenerSetsRef = useRef<Record<ListenDomain, Set<FrameListener>> | null>(null);
  if (listenerSetsRef.current === null) {
    listenerSetsRef.current = Object.fromEntries(
      (Object.keys(LISTEN_SURFACE) as ListenDomain[]).map((k) => [k, new Set<FrameListener>()]),
    ) as Record<ListenDomain, Set<FrameListener>>;
  }

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

  // M38：命令面一次性构建（deps 全经 ref 间接取值，产物引用天然稳定——
  // 原实现全部 useCallback 零 deps 的结构性收权；注册表项即唯一登记点）
  const commandSurfaceRef = useRef<CommandSurface | null>(null);
  if (commandSurfaceRef.current === null) {
    commandSurfaceRef.current = buildCommandSurface({
      send: (cmd) => clientRef.current!.send(cmd),
      dispatch,
      getTopology: () => topologyRef.current,
      getLedger: () => ledgerRef.current!,
      isGenerating: () => generatingRef.current,
      retryConnection: () => clientRef.current!.retry(),
    });
  }
  // M38：订阅面按注册表键派生（listener 入/出本域听众集；引用稳定）
  const listenSurface = useMemo(() => {
    const out = {} as Record<ListenDomain, (listener: FrameListener) => () => void>;
    for (const key of Object.keys(LISTEN_SURFACE) as ListenDomain[]) {
      out[key] = (listener) => {
        const set = listenerSetsRef.current![key];
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      };
    }
    return out as ListenSurface;
  }, []);

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
        case "connection.welcome": {
          // welcome 活跃习得（list 抢跑竞态防线）：welcome 载荷带 daemon 当前会话
          // （握手 attach 即 full）——无活跃位时习得（与 conn 消费者 sessionId 习得
          // 对称）。防 hello 的冷会话快照组装（await getSessionView）期间
          // session.list 插队先回：syncList 无活跃可依把活跃会话打成 monitor，
          // 随后 attach 快照被当 ack 噪声吞掉 → 活跃会话永久 monitor
          // （thinking/tool/stream 增量全被档位过滤，phase 光点永远兜底「工作中」）。
          if (
            event.payload.draft !== true &&
            typeof event.payload.sessionId === "string" &&
            event.payload.sessionId !== ""
          ) {
            sendAll(ledger.learnAttached(event.payload.sessionId));
          }
          return false; // welcome 仍进 dispatcher（conn 消费者承接）
        }
        default:
          return false;
      }
    };
    // ts 随 action 注入（重放确定性：同序列同帧；channel 时间戳展示面，T4.3）
    const offFrame = client.onFrame((event) => {
      if (applySubscriptionSideEffects(event)) return; // 吞帧（monitor 档 ack 快照）
      // M38：连接私有回执/广播按 LISTEN_SURFACE 注册表驱动转发（声明顺序 =
      // trace → agent.config → kg → task → workspace）——页面私有 reducer
      // 消费；dispatcher 侧保持 no-op 注册（守护绿）或拓扑级直通，会话 store
      // 零写入。trace.query.result 先例：trace/kg/task/workspace 域附转
      // connection.error（在途错误判定靠页面单飞门控）。
      for (const [key, spec] of Object.entries(LISTEN_SURFACE)) {
        if (spec.match(event.type)) {
          for (const l of listenerSetsRef.current![key as ListenDomain]) l(event);
        }
      }
      // 草稿 thinking 暂存转正（thinking 批①，draft-model 先例对齐；T2.1）：
      // chat.send 零字段负断言（AD-4①）使覆盖无法随首条上送——草稿态经
      // ui/set-draft-thinking 本地暂存，建会话快照到达后补发 thinking.set，
      // 生效回执 = thinking.changed 广播（快照 thinking 读面权威收权归
      // snapshot 消费者）
      if (event.type === "session.snapshot") {
        const prev = topologyRef.current.active;
        const staged = prev.sessionId === null ? prev.thinking.override : null;
        dispatch({ type: "event", event, ts: Date.now() });
        if (staged !== null) {
          client.send(thinkingSetCommand(staged, event.payload.snapshot.sessionId));
        }
        return;
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

  // T4 web 族（契约 v0.7）：连接就绪即发一次 web.status 查询拿初值
  //（IconRail 联网钮首态数据源；重连随 conn 迁移重发——断连期间 daemon
  // 侧状态可能已变，广播只覆盖变更时机）。后续变更走 web.status.changed
  // 广播拓扑级消费，无需轮询。
  const conn = topology.active.conn;
  useEffect(() => {
    if (conn === "connected") {
      clientRef.current!.send(webStatusCommand());
      // P1 T4 槽位读面初拉（topology 级 slots 数据源——草稿徽标链/刻度基准
      // 第二级回退；重连随 conn 迁移重发，daemon 侧配置可能已变）
      clientRef.current!.send(agentConfigListCommand());
    }
  }, [conn]);

  // P1 T4 槽位读面失效重拉：agent.config.changed 广播 → revision +1 → 重发
  // agent.config.list 拿新鲜 slots（结果帧拓扑级收口）。初始 revision=0
  // 零动作——首拉已由上方连接就绪效应覆盖。命令幂等，与智能体页拉取互不
  // 干扰（同帧两消费者各取所需）。
  const agentConfigRevision = topology.agentConfig.revision;
  useEffect(() => {
    if (agentConfigRevision === 0) return;
    clientRef.current!.send(agentConfigListCommand());
  }, [agentConfigRevision]);

  const state = topology.active;
  // M38：value = 数据面（state/topology）+ 注册表构建的命令/订阅面整面摊入；
  // deps 收敛为 [state, topology, listenSurface]（命令面 ref 恒定）——注册表
  // 项与 value 键一致性由守护测试钉死（SessionContext.surface.test.tsx）。
  const value = useMemo(
    () => ({
      state,
      topology,
      ...commandSurfaceRef.current!,
      ...listenSurface,
    }),
    [state, topology, listenSurface],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
