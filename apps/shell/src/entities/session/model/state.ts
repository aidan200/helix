/**
 * entities/session —— 会话状态面（类型 / 常量 / 初始状态工厂）。
 *
 * C2 拆分（AD-3 前端形态，T1.1）自 session-reducer.ts 迁出的状态契约单点：
 * 消费者模块与 dispatcher 共同依赖的类型 / 常量 / 工厂落此，主文件经组合
 * 导出保持原导入路径（@/entities/session/model/session-reducer）不变，
 * 零消费方改动。纯函数纪律（AG-14）不变：无 React / 无 IO / 无 Date.now。
 */
import type {
  AgentInstanceDto,
  AgentStateDto,
  CatalogModel,
  ClosureDto,
  EntryDto,
  EventEnvelope,
  InstanceState,
  SessionMeta,
  SessionUsageDto,
  ThinkingEntryDto,
  ToolCallEntryDto,
  UsageDto,
} from "@helix/protocol";
import { MAIN_INSTANCE_ID as PROTOCOL_MAIN_INSTANCE_ID } from "@helix/protocol";

/**
 * 主实例标识（信封 instanceId 缺省语义，契约 §3）。
 * T1.2 延后项（T3.1 顺手收敛）：改引 @helix/protocol 单一导出（OI 收口
 * F-2⑬）——本地 re-export 保持既有导入路径（@/entities/session/model/
 * session-reducer）零消费方改动；线上权威 = 协议常量。
 */
export const MAIN_INSTANCE_ID = PROTOCOL_MAIN_INSTANCE_ID;

/** 本地 steer echo id 前缀（确定性 id，保证重放幂等；消费：chat 消费者对账 + ui/send echo）。 */
export const LOCAL_PREFIX = "local:";

/** 连接四态（互斥；SM-1）。loading = connecting 的可视形态，不设第五态。 */
export type ConnState = "connecting" | "connected" | "disconnected" | "error";

/** 流式中间态投影（chat.stream.delta 累积；不落盘语义的前端侧镜像）。 */
export interface StreamingState {
  messageId: string;
  text: string;
}

/** 恢复 toast（重连成功后由快照条数填满，UI 消费后置空）。 */
export interface RestoreToast {
  kind: "restore" | "retry";
  count: number;
}

/**
 * SubAgent 卡片投影（agent.* 编排事件族驱动；快照 instances 重建）。
 * 四态互斥单值；终态（done/failed/cancelled）吸收后续事件（F1.9：
 * 实例不复活，重派 = 新 agentId 新卡）；cancelled 仅快照恢复态（AD-10）。
 */
export interface InstanceCardState {
  instanceId: string;
  /** 四态 + cancelled（恢复态）；互斥单值 */
  state: InstanceState;
  /** spawn 携带的任务描述 */
  task: string;
  profileKind: string;
  /** "provider/model-id"；未声明时缺省继承当前模型（AD-6） */
  model?: string;
  /** 仅 state=queued；位次随出队递减由 agent.queued 重发驱动（不自行计算） */
  queuedPosition?: number;
  /** agent.failed 错误行文本 */
  error?: string;
  /** 终态收口（agent.completed/failed/killed；快照终态实例） */
  closure?: ClosureDto;
  /** agent.killed → failed 渲染 + terminated 交代（P-2 消费，不设第五态） */
  terminated?: boolean;
  /** agent.stalled 最近一次 idle 毫秒（非状态迁移；仅 running 态有意义） */
  stalledMs?: number;
  /** running 态 streaming 摘要尾窗（该实例 assistant delta 的尾段，滚动截断） */
  streamSummary: string;
  /**
   * spawn 时间轴锚点（T5.5）：卡片渲染插入位 = 该 id 的 main entry 之后
   * （null = 流首）。id 引用天然抗分页前插（prepend 不改 id）；spawn 时取
   * 当时最后一条 main entry；快照恢复 = 实例首 Entry 前最后一条 main entry
   * （无实例 Entry = 尾部）；同会话重连合入保留 live 锚点（重放幂等）。
   */
  anchorEntryId: string | null;
}

/** 会话账目投影（F3.3/F3.4；渲染归 T4.2）。 */
export interface SessionUsageProjection {
  /** 徽标值 = 各实例行合计 + compaction 行（popover 行自洽） */
  total: UsageDto;
  /** compaction 摘要调用小计（popover 独立行） */
  compaction: UsageDto;
  /** per-instance 小计（popover 行数据） */
  byInstance: Record<string, UsageDto>;
}

