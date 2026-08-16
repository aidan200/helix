/**
 * entities/session —— 会话投影 reducer（W7/CL-7；AD-16 纯投影；v0.1 扩：CL-1/2/3）。
 *
 * 状态 = 连接态 × 会话投影。全部领域内容由 WS 事件流（@helix/protocol
 * EventEnvelope）投影而来：前端零权威状态，重连恢复 = daemon 快照 + 增量，
 * 无本地补齐。本文件为纯函数（无 React / 无 IO / 无 Date.now），可重放：
 *   ① 同一 action 序列重放两次 → 状态幂等一致；
 *   ② 前缀投影快照 + 后续增量 = 全量重放（session-reducer.test.ts 守护）；
 *
 * v0.1 新增投影面（契约 protocol-v0.1.md §7）：
 *   - instances：SubAgent 卡片四态状态机（agent.* 事件族；终态吸收；
 *     重派 = 新 agentId 新卡）；
 *   - instanceId 分流：chat 事件缺省 main 进消息流，SubAgent delta 只更新
 *     卡片 streaming 摘要尾窗；SubAgent 消息/工具不进主消息流；
 *   - thinkingStreams/usage：状态槽位（渲染归 T4.2；账目仅由
 *     usage.recorded/快照驱动，流式中冻结）；
 *   - 快照 additive：instances/usage 重建，新 kind entries 入流。
 *
 * 本地仅存纯 UI 态：draft（输入草稿）、工具卡展开（组件态）、主题/i18n
 * （localStorage 白名单键，AG-14）。
 */
import type {
  AgentInstanceDto,
  AgentStateDto,
  ClosureDto,
  EntryDto,
  EventEnvelope,
  InstanceState,
  MessageEntryDto,
  SessionUsageDto,
  UsageDto,
} from "@helix/protocol";

/** 主实例标识（信封 instanceId 缺省语义，契约 §3）。 */
export const MAIN_INSTANCE_ID = "main";

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

export interface SessionState {
  /** 连接态（SM-1 四态互斥） */
  conn: ConnState;
  /** 当前重连尝试次数（横幅「第 n 次尝试」） */
  connAttempts: number;
  /** error 态失败卡数据（gave-up 时由客户端填入真实错误信息） */
  connError: { message: string; attempts: number } | null;
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
  /** thinking 流式槽位（按 instanceId 累积；completed 落 Entry 并清槽；渲染归 T4.2） */
  thinkingStreams: Record<string, string>;
  /** 账目投影（usage.recorded/快照驱动；流式中冻结；渲染归 T4.2） */
  usage: SessionUsageProjection;
  /** spawn 秒回 toast（一次性，UI 消费） */
  spawnToast: SpawnToast | null;
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
  | { type: "event"; event: EventEnvelope }
  // ── 纯 UI 态 ──
  | { type: "ui/set-draft"; text: string }
  /** 发送提交（turn = chat.send / steer = chat.steer；ts 由调用方注入保证重放确定） */
  | { type: "ui/send"; text: string; mode: "turn" | "steer"; ts: number }
  | { type: "ui/consume-restore-toast" }
  /** spawn toast 消费（ChatPage 渲染后置空；v0.1） */
  | { type: "ui/consume-spawn-toast" };

/** 零账面（UsageDto 七字段全零；只读基线，累加永远产生新对象）。 */
const ZERO_USAGE: UsageDto = {
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
    thinkingStreams: {},
    usage: { total: ZERO_USAGE, compaction: ZERO_USAGE, byInstance: {} },
    spawnToast: null,
  };
}

// ── 派生选择子（纯函数）──────────────────────────────────────

/** 空会话态：connected 且无条目且无实例且无流式且非生成中（empty 引导页可见条件）。 */
export function selectIsEmpty(s: SessionState): boolean {
  return (
    s.conn === "connected" &&
    s.entries.length === 0 &&
    s.instances.length === 0 &&
    s.streaming === null &&
    !selectIsGenerating(s)
  );
}

