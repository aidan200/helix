import { DomainError } from "../DomainError";
import { Entry, type EntryData } from "./Entry";
import { ThinkingEntry, type ThinkingEntryData } from "./ThinkingEntry";
import { CompactionEntry, type CompactionEntryData } from "./CompactionEntry";
import { ErrorEntry, type ErrorEntryData } from "./ErrorEntry";
import type { SessionEntryData, SessionSnapshot } from "./SessionSnapshot";
import { Turn, type TurnData } from "./Turn";
import { SteerQueue, type SteerItem, type SteerSource } from "../agent/SteerQueue";
import {
  isMainInstanceId,
  LEGACY_MAIN_INSTANCE_ID,
  newInstanceId,
} from "../agent/AgentInstance";

/**
 * 会话聚合根（architecture.md §3.3，AD-16：domain 层唯一权威状态）。
 *
 * 职责：Entry 序列 + Turn 序列 + SteerQueue 的整体一致性——
 * 所有变更都经聚合方法（充血模型），非法操作抛 DomainError：
 * - appendUserEntry 只在无 open turn 时合法（运行中的输入必须走 applySteer）；
 * - beginTurn 在 open turn 未收尾前抛错（同 lane 防重入， ④ 护栏的 domain 落地）；
 * - applySteer 只在可注入（generating/toolRunning）的轮次合法。
 *
 * 快照往返：toSnapshot() ↔ restoreFrom() 是持久化（write-through）与
 * 重启恢复（RestoreService）的统一载荷，重建后行为延续（计数器不回卷）。
 */
export class Session {
  private readonly entries: (Entry | ThinkingEntry | CompactionEntry | ErrorEntry)[] = [];
  private readonly turns: Turn[] = [];
  private readonly steerQueue = new SteerQueue();
  private currentTurn: Turn | null = null;
  private nextEntrySeq = 1;
  private nextTurnSeq = 1;

  private constructor(
    readonly id: string,
    readonly createdAt: string,
    /**
     * 主实例 id（T10a 方案 A：所有实例含 main 统一 `agent-<唯一串>`，
     * 生成单点 newInstanceId()；kind 恒 "main" 不变）。会话创建时分配，
     * 随快照 mainInstanceId 字段往返；旧快照缺省 → legacy "main"（该会话
     * 历史行 instance_id="main" 不重写，主实例 id 保持 "main" 自闭合）。
     */
    readonly mainInstanceId: string,
    /**
     * 会话模式（P1 会话模式框架 T3）：建会话时定格，此后只读（锁定语义
     * = 结构不可能——无第二条写路径）。原始 string 透传携带（domain 不
     * import 协议常量）；缺省 = 旧快照/旧快照无值（读侧按 default 解析）。
     */
    readonly mode?: string,
  ) {}

  static create(id?: string, at?: string, mode?: string): Session {
    return new Session(id ?? crypto.randomUUID(), at ?? new Date(0).toISOString(), newInstanceId(), mode);
  }

  // ── Entry 追加 ──────────────────────────────────────────────

  /**
   * 预分配 entry id（D-2：assistant 流开始即确定最终 entry id，使
   * delta.messageId 与最终 entry id 对齐）。放弃不回收——只保证唯一性，
   * 计数器空洞无害（restoreFrom 按 max 重建）。
   */
  reserveEntryId(): string {
    return `e${this.nextEntrySeq++}`;
  }

  /** 追加一条用户消息（仅无 open turn 时合法；运行中注入请用 applySteer）。
   * 可选 images（base64 data URL 数组，chat.send.images 校验后透传落盘）。
   * 可选 source（T11a）：idle 时 closure/进展报告注入落的 user 条目携带来源。 */
  appendUserEntry(text: string, at?: string, images?: readonly string[], source?: SteerSource): Entry {
    if (this.currentTurn !== null) {
      throw new DomainError(
        `会话 ${this.id} 当前轮次 ${this.currentTurn.id} 进行中，新输入必须经 applySteer 注入（或等待轮次结束）`,
      );
    }
    return this.pushEntry("user", text, null, false, at, undefined, undefined, images, source);
  }

  /**
   * 追加一条 assistant 消息（要求 open turn——回复总属于某个轮次）。
   * reservedId：流式期间经 reserveEntryId() 预分配的最终 entry id
   * （D-2：与 delta.messageId 同源；正常路径必传，缺省时由聚合分配）。
   */
  appendAssistantEntry(text: string, at?: string, reservedId?: string): Entry {
    const turn = this.requireOpenTurn("appendAssistantEntry");
    return this.pushEntry("assistant", text, turn.id, false, at, reservedId);
  }

