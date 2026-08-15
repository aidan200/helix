import { DomainError } from "../DomainError";
import { Entry, type EntryData } from "./Entry";
import { Turn, type TurnData } from "./Turn";
import type { SessionSnapshot } from "./SessionSnapshot";
import { SteerQueue, type SteerItem } from "../agent/SteerQueue";

/**
 * 会话聚合根（architecture.md §3.3，AD-16：domain 层唯一权威状态）。
 *
 * 职责：Entry 序列 + Turn 序列 + SteerQueue 的整体一致性——
 * 所有变更都经聚合方法（充血模型），非法操作抛 DomainError：
 * - appendUserEntry 只在无 open turn 时合法（运行中的输入必须走 applySteer）；
 * - beginTurn 在 open turn 未收尾前抛错（同 lane 防重入，spike ④ 护栏的 domain 落地）；
 * - applySteer 只在可注入（generating/toolRunning）的轮次合法。
 *
 * 快照往返：toSnapshot() ↔ restoreFrom() 是持久化（write-through）与
 * 重启恢复（RestoreService）的统一载荷，重建后行为延续（计数器不回卷）。
 */
export class Session {
  private readonly entries: Entry[] = [];
  private readonly turns: Turn[] = [];
  private readonly steerQueue = new SteerQueue();
  private currentTurn: Turn | null = null;
  private nextEntrySeq = 1;
  private nextTurnSeq = 1;

  private constructor(
    readonly id: string,
    readonly createdAt: string,
  ) {}

  static create(id?: string, at?: string): Session {
    return new Session(id ?? crypto.randomUUID(), at ?? new Date(0).toISOString());
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

  /** 追加一条用户消息（仅无 open turn 时合法；运行中注入请用 applySteer）。 */
  appendUserEntry(text: string, at?: string): Entry {
    if (this.currentTurn !== null) {
      throw new DomainError(
        `会话 ${this.id} 当前轮次 ${this.currentTurn.id} 进行中，新输入必须经 applySteer 注入（或等待轮次结束）`,
      );
    }
    return this.pushEntry("user", text, null, false, at);
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

  /** 运行中注入 steer：落 isSteer entry + 入 SteerQueue（drain 前 domain 可观测）。 */
  applySteer(text: string, at?: string): Entry {
    const turn = this.requireOpenTurn("applySteer");
    if (!turn.isSteerable()) {
      throw new DomainError(`轮次 ${turn.id} 状态 ${turn.status} 不允许注入 steer（须为 generating/toolRunning）`);
    }
    const entry = this.pushEntry("user", text, turn.id, true, at);
    this.steerQueue.enqueue({ entryId: entry.id, text });
    return entry;
  }

  private pushEntry(
    role: "user" | "assistant" | "tool",
    text: string,
    turnId: string | null,
    isSteer: boolean,
    at?: string,
    reservedId?: string,
  ): Entry {
    const entry = Entry.create({
      id: reservedId ?? `e${this.nextEntrySeq++}`,
      role,
      text,
      turnId,
      isSteer,
      createdAt: at ?? new Date().toISOString(),
    });
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

  /** turn 边界 drain：取最旧一条（one-at-a-time，spike §5.3）。 */
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
  entryList(): EntryData[] {
    return this.entries.map((e) => e.toData());
  }
  turnList(): TurnData[] {
    return this.turns.map((t) => t.toData());
  }

  // ── 快照往返（write-through / 恢复的统一载荷） ─────────────

  toSnapshot(): SessionSnapshot {
    return {
      sessionId: this.id,
      createdAt: this.createdAt,
      entries: this.entryList(),
      turns: this.turnList(),
      pendingSteer: this.steerQueue.toData(),
    };
  }

  /** 从快照重建等价聚合（RestoreService 用；行为延续：id 计数器不回卷）。 */
  static restoreFrom(snapshot: SessionSnapshot): Session {
    const s = new Session(snapshot.sessionId, snapshot.createdAt);
    for (const e of snapshot.entries) {
      s.entries.push(Entry.create({ ...e }));
    }
    for (const t of snapshot.turns) {
      s.turns.push(Turn.create({ ...t }));
    }
    s.steerQueueFrom(snapshot.pendingSteer);
    // 计数器从数据推导（对任意来源的快照稳健），不依赖快照额外字段
    s.nextEntrySeq = s.entries.reduce(maxSeq("e"), 0) + 1;
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
