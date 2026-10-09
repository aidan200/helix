/**
 * AskQueue —— 管家输入队列值对象（DDD 重构批 2）。
 *
 * 定位：ask 自持队列（E-197 行为等价——上限/收口后自动下一轮）收编值对象。
 * 语义：FIFO 不丢（驱动序 = 入队序）；满拒新（溢出回执归调用方组装）；
 * clearAll = 停止词全停清空（返回被丢弃条数——回执 dropped 字段数据源）。
 *
 * 为什么存在：队列边界行为（上限/清空/驱动序）从散落操作收编为内聚语义，
 * 后续批 3 两轨停止收敛时队列语义演进的唯一改动点。
 */
export class AskQueue<T> {
  private readonly items: T[] = [];
  /** 上限现拍面（KV 即热——tuning.ask.queueMax 改后下一判即生效，批 0 口径）。 */
  private readonly maxOf: () => number;

  constructor(maxOf: () => number) {
    this.maxOf = maxOf;
  }

  get length(): number {
    return this.items.length;
  }

  /** 入队（FIFO 尾进）；满 → false 拒新（调用方组溢出回执）。 */
  tryPush(item: T): boolean {
    if (this.items.length >= this.maxOf()) return false;
    this.items.push(item);
    return true;
  }

  /** 队首驱动（收口后自动下一轮——序不变量：队列不丢）。 */
  shift(): T | undefined {
    return this.items.shift();
  }

  /** 全停清空（停止词——返回被丢弃条数，幂等）。 */
  clearAll(): number {
    const dropped = this.items.length;
    this.items.length = 0;
    return dropped;
  }
}