/** 生成中（steer 提示行 / 输入不锁死的判据）：流式或有活跃 agent 态。 */
export function selectIsGenerating(s: SessionState): boolean {
  return (
    s.streaming !== null || s.agentState === "running" || s.agentState === "steering"
  );
}

/** 发送前置条件 = connected（SM 规则 6：非 connected 不给出可发入口）。 */
export function selectCanSend(s: SessionState): boolean {
  return s.conn === "connected";
}

// ── 内部工具 ────────────────────────────────────────────────

const LOCAL_PREFIX = "local:";

/** entries 按 id upsert（已存在则原位替换，否则尾部追加；保持到达序）。 */
function upsertEntry(entries: EntryDto[], entry: EntryDto): EntryDto[] {
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) return [...entries, entry];
  const next = entries.slice();
  next[idx] = entry;
  return next;
}

/** steer.queued：把最早的未确认本地 echo 换成 daemon entryId（确认对账）。 */
function confirmSteerEcho(entries: EntryDto[], entryId: string): EntryDto[] {
  const idx = entries.findIndex(
    (e) => e.kind === "message" && e.id.startsWith(LOCAL_PREFIX) && e.steerState === "queued",
  );
  if (idx === -1) return entries; // 无 echo（他端发送等场景）：等快照对账
  const next = entries.slice();
  const echo = next[idx] as MessageEntryDto;
  next[idx] = { ...echo, id: entryId };
  return next;
}

/** steer.drained：徽标 queued → drained（SM-3 第二态）。 */
function drainSteer(entries: EntryDto[], entryId: string): EntryDto[] {
  return entries.map((e) =>
    e.kind === "message" && e.id === entryId && e.steerState === "queued"
      ? { ...e, steerState: "drained" as const }
      : e,
  );
}

// ── v0.1 内部工具（实例卡片 / 账目 / 摘要尾窗）──────────────

/** 卡片 streaming 摘要尾窗长度（滚动截断，防长文本撑爆状态；决策消解「末 120 字」）。 */
const SUMMARY_TAIL = 120;

function tailWindow(text: string): string {
  return text.length > SUMMARY_TAIL ? text.slice(-SUMMARY_TAIL) : text;
}

/** 终态判定（done/failed/cancelled；终态吸收后续 agent 事件与 delta，F1.9）。 */
function isTerminal(state: InstanceState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

/** 按 instanceId 定位更新卡片（未命中/未变化时原引用返回，保持浅比较友好）。 */
function updateCard(
  instances: InstanceCardState[],
  instanceId: string,
  fn: (c: InstanceCardState) => InstanceCardState,
): InstanceCardState[] {
  let changed = false;
  const next = instances.map((c) => {
    if (c.instanceId !== instanceId) return c;
    const updated = fn(c);
    if (updated !== c) changed = true;
    return updated;
  });
  return changed ? next : instances;
}

/** SubAgent delta → 卡片摘要尾窗追加（终态实例吸收，保持定稿）。 */
function appendSummary(
  instances: InstanceCardState[],
  instanceId: string,
  delta: string,
): InstanceCardState[] {
  return updateCard(instances, instanceId, (c) =>
    isTerminal(c.state) ? c : { ...c, streamSummary: tailWindow(c.streamSummary + delta) },
  );
}

/** SubAgent 消息完成 → 摘要定稿（决策消解：completed 转摘要定稿，取正文尾窗）。 */
function finalizeSummary(
  instances: InstanceCardState[],
  instanceId: string,
  content: string,
): InstanceCardState[] {
  return updateCard(instances, instanceId, (c) =>
    isTerminal(c.state) ? c : { ...c, streamSummary: tailWindow(content) },
  );
}

/** 快照 instances → 卡片重建（subagent 过滤；主实例非卡片；DTO 无摘要字段 → 空串复位）。 */
function instancesFromSnapshot(dtos: AgentInstanceDto[]): InstanceCardState[] {
  return dtos
    .filter((d) => d.kind === "subagent")
    .map((d) => ({
      instanceId: d.instanceId,
      state: d.state,
      task: d.task ?? "",
      profileKind: d.profileKind,
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(d.state === "queued" && d.queuedPosition !== undefined
        ? { queuedPosition: d.queuedPosition }
        : {}),
      ...(d.closure ? { closure: d.closure } : {}),
      streamSummary: "",
    }));
}

/** UsageDto 逐字段累加（账目聚合；永远产生新对象）。 */
function addUsage(a: UsageDto, b: UsageDto): UsageDto {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  };
}