/** spawn 秒回 toast（agent.spawned 置位，UI 消费后置空；F1.5）。 */
export interface SpawnToast {
  instanceId: string;
  profileKind: string;
}

/** kill 到达 toast（agent.killed 置位，UI 消费后置空；F1.2 终止链末端交代）。 */
export interface KillToast {
  instanceId: string;
}

// ── v0.2 store 拓扑（AD-3 §3.4；T3.1）──────────────────

/**
 * 切换两阶段（原型 P-1s 状态模型）：loading 骨架 ↔ ready(success) 互斥；
 * 快照到达即转 ready + 输入恢复。首连/切换共用同一状态位。
 */
export type SessionViewPhase = "loading" | "ready";

/**
 * 向上分页状态（AD-1）：hasMore=false 禁用加载更早（不再发命令）。
 * v0.2（T3.2）：total = 快照 totalEntries（「已载 N / M」胶囊的分母；
 * null = 旧快照未携带 → 不渲染胶囊）；paged = 曾有更早历史可载（胶囊
 * 可见性判据：加载尽后保留禁用态胶囊，从未有则不性渲染）。
 */
export interface HistoryPaging {
  hasMore: boolean;
  /** 下一页游标（= 快照 tailStartCursor / 上一页 nextCursor）；null = 已含全部 */
  nextCursor: string | null;
  /** 在途分页请求（loading 中不重复触发） */
  loading: boolean;
  /** 快照 totalEntries（分页胶囊分母；null = 未携带（v0/v0.1 旧快照兼容）） */
  total: number | null;
  /** 曾有更早历史（P-1s 分页胶囊可见性：加载尽保留禁用态） */
  paged: boolean;
}

/**
 * 后台会话轻量 store（AD-3 §3.4：标题/运行态徽标/未读，**不存 entries**——
 * 类型级机械判据：键集恰为轻量五字段，无 entries/channelStreams）。
 * 数据源：session.list/list_changed 元数据 + 该会话事件帧驱动（未读 +1、
 * runState 投影）；切回该会话时移除（转活跃完整 store，未读随之消解）。
 */
export interface BackgroundSessionState {
  sessionId: string;
  title: string;
  /** 运行态徽标三态（SessionMeta.runState 同源） */
  runState: "idle" | "streaming" | "subagent_running";
  /** epoch ms（session.list/list_changed 元数据同源） */
  lastActivityAt: number;
  /** 未读计数：该会话事件帧 +1（收帧驱动；不渲染 entries 只计数） */
  unread: number;
}

/**
 * store 拓扑根（AD-3 §3.4）：活跃会话完整 store + 后台会话轻量 store +
 * 会话清单数据面（session.list.result / session.list_changed 维护）。
 * 帧经 dispatcher（dispatcher/frame.ts dispatchFrame）按信封 sessionId 路由。
 */
export interface TopologyState {
  /** 活跃会话完整 store（现 SessionState 全量） */
  active: SessionState;
  /** 后台会话轻量 store（sessionId → 轻量态；不含活跃会话） */
  background: Record<string, BackgroundSessionState>;
  /** 会话清单（按 lastActivityAt 降序；T3.2 侧栏数据面） */
  list: SessionMeta[];
  /** 模型/厂商全局配置面（model/auth 结果帧拓扑级消费；T3.3 P-3/P-4 数据源） */
  modelConfig: ModelConfigState;
  /** 智能体配置失效面（agent.config.changed 拓扑级消费；M6 T4 智能体页
   *  失效重拉触发：每广播 revision +1，页面 effect 观测变更重拉 list） */
  agentConfig: { revision: number };
}

/**
 * provider 连通徽标四态（review.md §6 状态模型：互斥）。
 * verifying 为前端 in-flight 态（auth.verify 结果帧到达即转 ok/fail）；
 * unverified/ok/fail 由帧驱动（auth.list / auth.verify.result）。
 */
export type VerifyBadgeState = "unverified" | "verifying" | "ok" | "fail";