  /**
   * 运行中注入 steer：预分配 entry id 入 SteerQueue（**不落时间轴条目**）。
   * 条目在 drain（真正注入生效）时刻才经 appendSteerEntryAtDrain 落盘——位置 =
   * 生效时机（drain 时序 = 真正的对话时序：旧轮收尾之后、新轮回复之前）；
   * queued 期间的可观测面 = steer.queued 事件 + 快照 pendingSteer（队列坞）。
   * source：注入来源标记（user=用户输入；closure=SubAgent 收口注入，AD-8；
   * progress=周期进展报告，T11a 起贯通）。返回预分配的 entryId（D-2 同源：
   * steer.queued 事件载荷/回执/abort 丢弃成空洞无害）。
   */
  applySteer(text: string, at?: string, source?: SteerSource): string {
    const turn = this.requireOpenTurn("applySteer");
    if (!turn.isSteerable()) {
      throw new DomainError(`轮次 ${turn.id} 状态 ${turn.status} 不允许注入 steer（须为 generating/toolRunning）`);
    }
    return this.enqueueSteer(text, source);
  }

  /**
   * 恢复场景注入（AD-10）：无 open turn（重启收口后）时把 closure 注入
   * SteerQueue——与运行中注入同队列同语义（下轮 turn 边界消费，FIFO），但不
   * 驱动引擎（「不自动续跑」：零新事件流，恢复代码零 spawn）。与 applySteer
   * 同不落条目（drain 时经 appendSteerEntryAtDrain 作为新 turn 输入落盘）。
   */
  restoreSteer(text: string, at?: string, source?: SteerSource): string {
    if (this.currentTurn !== null) {
      throw new DomainError(
        `会话 ${this.id} 轮次 ${this.currentTurn.id} 进行中，恢复注入不适用（请用 applySteer）`,
      );
    }
    return this.enqueueSteer(text, source);
  }

  /**
   * drain 落盘（turn 边界消费时调用）：队列项落为时间轴条目——位置 = 生效时机
   * （真正的对话时序）。turnId=null（与 appendUserEntry 同惯例：entry 是新轮
   * 输入，Turn.inputEntryId 反向关联）；id = 入队时预分配的 entryId（D-2 同源）。
   */
  appendSteerEntryAtDrain(item: SteerItem, at?: string): Entry {
    return this.pushEntry("user", item.text, null, true, at, item.entryId, undefined, undefined, item.source);
  }

  /**
   * 定向 steer 落主时间轴（契约 v0.3 §3.2，Q-3a）：与 applySteer 同构的
   * user + isSteer entry，instanceId=目标实例（标注干预对象）；turnId 语义同
   * applySteer（挂当前 open turn，无 open turn → null）。**不入主 SteerQueue**
   * （目标是 SubAgent，不经主线 turn 边界 drain——投递由 agent_send 链即时完成）、
   * **不双写实例 channel**（appendInstanceMessage 不用于 user steer，单事实源）。
   */
  applyDirectedSteer(text: string, instanceId: string, at?: string): Entry {
    if (isMainInstanceId(instanceId, this.mainInstanceId)) {
      throw new DomainError(
        `主实例 steer 请走 applySteer（需 open turn 且入 SteerQueue），applyDirectedSteer 仅限 SubAgent 目标`,
      );
    }
    return this.pushEntry("user", text, this.currentTurn?.id ?? null, true, at, undefined, instanceId);
  }

  /** 注入入队（applySteer/restoreSteer 共用）：入队前做空文本校验（与
   *  Entry.create 同口径——落盘延迟到 drain，校验不能随之延迟）；id 预分配
   * （D-2：steer.queued 事件/回执/drain 落盘同源；abort 丢弃成空洞无害）。 */
  private enqueueSteer(text: string, source: SteerSource | undefined): string {
    if (text.trim().length === 0) {
      throw new DomainError("内容不能为空");
    }
    const entryId = this.reserveEntryId();
    this.steerQueue.enqueue({ entryId, text, ...(source !== undefined ? { source } : {}) });
    return entryId;
  }

  private pushEntry(
    role: "user" | "assistant" | "tool",
    text: string,
    turnId: string | null,
    isSteer: boolean,
    at?: string,
    reservedId?: string,
    instanceId?: string,
    images?: readonly string[],
    source?: SteerSource,
  ): Entry {
    const entry = Entry.create({
      id: reservedId ?? `e${this.nextEntrySeq++}`,
      role,
      text,
      turnId,
      isSteer,
      // 实例归属参数化——主线条目缺省本会话主实例 id；SubAgent 条目经（AD-3）
      // appendInstanceMessage 携带自身实例 id（会话投影消费事件后落树）
      instanceId: instanceId ?? this.mainInstanceId,
      createdAt: at ?? new Date().toISOString(),
      // 仅 user 消息携带图片附件（校验后 data URL 原样；其余角色 undefined）
      ...(images !== undefined && images.length > 0 ? { images: [...images] } : {}),
      // 注入来源（仅注入类 user 条目携带；缺省不携带保持旧形状）
      ...(source !== undefined ? { source } : {}),
    });
    this.entries.push(entry);
    return entry;
  }