/** 快照 usage/instances → 账目重建（快照为权威；缺省 = 零账面/无实例，旧剧本兼容）。 */
function usageFromSnapshot(
  usageDto: SessionUsageDto | undefined,
  instances: AgentInstanceDto[] | undefined,
): SessionUsageProjection {
  const byInstance: Record<string, UsageDto> = {};
  for (const d of instances ?? []) {
    if (d.usage) byInstance[d.instanceId] = d.usage;
  }
  if (!usageDto) return { total: ZERO_USAGE, compaction: ZERO_USAGE, byInstance };
  return { total: usageDto.total, compaction: usageDto.compaction, byInstance };
}

// ── 事件投影 ────────────────────────────────────────────────

function applyEvent(s: SessionState, event: EventEnvelope): SessionState {
  switch (event.type) {
    case "connection.welcome": {
      const toastPending = s.pendingManualRetry
        ? ("retry" as const)
        : s.hasConnected
          ? ("restore" as const)
          : null;
      return {
        ...s,
        conn: "connected",
        hasConnected: true,
        pendingManualRetry: false,
        toastPending,
        sessionId: event.payload.sessionId,
        model: event.payload.model,
        agentState: event.payload.agentState,
      };
    }
    case "connection.error":
      // 握手拒绝 / 命令回执：错误信息由 WS 客户端收口进 gave-up；连接保持类
      // 错误（command.*）不改变连接态。此处不投影（重放幂等友好）。
      return s;
    case "session.snapshot": {
      const snap = event.payload.snapshot;
      return {
        ...s,
        entries: snap.entries, // 整体替换：重连恢复全量来自 daemon（无本地补齐）；新 kind（thinking/compaction）随之入流
        model: snap.model,
        agentState: snap.agentState,
        sessionId: snap.sessionId,
        streaming: null, // 快照为落盘终态；进行中的流随重连作废
        thinkingStreams: {}, // 同上：thinking 流式中间态不落盘，重建后由后续 delta 重新累积
        instances: snap.instances ? instancesFromSnapshot(snap.instances) : [], // additive：实例清单重建卡片
        usage: usageFromSnapshot(snap.usage, snap.instances), // additive：账目重建（权威）
        spawnToast: null, // 快照为新会话视图；旧 toast 不跨会话残留
        restoreToast: s.toastPending ? { kind: s.toastPending, count: snap.entries.length } : s.restoreToast,
        toastPending: null,
      };
    }
    case "chat.stream.delta": {
      const { messageId, delta } = event.payload;
      // instanceId 分流（缺省 = main）：SubAgent delta 只进卡片摘要尾窗，不进主消息流
      if (event.instanceId !== undefined && event.instanceId !== MAIN_INSTANCE_ID) {
        return { ...s, instances: appendSummary(s.instances, event.instanceId, delta) };
      }
      const streaming =
        s.streaming && s.streaming.messageId === messageId
          ? { messageId, text: s.streaming.text + delta }
          : { messageId, text: delta };
      return { ...s, streaming };
    }
    case "chat.message.completed": {
      const entry = event.payload.entry;
      // SubAgent 消息不进主消息流（F1.6：注入/closure 是 MainAgent 上下文）：定稿卡片摘要
      const iid = event.instanceId ?? entry.instanceId;
      if (iid !== undefined && iid !== MAIN_INSTANCE_ID) {
        const content = entry.kind === "message" ? entry.content : "";
        return { ...s, instances: finalizeSummary(s.instances, iid, content) };
      }
      const cleared =
        entry.kind === "message" && entry.role === "assistant" ? null : s.streaming;
      return { ...s, entries: upsertEntry(s.entries, entry), streaming: cleared };
    }
    case "chat.turn.started":
      return s; // 轮次里程碑（v0 无 UI 投影面）
    case "chat.turn.completed":
      return { ...s, streaming: null };
    case "steer.queued":
      return { ...s, entries: confirmSteerEcho(s.entries, event.payload.entryId) };
    case "steer.drained":
      return { ...s, entries: drainSteer(s.entries, event.payload.entryId) };
    case "tool.call.started":
    case "tool.call.result": {
      // SubAgent 内部工具调用只进 per-instance channel，不进主线事件流（F1.6）
      const iid = event.instanceId ?? event.payload.entry.instanceId;
      if (iid !== undefined && iid !== MAIN_INSTANCE_ID) return s;
      return { ...s, entries: upsertEntry(s.entries, event.payload.entry) };
    }
    case "agent.state.changed": {
      const agentState = event.payload.state;
      return { ...s, agentState, streaming: agentState === "idle" ? null : s.streaming };
    }

    // ── v0.1 编排生命周期族（agent.*；四态互斥、终态吸收；契约 §5.1/§7）──
    case "agent.spawned": {
      const { agentId, task, profileKind, model } = event.payload;
      const existing = s.instances.find((c) => c.instanceId === agentId);
      if (existing) {
        // 终态吸收（重派 = 新 agentId 新卡）；非终态重发仅刷新任务面
        if (isTerminal(existing.state)) return s;
        return {
          ...s,
          instances: updateCard(s.instances, agentId, (c) => ({
            ...c,
            task,
            profileKind,
            ...(model !== undefined ? { model } : {}),
          })),
        };
      }
      // 预算内直跑为主路径（spawn 秒回即执行；超限时随后 agent.queued 投影转 queued）
      const card: InstanceCardState = {
        instanceId: agentId,
        state: "running",
        task,
        profileKind,
        ...(model !== undefined ? { model } : {}),
        streamSummary: "",
      };
      return {
        ...s,
        instances: [...s.instances, card],
        spawnToast: { instanceId: agentId, profileKind }, // F1.5 spawn 秒回 toast
      };
    }
    case "agent.queued": {
      const { agentId, position } = event.payload;
      // 位次随出队递减由事件重发驱动（不自行计算）；终态吸收
      return {
        ...s,
        instances: updateCard(s.instances, agentId, (c) =>
          isTerminal(c.state) ? c : { ...c, state: "queued", queuedPosition: position, stalledMs: undefined },
        ),
      };
    }
    case "agent.started": {
      return {
        ...s,
        instances: updateCard(s.instances, event.payload.agentId, (c) =>
          isTerminal(c.state) ? c : { ...c, state: "running", queuedPosition: undefined, stalledMs: undefined },
        ),
      };
    }
    case "agent.stalled": {
      // 非状态迁移（实例仍 running，可再次发生）；仅 running 态记录（§8-3）
      return {
        ...s,
        instances: updateCard(s.instances, event.payload.agentId, (c) =>
          c.state === "running" ? { ...c, stalledMs: event.payload.idleMs } : c,
        ),
      };
    }
    case "agent.completed": {
      return {
        ...s,
        instances: updateCard(s.instances, event.payload.agentId, (c) =>
          isTerminal(c.state)
            ? c
            : {
                ...c,
                state: "done",
                closure: event.payload.closure,
                queuedPosition: undefined,
                stalledMs: undefined,
                streamSummary: "", // 摘要定稿归于 closure：done 卡渲染 closure.summary，尾窗仅 running 态有意义
              },
        ),
      };
    }
    case "agent.failed": {
      const { error, closure } = event.payload;
      return {
        ...s,
        instances: updateCard(s.instances, event.payload.agentId, (c) =>
          isTerminal(c.state)
            ? c
            : {
                ...c,
                state: "failed",
                error,
                closure,
                queuedPosition: undefined,
                stalledMs: undefined,
                streamSummary: "", // 同 agent.completed：错误行 = error 字段，尾窗复位
              },
        ),
      };
    }
    case "agent.killed": {
      // kill → failed 单一终态 + terminated 交代（P-2 消费）；不设第五卡片态（§8-2）
      return {
        ...s,
        instances: updateCard(s.instances, event.payload.agentId, (c) =>
          isTerminal(c.state)
            ? c
            : {
                ...c,
                state: "failed",
                terminated: true,
                closure: event.payload.closure,
                queuedPosition: undefined,
                stalledMs: undefined,
                streamSummary: "",
              },
        ),
      };
    }

    // ── v0.1 通道族（thinking/compaction/usage；契约 §5.2）──
    case "thinking.stream.delta": {
      // thinking 流式中间态不落盘（TR-AD-5）：按 instanceId 累积；渲染归 T4.2
      const { instanceId, delta } = event.payload;
      const prev = s.thinkingStreams[instanceId] ?? "";
      return { ...s, thinkingStreams: { ...s.thinkingStreams, [instanceId]: prev + delta } };
    }
    case "thinking.completed": {
      // 完成落 Entry（complete-collapsed 不可逆）；流式槽位随实例清空（他实例不受扰）
      const entry = event.payload.entry;
      const streams = { ...s.thinkingStreams };
      delete streams[entry.instanceId];
      return { ...s, entries: upsertEntry(s.entries, entry), thinkingStreams: streams };
    }
    case "compaction.completed":
      // 里程碑条数据源（entry.usage 为展示面）；账目入账唯一驱动 = usage.recorded/
      // 快照——若此处再累加将与 usage.recorded(source=compaction) 双计（AD-9③防线）
      return { ...s, entries: upsertEntry(s.entries, event.payload.entry) };
    case "usage.recorded": {
      // 账目聚合（流式中冻结由「delta 分支不触碰 usage」结构性保证）：
      // turn 源 → per-instance 小计；compaction 源 → compaction 小计（不进实例
      // 小计，total = Σ实例 + compaction 与 popover 行自洽，原型 INSTANCES 口径）
      const { instanceId, usage: u, source } = event.payload;
      const byInstance = { ...s.usage.byInstance };
      if (source === "turn") {
        byInstance[instanceId] = addUsage(byInstance[instanceId] ?? ZERO_USAGE, u);
      }
      return {
        ...s,
        usage: {
          total: addUsage(s.usage.total, u),
          compaction: source === "compaction" ? addUsage(s.usage.compaction, u) : s.usage.compaction,
          byInstance,
        },
      };
    }
    default:
      return s;
  }
}