/** 单 provider 凭据状态（auth.list.result 行 + 本地 verify 派生；P-4 列表行数据）。 */
export interface AuthProviderEntry {
  providerId: string;
  configured: boolean;
  /** 掩码（如 `····7f3a`；daemon 权威） */
  keyMasked?: string;
  /** 连通徽标四态（互斥单值） */
  verifyStatus: VerifyBadgeState;
  /** ok 态延迟（ms；auth.verify.result） */
  latencyMs?: number;
  /** fail 态原因（auth.verify.result；如 `401 · key 无效`） */
  failReason?: string;
}

/** 目录快照（model.catalog / model.catalog_refresh 结果面）。 */
export interface ModelCatalogState {
  models: CatalogModel[];
  /** 上次远端核对（epoch ms；0 = 无 overlay 历史） */
  refreshedAt: number;
  source: "cache" | "builtin" | "remote";
  /** 刷新降级说明（仅 catalog_refresh 携带；空 = 全部成功） */
  degraded: string[];
}

/**
 * 模型/厂商全局配置面（channel="model" 结果帧拓扑级消费者维护；T3.3）。
 *
 * 结果帧 payload 无 providerId 回携（契约 C §2.2）——归属经 in-flight 单值
 * 锁定（UI 串行化：同类 in-flight 期间其余入口禁用），stale 帧丢弃。
 */
export interface ModelConfigState {
  /** 目录快照（null = 未请求；P-3 打开 / P-4 进入时拉取） */
  catalog: ModelCatalogState | null;
  /** 全局默认模型（"" = 未请求；model.get_default / set_default 乐观同步） */
  defaultModel: string;
  /** provider 凭据行（auth.list 整体替换 + verify/set_key/delete_key 增量） */
  auth: Record<string, AuthProviderEntry>;
  /** auth.list 首批到达标记（T5.3：P-3 可用性过滤在首批到达前不生效，
   *  避免菜单开启瞬间误闪零可用空态） */
  authLoaded: boolean;
  /** auth.verify in-flight（结果帧归属锁定；串行单值） */
  verifyInflight: string | null;
  /** auth.set_key in-flight（同上） */
  setKeyInflight: string | null;
  /** auth.delete_key in-flight（同上） */
  deleteKeyInflight: string | null;
  /** model.set_default 乐观值回执锁定（result.previous 到达即清） */
  setDefaultInflight: string | null;
  /** 目录强制刷新 in-flight（按钮转动反馈；catalog_refresh.result 到达即清） */
  catalogRefreshing: boolean;
}

/** 初始配置面（未请求态；数据由命令结果帧驱动填充）。 */
export function createInitialModelConfigState(): ModelConfigState {
  return {
    catalog: null,
    defaultModel: "",
    auth: {},
    authLoaded: false,
    verifyInflight: null,
    setKeyInflight: null,
    deleteKeyInflight: null,
    setDefaultInflight: null,
    catalogRefreshing: false,
  };
}

// ── v0.1 per-instance channel（P-2 抽屉单一时间线；T4.3）────────

/** lifecycle 行键（视图映射 drawer.lc.* 词条；reducer 不持渲染文本）。 */
export type ChannelLcKey = "spawned" | "modelResolved" | "stalled" | "crashed" | "terminated";

/**
 * channel 条目物种（F1.2 五物种）：lifecycle 行 / SA 消息 / steer 注入标记 /
 * thinking 完成块 / 工具卡 / closure 卡。纯投影（agent.* 事件族 + 通道事件
 * instanceId 分流 + 快照重建），视图零权威；seq 单调递增（React key / 到达序）。
 */
export type ChannelItem =
  | {
      kind: "lifecycle";
      seq: number;
      lc: ChannelLcKey;
      tone: "info" | "warn" | "err";
      /** 事件到达时间（调用方注入，重放确定性；快照重建行无 → 视图省略时间戳） */
      ts?: number;
      /** modelResolved：解析值（声明值或继承的会话模型）与槽位来源 */
      model?: string;
      slot?: "declared" | "inherited";
      /** stalled：idle 毫秒（视图 formatDuration 消费） */
      idleMs?: number;
      /** crashed：daemon error 原文透传（领域数据） */
      error?: string;
    }
  | { kind: "message"; seq: number; text: string; ts?: number }
  | { kind: "steer"; seq: number; text: string; ts?: number }
  /** 定向 steer 标记（CL-3，契约 v0.3 §3.2 Q-3a 抽屉侧投影）：user+isSteer
   *  且 instanceId=本实例的干预条目——与时间轴侧同物种（violet 细条 +
   *  「steer → {target}」chip + 正文）；target = 归属实例（= 本 channel）。 */
  | { kind: "steer-directed"; seq: number; text: string; ts?: number; target: string }
  | { kind: "thinking-entry"; seq: number; entry: ThinkingEntryDto }
  | { kind: "tool"; seq: number; entry: ToolCallEntryDto }
  | { kind: "closure"; seq: number; closure: ClosureDto };