  /**
   * SubAgent 实例消息落树（会话投影，AD-3：SubAgent Entry 进聚合）：
   * id 由事件发布侧分配（agent 作用域 `${instanceId}#N`，不占主计数器）；
   * 不挂主线轮次（turnId=null——实例条目与主线 Turn 无关，MainAgent 上下文
   * 零混入）；归属 instanceId 必填（区别于主线条目的 main 缺省）。
   */
  appendInstanceMessage(data: {
    readonly id: string;
    readonly instanceId: string;
    readonly text: string;
    readonly createdAt: string;
  }): Entry {
    if (isMainInstanceId(data.instanceId, this.mainInstanceId)) {
      throw new DomainError(
        `主实例条目请走 appendUserEntry/appendAssistantEntry（轮次关联由主线编排管），appendInstanceMessage 仅限 SubAgent 实例条目`,
      );
    }
    return this.pushEntry("assistant", data.text, null, false, data.createdAt, data.id, data.instanceId);
  }

  /**
   * 追加 thinking 完成态条目（id 同计数器；turn 关联在领域事件 turnId 侧）。
   * id 可显式携带（SubAgent 条目——事件发布侧 agent 作用域分配，
   * 投影/恢复回放落树时保持与事件载荷同 id；主线条目缺省内部计数器）。
   */
  appendThinkingEntry(data: Omit<ThinkingEntryData, "id"> & { id?: string }): ThinkingEntry {
    const entry = ThinkingEntry.create({ ...data, id: data.id ?? `e${this.nextEntrySeq++}` });
    this.entries.push(entry);
    return entry;
  }

  /** 追加 compaction 里程碑条目（会话级事件，不挂 turn）。 */
  appendCompactionEntry(data: Omit<CompactionEntryData, "id">): CompactionEntry {
    const entry = CompactionEntry.create({ ...data, id: `e${this.nextEntrySeq++}` });
    this.entries.push(entry);
    return entry;
  }

  /**
   * 追加 error 条目（error entry 批：引擎/模型失败落时间轴原位红条）。
   * 要求 open turn——错误总属于某个失败轮（轮次失败收尾时先落错误条目
   * 再收口，不违反轮次不变式 TR-25）；turnId 由聚合挂当前 open turn
   * （原位锚，调用方不指定）。无 open turn 抛错（与 appendAssistantEntry
   * 同口径）。
   */
  appendErrorEntry(data: Omit<ErrorEntryData, "id" | "turnId"> & { id?: string }): ErrorEntry {
    const turn = this.requireOpenTurn("appendErrorEntry");
    const entry = ErrorEntry.create({ ...data, id: data.id ?? `e${this.nextEntrySeq++}`, turnId: turn.id });
    this.entries.push(entry);
    return entry;
  }

  // ── Turn 生命周期（聚合中介，Service 不直接摸 Turn 状态迁移） ──

  /** 开新轮次；open turn 未收尾（completed/interrupted）前抛错（防重入）。 */
  beginTurn(inputEntryId: string, at?: string): Turn {
    if (this.currentTurn !== null) {
      throw new DomainError(
        `会话 ${this.id} 轮次 ${this.currentTurn.id} 未收尾（${this.currentTurn.status}），不能开始新轮次`,
      );
    }
    const turn = Turn.create({
      id: `t${this.nextTurnSeq++}`,
      inputEntryId,
      status: "generating",
      startedAt: at ?? new Date().toISOString(),
      endedAt: null,
    });
    this.turns.push(turn);
    this.currentTurn = turn;
    return turn;
  }

  /** 正常收尾当前轮次。 */
  completeTurn(at?: string): Turn {
    const turn = this.requireOpenTurn("completeTurn");
    turn.complete(at);
    this.currentTurn = null;
    return turn;
  }

  /** 中断当前轮次（abort 非销毁：收尾后仍可 beginTurn 开新轮）。 */
  interruptTurn(at?: string): Turn {
    const turn = this.requireOpenTurn("interruptTurn");
    turn.interrupt(at);
    this.currentTurn = null;
    return turn;
  }

  /** 引擎事件：本轮第一个工具开始（generating→toolRunning）。 */
  markTurnToolRunning(): void {
    this.requireOpenTurn("markTurnToolRunning").markToolRunning();
  }

