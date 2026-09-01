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
import type { AgentConfigSetEnabledPayload } from "@helix/protocol";
import type {
  KgBootstrapCreatePayload,
  KgBootstrapImpactPayload,
  KgGraphPurgePayload,
  KgHealthPayload,
  KgIndexDeletePayload,
  KgBootstrapProducePayload,
  KgChangeReportPayload,
  KgIndexStatusPayload,
  KgReviewCreatePayload,
  KgListPayload,
  KgNodeConfirmPayload,
  KgNodeDetailPayload,
  KgNodeSupersedePayload,
  KgNodeUpdatePayload,
  TaskArtifactsPayload,
  TaskDetailPayload,
  TaskListPayload,
} from "@helix/protocol";
import { HelixWsClient } from "@/shared/api/helix-ws";
import type { Transport, TransportFactory } from "@/shared/api/helix-ws";
import {
  agentConfigListCommand,
  agentConfigSetEnabledCommand,
  authDeleteKeyCommand,
  authListCommand,
  authSetKeyCommand,
  authVerifyCommand,
  chatAbortCommand,
  chatSendCommand,
  chatSendDraftCommand,
  chatSteerCommand,
  kgChangeReportCommand,
  kgGraphPurgeCommand,
  kgHealthCommand,
  kgIndexDeleteCommand,
  kgReviewCreateCommand,
  kgIndexStatusCommand,
  kgListCommand,
  kgNodeConfirmCommand,
  kgNodeDetailCommand,
  kgBootstrapCreateCommand,
  kgBootstrapImpactCommand,
  kgBootstrapProduceCommand,
  kgNodeSupersedeCommand,
  kgNodeUpdateCommand,
  kgProjectsCommand,
  modelCatalogCommand,
  modelCatalogRefreshCommand,
  modelGetDefaultCommand,
  modelSetCommand,
  modelSetDefaultCommand,
  modelSetThinkingDefaultCommand,
  sessionDeleteCommand,
  sessionListCommand,
  sessionLoadHistoryCommand,
  taskArtifactsCommand,
  taskCancelCommand,
  taskDeleteCommand,
  taskDetailCommand,
  taskListCommand,
  taskPauseCommand,
  taskResumeCommand,
  taskSubscribeCommand,
  taskUnsubscribeCommand,
  thinkingSetCommand,
  traceQueryCommand,
  webStatusCommand,
  webStartCommand,
  webStopCommand,
  workspaceGetCommand,
  workspaceOpenCommand,
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
  /** 提交输入：生成中自动转 steer（F(7).3），否则 chat.send（草稿 = draft:true 建会话）。
   *  T9（v0.10）：images 可选（base64 data URL，≤4 张）——仅 turn 模式透传
   *  chat.send；steer 带图非目标（生成中附件钮禁用，防御性忽略）。 */
  submit: (text: string, images?: string[]) => void;
  /** 图片附件入草稿（T9）：chips 预览数据源；≤4 上限预检在组件侧 */
  attachImages: (images: string[]) => void;
  /** 移除第 index 张附件（T9；chips 移除钮） */
  removeAttachment: (index: number) => void;
  /** 失败卡「重试连接」（仅 error 态有意义；SM-2 手动重试路径） */
  retry: () => void;
  /** 中断当前生成（chat.abort 信封 sessionId；T3.2 停止按钮消费） */
  abort: () => void;
  /** 切换会话（unsubscribe 旧 + subscribe 新 + 尾窗重建 loading→success） */
  switchSession: (sessionId: string) => void;
  /** 新建草稿（F(1.2).1）：unsubscribe 旧会话 + 活跃 store 置草稿态（零建会话
   *  帧——首条消息发送时才 chat.send{draft:true}）；旧会话转后台照常执行 */
  newDraft: () => void;
  /** 草稿模式切换（P1 T4；D3/D4 唯一写入口）：纯前端零 daemon 交互——
   *  ui/set-draft-mode 本地置 mode + 丢弃 draft model/thinking 暂存；
   *  mode 随首条 chat.send{draft:true, mode} 上送，建会话后快照收权锁定 */
  setDraftMode: (mode: string) => void;
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
  /** 会话 thinking 档覆盖（thinking 批①，T2.1 P-1 滑块选档；下一 turn 生效；
   *  草稿态本地暂存——draft-model 先例对齐，快照建会话后补发 thinking.set）。 */
  setSessionThinking: (level: string) => void;
  /** 目录 + 全局默认拉取（P-3 打开 / P-4 进入；未请求态才发，重复打开零重发）。 */
  requestModelConfig: () => void;
  /** provider 凭据清单拉取（P-4 进入；auth.list 全局命令）。 */
  requestAuthList: () => void;
  /** 目录强制刷新（P-4 刷新按钮；绕过 4h 缓存）。 */
  refreshModelCatalog: () => void;
  /** 全局默认写入（P-4 选择器；乐观更新 + 回执锁定）。 */
  setDefaultModel: (model: string) => void;
  /** R7：全局默认推理强度（null = 清除）。 */
  setThinkingDefault: (level: string | null) => void;
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
  // ── agent.config 查询/写面（M6 T4 智能体页；连接私有读面同构）──
  /** 发送 agent.config.list（全 kind；点对点回执；send 失败返回 false）。 */
  sendAgentConfigList: () => boolean;
  /** 发送 agent.config.set_enabled（回执 applied/skipped + applied 时
   *  agent.config.changed 广播 → 拓扑 revision 递增）。 */
  sendAgentConfigSetEnabled: (payload: AgentConfigSetEnabledPayload) => boolean;
  /** 订阅 agent.config 族点对点回执（list.result / set_enabled.result；
   *  changed 广播走拓扑级消费，不在此转发）。 */
  subscribeAgentConfigFrames: (listener: (e: EventEnvelope) => void) => () => void;
  // ── web 族联网状态面（T4，契约 v0.7；IconRail 联网钮）──
  /** 发送 web.stop（停止并清理；回执 applied + 状态回 idle 经
   *  web.status.changed 广播写 topology.webStatus）。 */
  sendWebStop: () => boolean;
  /** 发送 web.start（v0.9，T7 显式启动通路；回执 applied/skipped 点对点 +
   *  状态回 connected 经 web.status.changed 广播写 topology.webStatus）。 */
  sendWebStart: () => boolean;
  // ── kg 族六命令面（iter-20260825-11fo T5.4，P-1 图谱页；连接私有读面）──
  /** 发送 kg.projects（左栏项目列表；点对点回执；send 失败返回 false）。 */
  sendKgProjects: () => boolean;
  /** 发送 kg.list（节点列表+搜索；三路过滤可叠加）。 */
  sendKgList: (payload: KgListPayload) => boolean;
  /** 发送 kg.node.detail（六段聚合详情）。 */
  sendKgNodeDetail: (payload: KgNodeDetailPayload) => boolean;
  /** 发送 kg.change.report（知识变化报告；缺省当前迭代）。 */
  sendKgChangeReport: (payload: KgChangeReportPayload) => boolean;
  /** 发送 kg.node.confirm（页面唯一写：draft 转正；回执翻转后状态回读）。 */
  sendKgNodeConfirm: (payload: KgNodeConfirmPayload) => boolean;
  /** 发送 kg.index.status（索引四态；rebuild:true 触发构建，O-6 轮询通道）。 */
  sendKgIndexStatus: (payload: KgIndexStatusPayload) => boolean;
  // ── kg-bootstrap 批五命令面（iter-20260829-ys7q T3.2，/project 页 bootstrap 数据面）──
  /** 发送 kg.bootstrap.create（CL-1：后端准入复核 + createTask 同源 createdBy="page"）。 */
  sendKgBootstrapCreate: (payload: KgBootstrapCreatePayload) => boolean;
  /** 发送 kg.bootstrap.produce（CL-4 F4.1 产出三级分组读面）。 */
  sendKgBootstrapProduce: (payload: KgBootstrapProducePayload) => boolean;
  /** 发送 kg.node.update（CL-4 F4.2 修正写面一；保存即 updateNode 保持 confirmed）。 */
  sendKgNodeUpdate: (payload: KgNodeUpdatePayload) => boolean;
  /** 发送 kg.node.supersede（CL-4 F4.2 修正写面二；理由必填双防线）。 */
  sendKgNodeSupersede: (payload: KgNodeSupersedePayload) => boolean;
  /** 发送 kg.bootstrap.impact（CL-4 F4.3 连带只读推导；update/supersede 成功后刷新标记）。 */
  sendKgBootstrapImpact: (payload: KgBootstrapImpactPayload) => boolean;
  // ── kg 维护批两命令面（C1，契约 PROTOCOL.md §22）──
  /** 发送 kg.graph.purge（清空图谱；危险操作——UI 两步确认，daemon 门禁复核）。 */
  sendKgGraphPurge: (payload: KgGraphPurgePayload) => boolean;
  /** 发送 kg.index.delete（删除索引；停 watcher + 删 .codegraph + 状态复位 absent）。 */
  sendKgIndexDelete: (payload: KgIndexDeletePayload) => boolean;
  // ── kg.health 批 + kg 评审批命令面（W2-E 体检看板 / W2-F 轨二发起入口）──
  /** 发送 kg.health（五项读面聚合；只列不修零写路径，absent 短路空态）。 */
  sendKgHealth: (payload: KgHealthPayload) => boolean;
  /** 发送 kg.review.create（发起语义体检任务；准入从简 = 索引存在即可，允许反复发起）。 */
  sendKgReviewCreate: (payload: KgReviewCreatePayload) => boolean;
  /** 订阅 kg 族点对点回执（kg.*.result；O-6 零推送事件，回执全走此处）。 */
  subscribeKgFrames: (listener: (e: EventEnvelope) => void) => () => void;
  // ── task 族九命令面（iter-20260829-ys7q T3.1，P-2 任务页；连接私有读面）──
  /** 发送 task.list（全局平铺；服务端运行中置顶+创建时间倒序）。 */
  sendTaskList: (payload?: TaskListPayload) => boolean;
  /** 发送 task.detail（阶段条 + 批次 + 实例 plan + 叙述句）。 */
  sendTaskDetail: (payload: TaskDetailPayload) => boolean;
  /** 发送 task.artifacts（阶段产物只读投影）。 */
  sendTaskArtifacts: (payload: TaskArtifactsPayload) => boolean;
  /** 发送 task.subscribe（连接级订阅；缺省 = 订阅全部任务变更）。 */
  sendTaskSubscribe: () => boolean;
  /** 发送 task.unsubscribe（页面卸载语义位；当前无消费面，对称保留）。 */
  sendTaskUnsubscribe: () => boolean;
  /** 发送 task.pause（仅 running→paused 合法）。 */
  sendTaskPause: (jobId: string) => boolean;
  /** 发送 task.resume（仅 paused→running）。 */
  sendTaskResume: (jobId: string) => boolean;
  /** 发送 task.cancel（pending/running/paused→cancelled 终态）。 */
  sendTaskCancel: (jobId: string) => boolean;
  /** 发送 task.delete（仅终态；清任务域记录不触 kg 产出）。 */
  sendTaskDelete: (jobId: string) => boolean;
  /** 订阅 task 族帧（task.*.result 点对点回执 + task.changed 广播 +
   *  connection.error——生命周期在途错误判定，页面单飞门控消费）。 */
  subscribeTaskFrames: (listener: (e: EventEnvelope) => void) => () => void;
  // ── workspace 族门禁面（W3；契约 PROTOCOL.md §15.10/§16.10）──
  /** 发送 workspace.get（门禁读面；连接就绪自动发一次，重连重发——
   *  webStatus 先例。entities/workspace 状态机消费回执分流 main/gate）。 */
  sendWorkspaceGet: () => boolean;
  /** 发送 workspace.open（显式绑定写面；daemon 单点校验，失败回
   *  connection.error 结构化错误码供选择页行内展示）。 */
  sendWorkspaceOpen: (root: string) => boolean;
  /** 订阅 workspace 族帧（get/open 两结果帧 + workspace_changed 广播 +
   *  connection.error——open 在途时才消费，trace 单飞先例）。 */
  subscribeWorkspaceFrames: (listener: (e: EventEnvelope) => void) => () => void;
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
  const traceListenersRef = useRef(new Set<(e: EventEnvelope) => void>());  // agent.config 族点对点回执订阅表（M6 T4；智能体页私有消费，同 trace 形态）
  const agentConfigListenersRef = useRef(new Set<(e: EventEnvelope) => void>());
  // kg 族点对点回执听众（T5.4；页面私有 reducer 消费，会话 store 零写入）
  const kgListenersRef = useRef(new Set<(e: EventEnvelope) => void>());
  // task 族帧听众（T3.1；P-2 任务页私有消费：点对点回执 + changed 广播，
  // 同 kg 形态；错误回执 connection.error 一并转发——生命周期在途单飞门控）
  const taskListenersRef = useRef(new Set<(e: EventEnvelope) => void>());
  // workspace 族帧听众（W3 门禁状态机；entities/workspace 消费，同 kg 形态）
  const workspaceListenersRef = useRef(new Set<(e: EventEnvelope) => void>());

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
      // agent.config 族点对点回执转发（M6 T4）：智能体页页面查询链消费
      //（dispatcher 侧拓扑级直通不写态；changed 广播走拓扑 revision）
      if (event.type === "agent.config.list.result" || event.type === "agent.config.set_enabled.result") {
        for (const l of agentConfigListenersRef.current) l(event);
      }
      // kg 族点对点回执转发（T5.4）：P-1 图谱页页面私有链消费（全部为命令
      // 回执零广播，dispatcher 零写入）。T3.2 kg-bootstrap 批：connection.error
      // 一并转发（bootstrap 入口/写面在途错误判定靠页面单飞门控，task 族
      // 先例；既有 kg 听众对非 kg.*.result 帧均 default 直返不受影响）
      if (
        event.type === "connection.error" ||
        (event.type.startsWith("kg.") && event.type.endsWith(".result"))
      ) {
        for (const l of kgListenersRef.current) l(event);
      }
      // task 族帧转发（T3.1）：P-2 任务页私有链消费——点对点回执 +
      // task.changed 广播（订阅面按连接过滤在 daemon 侧）；connection.error
      // 一并转发（生命周期命令在途错误判定靠页面单飞门控，trace 先例）
      if (
        event.type === "task.changed" ||
        event.type === "connection.error" ||
        (event.type.startsWith("task.") && event.type.endsWith(".result"))
      ) {
        for (const l of taskListenersRef.current) l(event);
      }
      // workspace 族帧转发（W3 门禁）：两命令点对点回执 + changed 广播直转
      //（entities/workspace 状态机分流/跟随）；connection.error 另行转发
      //（open 在途时结构化错误码消费——听众侧 opening 单飞门控，trace 先例）
      if (
        event.type === "workspace.get.result" ||
        event.type === "workspace.open.result" ||
        event.type === "workspace_changed" ||
        event.type === "connection.error"
      ) {
        for (const l of workspaceListenersRef.current) l(event);
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

  const setDraft = useCallback((text: string) => dispatch({ type: "ui/set-draft", text }), []);

  // T9 图片附件草稿：入/出纯 UI 态（reducer 承载；发送时随 ui/send 清空）
  const attachImages = useCallback(
    (images: string[]) => dispatch({ type: "ui/attach-images", images }),
    [],
  );
  const removeAttachment = useCallback(
    (index: number) => dispatch({ type: "ui/remove-attachment", index }),
    [],
  );

  const submit = useCallback((raw: string, images?: string[]) => {
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
      // daemon 建聚合 + list_changed{created} + 订阅切换 + 新会话快照回推。
      // T3（bug4）：草稿所选模型（ui/set-draft-model 本地暂存）随首条上送；
      // 未选（空串）→ 不携带 model（daemon 用全局默认）。
      // P1 T4：草稿所选模式随首条上送；default 不带（协议缺省，减帧噪音）——
      // 构造器 chatSendDraftCommand 统一裁决
      const active = topologyRef.current.active;
      const draftModel = active.model;
      clientRef.current!.send(
        chatSendDraftCommand(
          text,
          draftModel === "" ? undefined : draftModel,
          images,
          active.mode,
        ),
      );
    } else {
      clientRef.current!.send(chatSendCommand(text, sessionId, images));
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

  // 草稿模式切换（P1 T4；D3/D4）：纯本地 action（零 daemon 交互）——reducer
  // 内裁决草稿态门控 + 丢弃 draft model/thinking 暂存；mode 传输出发送链
  const setDraftMode = useCallback(
    (mode: string) => dispatch({ type: "ui/set-draft-mode", mode }),
    [],
  );

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

  // agent.config 查询/写面（M6 T4；连接私有读面——直发命令 + 订阅点对点回执）
  const sendAgentConfigList = useCallback(() => clientRef.current!.send(agentConfigListCommand()), []);
  const sendAgentConfigSetEnabled = useCallback(
    (payload: AgentConfigSetEnabledPayload) => clientRef.current!.send(agentConfigSetEnabledCommand(payload)),
    [],
  );
  const subscribeAgentConfigFrames = useCallback((listener: (e: EventEnvelope) => void) => {
    agentConfigListenersRef.current.add(listener);
    return () => {
      agentConfigListenersRef.current.delete(listener);
    };
  }, []);

  // web 族联网状态面（T4，契约 v0.7）：停止并清理写面（读面初值见上方
  // 连接就绪 effect；变更走广播拓扑级消费 topology.webStatus）
  const sendWebStop = useCallback(() => clientRef.current!.send(webStopCommand()), []);

  // web.start 显式启动写面（v0.9，T7）：popover 启动钮回调（沿 sendWebStop 先例）
  const sendWebStart = useCallback(() => clientRef.current!.send(webStartCommand()), []);

  // kg 族六命令面（T5.4，P-1 图谱页；沿 trace 查询面先例：直发命令 + 订阅点对点回执）
  const sendKgProjects = useCallback(() => clientRef.current!.send(kgProjectsCommand()), []);
  const sendKgList = useCallback(
    (payload: KgListPayload) => clientRef.current!.send(kgListCommand(payload)),
    [],
  );
  const sendKgNodeDetail = useCallback(
    (payload: KgNodeDetailPayload) => clientRef.current!.send(kgNodeDetailCommand(payload)),
    [],
  );
  const sendKgChangeReport = useCallback(
    (payload: KgChangeReportPayload) => clientRef.current!.send(kgChangeReportCommand(payload)),
    [],
  );
  const sendKgNodeConfirm = useCallback(
    (payload: KgNodeConfirmPayload) => clientRef.current!.send(kgNodeConfirmCommand(payload)),
    [],
  );
  const sendKgIndexStatus = useCallback(
    (payload: KgIndexStatusPayload) => clientRef.current!.send(kgIndexStatusCommand(payload)),
    [],
  );
  // kg-bootstrap 批五命令（T3.2；连接私有读写面——直发命令，回执经 subscribeKgFrames）
  const sendKgBootstrapCreate = useCallback(
    (payload: KgBootstrapCreatePayload) => clientRef.current!.send(kgBootstrapCreateCommand(payload)),
    [],
  );
  const sendKgBootstrapProduce = useCallback(
    (payload: KgBootstrapProducePayload) => clientRef.current!.send(kgBootstrapProduceCommand(payload)),
    [],
  );
  const sendKgNodeUpdate = useCallback(
    (payload: KgNodeUpdatePayload) => clientRef.current!.send(kgNodeUpdateCommand(payload)),
    [],
  );
  const sendKgNodeSupersede = useCallback(
    (payload: KgNodeSupersedePayload) => clientRef.current!.send(kgNodeSupersedeCommand(payload)),
    [],
  );
  const sendKgBootstrapImpact = useCallback(
    (payload: KgBootstrapImpactPayload) => clientRef.current!.send(kgBootstrapImpactCommand(payload)),
    [],
  );
  // kg 维护批两命令（C1；连接私有读写面——直发命令，回执经 subscribeKgFrames）
  const sendKgGraphPurge = useCallback(
    (payload: KgGraphPurgePayload) => clientRef.current!.send(kgGraphPurgeCommand(payload)),
    [],
  );
  const sendKgIndexDelete = useCallback(
    (payload: KgIndexDeletePayload) => clientRef.current!.send(kgIndexDeleteCommand(payload)),
    [],
  );
  // kg.health 批 + kg 评审批命令（W2-E/W2-F；连接私有读写面——直发命令，回执经 subscribeKgFrames）
  const sendKgHealth = useCallback(
    (payload: KgHealthPayload) => clientRef.current!.send(kgHealthCommand(payload)),
    [],
  );
  const sendKgReviewCreate = useCallback(
    (payload: KgReviewCreatePayload) => clientRef.current!.send(kgReviewCreateCommand(payload)),
    [],
  );
  const subscribeKgFrames = useCallback((listener: (e: EventEnvelope) => void) => {
    kgListenersRef.current.add(listener);
    return () => {
      kgListenersRef.current.delete(listener);
    };
  }, []);

  // task 族九命令面（T3.1；沿 kg 族先例：直发命令 + 订阅帧——P-2 任务页
  // 页面私有 reducer 消费，会话 store 零写入）
  const sendTaskList = useCallback(
    (payload: TaskListPayload = {}) => clientRef.current!.send(taskListCommand(payload)),
    [],
  );
  const sendTaskDetail = useCallback(
    (payload: TaskDetailPayload) => clientRef.current!.send(taskDetailCommand(payload)),
    [],
  );
  const sendTaskArtifacts = useCallback(
    (payload: TaskArtifactsPayload) => clientRef.current!.send(taskArtifactsCommand(payload)),
    [],
  );
  const sendTaskSubscribe = useCallback(() => clientRef.current!.send(taskSubscribeCommand()), []);
  const sendTaskUnsubscribe = useCallback(() => clientRef.current!.send(taskUnsubscribeCommand()), []);
  const sendTaskPause = useCallback((jobId: string) => clientRef.current!.send(taskPauseCommand(jobId)), []);
  const sendTaskResume = useCallback((jobId: string) => clientRef.current!.send(taskResumeCommand(jobId)), []);
  const sendTaskCancel = useCallback((jobId: string) => clientRef.current!.send(taskCancelCommand(jobId)), []);
  const sendTaskDelete = useCallback((jobId: string) => clientRef.current!.send(taskDeleteCommand(jobId)), []);
  const subscribeTaskFrames = useCallback((listener: (e: EventEnvelope) => void) => {
    taskListenersRef.current.add(listener);
    return () => {
      taskListenersRef.current.delete(listener);
    };
  }, []);

  // workspace 族门禁面（W3；沿 kg 族先例：直发命令 + 订阅帧——真消费归
  // entities/workspace 状态机，会话 store 零写入）
  const sendWorkspaceGet = useCallback(() => clientRef.current!.send(workspaceGetCommand()), []);
  const sendWorkspaceOpen = useCallback(
    (root: string) => clientRef.current!.send(workspaceOpenCommand(root)),
    [],
  );
  const subscribeWorkspaceFrames = useCallback((listener: (e: EventEnvelope) => void) => {
    workspaceListenersRef.current.add(listener);
    return () => {
      workspaceListenersRef.current.delete(listener);
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
    if (sessionId === null) {
      // 草稿无会话上下文（T3，bug4）：本地暂存（ui/set-draft-model）——
      // 徽标即时反映，随首条 chat.send{draft:true, model} 上送生效
      dispatch({ type: "ui/set-draft-model", model });
      return;
    }
    clientRef.current!.send(modelSetCommand(model, sessionId));
  }, []);

  // thinking 批①（T2.1 P-1 滑块选档）：仿 setSessionModel 三段先例——
  // 命令发送（thinkingSetCommand 信封 sessionId）+ 草稿本地暂存
  // （ui/set-draft-thinking；chat.send 零字段 → 转正补发见 onFrame 快照分支）
  // + 生效回执 thinking.changed 广播消费（consumers/thinking-level.ts）
  const setSessionThinking = useCallback((level: string) => {
    const { sessionId } = topologyRef.current.active;
    if (sessionId === null) {
      dispatch({ type: "ui/set-draft-thinking", level });
      return;
    }
    clientRef.current!.send(thinkingSetCommand(level, sessionId));
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

  /** R7 全局兜底批：全局默认推理强度（null = 清除回未配置态）。 */
  const setThinkingDefault = useCallback((level: string | null) => {
    dispatch({ type: "model/set-thinking-default-started", level });
    clientRef.current!.send(modelSetThinkingDefaultCommand(level));
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
      attachImages,
      removeAttachment,
      retry,
      abort,
      switchSession,
      newDraft,
      setDraftMode,
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
      setSessionThinking,
      requestModelConfig,
      requestAuthList,
      refreshModelCatalog,
      setDefaultModel,
      setThinkingDefault,
      verifyProvider,
      setProviderKey,
      deleteProviderKey,
      sendTraceQuery,
      subscribeTraceFrames,
      sendAgentConfigList,
      sendAgentConfigSetEnabled,
      subscribeAgentConfigFrames,
      sendWebStop,
      sendWebStart,
      sendKgProjects,
      sendKgList,
      sendKgNodeDetail,
      sendKgChangeReport,
      sendKgNodeConfirm,
      sendKgIndexStatus,
      sendKgBootstrapCreate,
      sendKgBootstrapProduce,
      sendKgNodeUpdate,
      sendKgNodeSupersede,
      sendKgBootstrapImpact,
      sendKgGraphPurge,
      sendKgIndexDelete,
      sendKgHealth,
      sendKgReviewCreate,
      subscribeKgFrames,
      sendTaskList,
      sendTaskDetail,
      sendTaskArtifacts,
      sendTaskSubscribe,
      sendTaskUnsubscribe,
      sendTaskPause,
      sendTaskResume,
      sendTaskCancel,
      sendTaskDelete,
      subscribeTaskFrames,
      sendWorkspaceGet,
      sendWorkspaceOpen,
      subscribeWorkspaceFrames,
    }),
    [
      state,
      topology,
      setDraft,
      submit,
      attachImages,
      removeAttachment,
      retry,
      abort,
      switchSession,
      newDraft,
      setDraftMode,
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
      setSessionThinking,
      requestModelConfig,
      requestAuthList,
      refreshModelCatalog,
      setDefaultModel,
      verifyProvider,
      setProviderKey,
      deleteProviderKey,
      sendTraceQuery,
      subscribeTraceFrames,
      sendAgentConfigList,
      sendAgentConfigSetEnabled,
      subscribeAgentConfigFrames,
      sendWebStop,
      sendWebStart,
      sendKgProjects,
      sendKgList,
      sendKgNodeDetail,
      sendKgChangeReport,
      sendKgNodeConfirm,
      sendKgIndexStatus,
      sendKgBootstrapCreate,
      sendKgBootstrapProduce,
      sendKgNodeUpdate,
      sendKgNodeSupersede,
      sendKgBootstrapImpact,
      sendKgGraphPurge,
      sendKgIndexDelete,
      sendKgHealth,
      sendKgReviewCreate,
      subscribeKgFrames,
      sendTaskList,
      sendTaskDetail,
      sendTaskArtifacts,
      sendTaskSubscribe,
      sendTaskUnsubscribe,
      sendTaskPause,
      sendTaskResume,
      sendTaskCancel,
      sendTaskDelete,
      subscribeTaskFrames,
      sendWorkspaceGet,
      sendWorkspaceOpen,
      subscribeWorkspaceFrames,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