/** channel 流式消息中间态（SubAgent assistant delta 镜像；完成即清，不落盘语义）。 */
export interface ChannelStream {
  messageId: string;
  text: string;
}

export interface SessionState {
  /** 连接态（SM-1 四态互斥） */
  conn: ConnState;
  /** 当前重连尝试次数（横幅「第 n 次尝试」） */
  connAttempts: number;
  /** error 态失败卡数据（gave-up 时由客户端填入真实错误信息） */
  connError: { message: string; attempts: number } | null;
  /** 引擎/模型调用失败（终验热修：engine.error 帧 → 聊天流错误卡片；
   *  瞬态不落盘——新轮开始即清；持久事实在 daemon 日志与领域事件流） */
  engineError: { message: string } | null;
  /** 手动重试挂起（welcome 后 toast 走 retry 文案而非 restore） */
  pendingManualRetry: boolean;
  /** 是否曾连接成功过（区分首连与重连：仅重连触发恢复 toast） */
  hasConnected: boolean;
  /** welcome/snapshot 待填的 toast 类型（快照到达时取条数） */
  toastPending: "restore" | "retry" | null;
  /** 恢复 toast（一次性，UI 消费） */
  restoreToast: RestoreToast | null;
  sessionId: string | null;
  model: string;
  agentState: AgentStateDto;
  /** 会话投影（daemon 权威；快照整体替换 + 增量事件 upsert） */
  entries: EntryDto[];
  streaming: StreamingState | null;
  /** 输入草稿（纯 UI 态；跨连接态保留，发送成功才清空） */
  draft: string;
  /** 本地 steer echo 序号（确定性 id，保证重放幂等） */
  nextLocalSeq: number;
  /** SubAgent 卡片投影（agent.* 事件族 + 快照 instances；v0.1） */
  instances: InstanceCardState[];
  /** per-instance channel 单一时间线（P-2 抽屉消费；五物种；T4.3） */
  instanceChannels: Record<string, ChannelItem[]>;
  /** channel 流式消息中间态（实例 assistant delta 镜像；完成即清） */
  channelStreams: Record<string, ChannelStream>;
  /** channel 条目序号（单调递增；重放确定性） */
  nextChannelSeq: number;
  /** thinking 流式槽位（按 instanceId 累积；completed 落 Entry 并清槽；渲染归 T4.2） */
  thinkingStreams: Record<string, string>;
  /** 账目投影（usage.recorded/快照驱动；流式中冻结；渲染归 T4.2） */
  usage: SessionUsageProjection;
  /** spawn 秒回 toast（一次性，UI 消费） */
  spawnToast: SpawnToast | null;
  /** kill 到达 toast（一次性，UI 消费；agent.killed 终止链末端） */
  killToast: KillToast | null;
  /** 切换两阶段（P-1s）：loading 骨架 ↔ ready 互斥；快照到达即转 ready */
  view: SessionViewPhase;
  /** 向上分页状态（AD-1；快照 tailStartCursor 初始化，loadHistory.result 推进） */
  history: HistoryPaging;
}