  /** 引擎事件：工具批结束、assistant 继续生成（toolRunning→generating）。 */
  resumeTurnGenerating(): void {
    this.requireOpenTurn("resumeTurnGenerating").resumeGenerating();
  }

  // ── Steer 队列 ─────────────────────────────────────────────

  get steerQueueSize(): number {
    return this.steerQueue.size();
  }

  /** turn 边界 drain：取最旧一条（one-at-a-time）。 */
  dequeueSteer(): SteerItem | undefined {
    return this.steerQueue.dequeue();
  }

  /** 整批取出（终局收口/测试观测）。 */
  drainAllSteer(): SteerItem[] {
    return this.steerQueue.drain();
  }

  // ── 观测面 ────────────────────────────────────────────────

  get turnCount(): number {
    return this.turns.length;
  }
  get openTurn(): Turn | null {
    return this.currentTurn;
  }
  entryList(): SessionEntryData[] {
    return this.entries.map((e) => e.toData());
  }
  /** 草稿判定单一事实源：任何条目皆无（含 thinking/compaction）才空；
   * 直读 entries.length 零拷贝（谓词，形态同 Turn.isSteerable）。 */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }
  turnList(): TurnData[] {
    return this.turns.map((t) => t.toData());
  }

  // ── 快照往返（write-through / 恢复的统一载荷） ─────────────

  toSnapshot(): SessionSnapshot {
    return {
      sessionId: this.id,
      createdAt: this.createdAt,
      mainInstanceId: this.mainInstanceId,
      ...(this.mode !== undefined ? { mode: this.mode } : {}),
      entries: this.entryList(),
      turns: this.turnList(),
      pendingSteer: this.steerQueue.toData(),
    };
  }

  /** 从快照重建等价聚合（RestoreService 用；行为延续：id 计数器不回卷）。 */
  static restoreFrom(snapshot: SessionSnapshot): Session {
    // 旧快照无 mainInstanceId（列前时代）→ legacy "main"（该会话历史行
    // instance_id="main" 不重写，主实例 id 保持 "main" 与历史数据自闭合）
    const s = new Session(snapshot.sessionId, snapshot.createdAt, snapshot.mainInstanceId ?? LEGACY_MAIN_INSTANCE_ID, snapshot.mode);
    for (const e of snapshot.entries) {
      // 旧版快照 entries 无 instanceId（列前时代）：兜底回填主实例（TR-AD-14
      // 同精神——fromRow/restore 对旧行数据前向兼容，回填该会话主实例 id）
      if ("role" in e) {
        s.entries.push(Entry.create({ ...e, instanceId: e.instanceId ?? s.mainInstanceId }));
      } else if (e.kind === "thinking") {
        s.entries.push(ThinkingEntry.create(e));
      } else if (e.kind === "error") {
        s.entries.push(ErrorEntry.create(e));
      } else {
        s.entries.push(CompactionEntry.create(e));
      }
    }
    for (const t of snapshot.turns) {
      s.turns.push(Turn.create({ ...t }));
    }
    s.steerQueueFrom(snapshot.pendingSteer);
    // 计数器从数据推导（对任意来源的快照稳健），不依赖快照额外字段。
    // pendingSteer 预分配 id 必须纳入下界（drain 落盘语义：队列项持有未来
    // entry 的 id——跳过它会让恢复后新分配 id 与队列项冲突）
    s.nextEntrySeq = Math.max(
      s.entries.reduce(maxSeq("e"), 0),
      snapshot.pendingSteer.reduce((acc, item) => maxSeq("e")(acc, { id: item.entryId }), 0),
    ) + 1;
    s.nextTurnSeq = s.turns.reduce(maxSeq("t"), 0) + 1;
    // open turn（generating/toolRunning）恢复后仍是 open——由恢复方决定收口方式
    s.currentTurn = [...s.turns].reverse().find((t) => t.status === "generating" || t.status === "toolRunning") ?? null;
    return s;
  }

  private steerQueueFrom(items: readonly SteerItem[]): void {
    const restored = SteerQueue.fromData([...items]);
    for (const item of restored.drain()) this.steerQueue.enqueue(item);
  }

  private requireOpenTurn(op: string): Turn {
    if (this.currentTurn === null) {
      throw new DomainError(`会话 ${this.id} 无进行中的轮次，${op} 不合法`);
    }
    return this.currentTurn;
  }
}

/** 从 "e12"/"t3" 形 id 提取序号取最大（计数器重建用）。 */
function maxSeq(prefix: string): (acc: number, item: { id: string }) => number {
  return (acc, item) => {
    const n = item.id.startsWith(prefix) ? Number.parseInt(item.id.slice(prefix.length), 10) : NaN;
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  };
}