// ── reducer ─────────────────────────────────────────────────

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    // 连接态切换从不清空投影与草稿（SM 规则 4/5）
    case "conn/connecting":
      return { ...state, conn: "connecting", connAttempts: action.attempt };
    case "conn/disconnected":
      return { ...state, conn: "disconnected" };
    case "conn/gave-up":
      return {
        ...state,
        conn: "error",
        connError: { message: action.message, attempts: action.attempts },
      };
    case "conn/manual-retry":
      return {
        ...state,
        conn: "connecting",
        connAttempts: 1,
        pendingManualRetry: true,
      };
    case "event":
      return applyEvent(state, action.event);
    case "ui/set-draft":
      return { ...state, draft: action.text };
    case "ui/send": {
      const text = action.text.trim();
      if (!selectCanSend(state) || text === "") return state; // SM 规则 6：非 connected 拒发
      if (action.mode === "steer") {
        // steer echo：立即可见的 user 气泡 + queued 徽标；id 对账交给 steer.queued
        const echo: MessageEntryDto = {
          kind: "message",
          id: `${LOCAL_PREFIX}${state.nextLocalSeq}`,
          role: "user",
          content: text,
          ts: action.ts,
          steerState: "queued",
        };
        return {
          ...state,
          draft: "",
          entries: [...state.entries, echo],
          nextLocalSeq: state.nextLocalSeq + 1,
        };
      }
      // turn 模式不做本地 echo：气泡由 daemon 的 chat.message.completed 投影
      return { ...state, draft: "" };
    }
    case "ui/consume-restore-toast":
      return { ...state, restoreToast: null };
    case "ui/consume-spawn-toast":
      return { ...state, spawnToast: null };
    default:
      return state;
  }
}
