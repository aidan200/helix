import { DomainError } from "../DomainError";

/**
 * SchedulingPolicy —— SubAgent 调度策略（architecture.md §4.1，/AD-7 整包）。
 *
 * domain 纯数据 + 判定（零 import 外层，framework-free 可单测）：
 * - decideSpawn：预算三分支（run / enqueue / reject）；
 * - nextPosition：FIFO 位次（1 起，出队后调用方按队列序整体递减重发）；
 * - isStalled：idle 超阈值判定（警示不自动杀；阈值可注入小值）。
 *
 * 优先级调度本迭代不做（无竞争场景，AD-7③）；hard 超时无上限不自动杀
 * （手动终止权在用户）。「队列不落盘」（AD-10）是消费方（SchedulerService）
 * 的边界，本策略不涉持久化。
 */

/** 策略缺省值（config.json 可覆写前两位，与 AD-7①② 对齐）。 */
export const DEFAULT_SCHEDULING = {
  /** 运行中 SubAgent 实例数上限（daemon 全局预算，TR-AD-11 单例语义）。 */
  maxConcurrent: 3,
  /** FIFO 排队上限；达上限才报错回 LLM（预算真实耗尽，②）。 */
  maxQueued: 8,
  /** stalled 阈值：idle > 5min 无事件增量（§4.1）。 */
  stalledThresholdMs: 300_000,
} as const;

export interface SchedulingPolicyOptions {
  /** 运行中 SubAgent 上限；缺省 3。 */
  readonly maxConcurrent?: number;
  /** FIFO 队列上限；缺省 8。 */
  readonly maxQueued?: number;
  /** stalled 判定阈值 ms；缺省 300_000（5min）。测试可注入小值。 */
  readonly stalledThresholdMs?: number;
}

/** 预算判定结果：run=预算内直跑；enqueue=超限入队；reject=队列满报错回 LLM。 */
export type SpawnDecision =
  | { readonly action: "run" }
  | { readonly action: "enqueue" }
  | { readonly action: "reject" };

export class SchedulingPolicy {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly stalledThresholdMs: number;

  constructor(options: SchedulingPolicyOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_SCHEDULING.maxConcurrent;
    this.maxQueued = options.maxQueued ?? DEFAULT_SCHEDULING.maxQueued;
    this.stalledThresholdMs = options.stalledThresholdMs ?? DEFAULT_SCHEDULING.stalledThresholdMs;

    assertPositiveInt(this.maxConcurrent, "maxConcurrent", 1);
    assertPositiveInt(this.maxQueued, "maxQueued", 0);
    assertPositiveInt(this.stalledThresholdMs, "stalledThresholdMs", 1);
  }

  /**
   * 预算判定（机械判据）：
   * ① running < maxConcurrent → run（队列水位不影响——有空位就跑）；
   * ② 运行位满且 queued < maxQueued → enqueue；
   * ③ 运行位满且队列满 → reject（错误回 LLM，不抛并发错误——②）。
   */
  decideSpawn(running: number, queued: number): SpawnDecision {
    if (running < this.maxConcurrent) return { action: "run" };
    if (queued < this.maxQueued) return { action: "enqueue" };
    return { action: "reject" };
  }

  /**
   * 新入队实例的 FIFO 位次（1 起）：入队前队列长度 queued → 位次 queued+1。
   * 纯函数无副作用——出队后剩余位次递减由调用方按新队列序重新求值。
   */
  nextPosition(queued: number): number {
    return queued + 1;
  }

  /**
   * stalled 判定：idleMs = now - lastEventAt **严格大于**阈值才算（恰值不算，
   * §4.1「idle > 5min」）。lastEventAt = 该实例最近任意引擎事件时间戳
   * （epoch ms）——判定与推送不改变实例状态（仍 running）。
   */
  isStalled(lastEventAt: number, now: number): boolean {
    return now - lastEventAt > this.stalledThresholdMs;
  }
}

function assertPositiveInt(value: number, name: string, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new DomainError(`调度策略参数 ${name} 非法：${String(value)}（要求 ≥ ${min} 的整数）`);
  }
}