export type SessionAction =
  // ── 连接态（shared/api 客户端驱动；SM-1/2 转换矩阵）──
  /** 一次连接尝试开始（首连 attempt=1；自动重连递增） */
  | { type: "conn/connecting"; attempt: number }
  /** 已建立的连接意外断开（自动重连序列随后启动） */
  | { type: "conn/disconnected" }
  /** 自动重试耗尽 / 握手持续被拒（失败卡；等待手动重试） */
  | { type: "conn/gave-up"; message: string; attempts: number }
  /** 用户点击失败卡「重试连接」（error → connecting） */
  | { type: "conn/manual-retry" }
  // ── 协议事件（唯一领域数据来源）──
  | { type: "event"; event: EventEnvelope; ts?: number }
  // ── 纯 UI 态 ──
  | { type: "ui/set-draft"; text: string }
  /** 草稿模型本地暂存（T3，bug4）：仅 sessionId===null（草稿态）生效置
   *  state.model（徽标/首条 chat.send{draft:true, model} 数据源）；真实会话
   *  原样（防御——真实会话换模走 model.set 帧语义） */
  | { type: "ui/set-draft-model"; model: string }
  /** 发送提交（turn = chat.send / steer = chat.steer；ts 由调用方注入保证重放确定） */
  | { type: "ui/send"; text: string; mode: "turn" | "steer"; ts: number }
  /** 抽屉定向 steer 提交（CL-3）：本地 echo 双投影——主轴定向 entry（时间轴
   *  细条即时可见）+ 目标实例 channel steer-directed 标记（抽屉 feed 即时
   *  可见）；daemon steer.queued（信封 instanceId=目标）到达后对账 */
  | { type: "ui/steer-instance"; text: string; instanceId: string; ts: number }
  | { type: "ui/consume-restore-toast" }
  /** spawn toast 消费（ChatPage 渲染后置空；v0.1） */
  | { type: "ui/consume-spawn-toast" }
  /** kill toast 消费（ChatPage 渲染后置空；T4.3） */
  | { type: "ui/consume-kill-toast" }
  // ── v0.2 store 拓扑 action（T3.1；由 topologyReducer 承接）──
  /** 切换会话开始（provider 已发 unsubscribe 旧 + subscribe 新；旧活跃转轻量、
   *  目标尾窗重建 loading——P-1s 两阶段） */
  | { type: "session/switch-started"; sessionId: string }
  /** 新建草稿（F(1.2).1）：活跃会话转后台轻量照常执行，活跃 store 置空
   *  草稿态（sessionId=null + view=ready；provider 已发 unsubscribe 旧会话） */
  | { type: "session/new-draft" }
  /** 滚动到顶触发加载更早历史（hasMore 门控；provider 据此发 loadHistory 命令） */
  | { type: "ui/load-earlier" }
  // ── 模型/厂商配置 action（T3.3；UI 命令发送同刻 dispatch，终态由结果帧驱动）──
  /** 点击「测试连通」：目标 provider 置 verifying（先清旧 ok/fail）+ in-flight 锁定 */
  | { type: "model/verify-started"; providerId: string }
  /** key 弹层保存：in-flight 锁定（脱敏更新由 auth.set_key.result 驱动） */
  | { type: "model/set-key-started"; providerId: string }
  /** 删除二击确认：in-flight 锁定（转未配置由 auth.delete_key.result 驱动） */
  | { type: "model/delete-key-started"; providerId: string }
  /** 默认模型选择：乐观更新 defaultModel + in-flight（set_default.result 清） */
  | { type: "model/set-default-started"; model: string }
  /** 刷新目录：置 catalogRefreshing（catalog_refresh.result 到达即清） */
  | { type: "model/catalog-refresh-started" };

/** 零账面（UsageDto 七字段全零；只读基线，累加永远产生新对象）。 */
export const ZERO_USAGE: UsageDto = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: 0,
};

export function createInitialSessionState(): SessionState {
  return {
    conn: "connecting",
    connAttempts: 1,
    connError: null,
    engineError: null,
    pendingManualRetry: false,
    hasConnected: false,
    toastPending: null,
    restoreToast: null,
    sessionId: null,
    model: "",
    agentState: "idle",
    entries: [],
    streaming: null,
    draft: "",
    nextLocalSeq: 1,
    instances: [],
    instanceChannels: {},
    channelStreams: {},
    nextChannelSeq: 1,
    thinkingStreams: {},
    usage: { total: ZERO_USAGE, compaction: ZERO_USAGE, byInstance: {} },
    spawnToast: null,
    killToast: null,
    view: "loading",
    history: { hasMore: false, nextCursor: null, loading: false, total: null, paged: false },
  };
}

/** store 拓扑初始态（T3.1）：活跃完整 store（首连前 loading）+ 空后台/清单。 */
export function createInitialTopologyState(): TopologyState {
  return {
    active: createInitialSessionState(),
    background: {},
    list: [],
    modelConfig: createInitialModelConfigState(),
    agentConfig: { revision: 0 },
  };
}
