/**
 * steer 待注入消息（领域值对象）：applySteer 时生成，drain 时消费。
 *
 * entryId 指向 Session 内已落地的 user entry（isSteer=true），
 * text 是注入内容——两者一起进队列，drain 方既知道注入什么、也知道关联哪条 entry
 * （前端 steer 徽标「已入队 → 已注入」的两态都靠 entryId 观测）。
 *
 * +source：注入来源可区分（AD-8 双通道 + T11a 贯通）——user=用户输入转投；
 * closure=SubAgent 收口注入（`agent-N closure: …`，下轮 turn 边界 drain
 * 驱动 MainAgent 新 turn）；progress=周期进展报告（SchedulerService
 * injectClosure 同通道，T11a 起可区分）。FIFO 机制不变（同队列同语义，
 * 只加来源字段）。source 随 SQLite steer_queue.source 列持久化（T11a），
 * 冷恢复不丢；列前时代旧行 NULL → 缺省（= user 语义）。
 */

/** 注入来源三值枚举（helix 自有；与协议面 SteerSource 同值域，adapter 层映射）。 */
export type SteerSource = "user" | "closure" | "progress";

export interface SteerItem {
  readonly entryId: string;
  readonly text: string;
  /** 注入来源（缺省 user——旧调用方/恢复重建兼容）。 */
  readonly source?: SteerSource;
}

/**
 * steer 队列（architecture.md §3.3）：运行中注入的消息在此排队，
 * turn 边界 drain（时序契约：drain 边界 = turn_end 之后、turn_start 之前）。
 *
 * 默认消费语义 one-at-a-time：drain 点只取最旧一条（dequeue），
 * 其余留给后续 drain 点按入队顺序逐条消费；drain() 整批取出用于终局收口。
 */
export class SteerQueue {
  private readonly items: SteerItem[] = [];

  /** 入队（运行中注入即时可见，hasQueued 观测点）。 */
  enqueue(item: SteerItem): void {
    this.items.push(item);
  }

  /** 取最旧一条（one-at-a-time）；空队列返回 undefined。 */
  dequeue(): SteerItem | undefined {
    return this.items.shift();
  }

  /** 整批取出并清空（按入队顺序）。 */
  drain(): SteerItem[] {
    return this.items.splice(0, this.items.length);
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  size(): number {
    return this.items.length;
  }

  /** 快照用：只读视图（不暴露内部数组）。 */
  toData(): SteerItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  /** 恢复用：从快照重建（重启后未消费的 steer 仍可注入， ④）。 */
  static fromData(items: SteerItem[]): SteerQueue {
    const q = new SteerQueue();
    for (const i of items) q.enqueue({ ...i }); // 全字段保留（含 source——closure 注入重建后仍可区分）
    return q;
  }
}
