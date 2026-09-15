import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { SchedulingBudget, SchedulingConfigPort } from "../../../application/ports/outbound/SchedulingConfigPort";
import { makeKvConfigStore, type KvConfigStore } from "./KvConfigStore";

/**
 * SchedulingConfigStore —— SubAgent 调度预算配置的语义包装
 * （CompactionConfigStore 同构：RuntimeConfigPort KV 上 scheduling_config
 * 键 JSON 读写，缺省回落 domain DEFAULT_SCHEDULING）。写面经
 * RuntimeConfigPort → WriteQueue 单写通道（AG-06）。骨架收编于
 * makeKvConfigStore（code-review 低危组7）。
 *
 * 单键 JSON 而非双键：set 一次落盘原子（maxConcurrent/maxQueued 不半写）；
 * 读面非法值（脏数据/旧格式）回落默认，不抛错。
 *
 * 消费面（2026-09-05 迁移）：SchedulerService 经装配层工厂
 * `() => new SchedulingPolicy(store.current())` 每次预算判定现拍——
 * 设置页 set 完成后下一次 decideSpawn 即生效（无需重启）。
 */
export class SchedulingConfigStore implements SchedulingConfigPort {
  private readonly store: KvConfigStore<SchedulingBudget>;

  constructor(
    runtimeConfig: RuntimeConfigPort,
    fallback: SchedulingBudget,
  ) {
    this.store = makeKvConfigStore(runtimeConfig, {
      key: "scheduling_config",
      parse: parseSchedulingBudget,
      fallback,
      clone: (v) => ({ ...v }),
      serialize: (v) => JSON.stringify(v),
      warnLabel: "SchedulingConfigStore",
    });
  }

  /** 当前生效调度预算（存储值 ?? 内置默认；db 已关闭 → 最近已知值）。 */
  current(): SchedulingBudget {
    return this.store.current();
  }

  /** 写入调度预算（单写通道，落盘完成即返回；同步观测缓存）。 */
  set(budget: SchedulingBudget): Promise<void> {
    return this.store.set(budget);
  }
}

/** 解析 KV JSON 值 → SchedulingBudget；非法/缺失字段回落 undefined（调用方取默认）。 */
function parseSchedulingBudget(raw: string | undefined): SchedulingBudget | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const maxConcurrent = parsed["maxConcurrent"];
    const maxQueued = parsed["maxQueued"];
    if (typeof maxConcurrent !== "number" || typeof maxQueued !== "number") return undefined;
    if (!Number.isInteger(maxConcurrent) || !Number.isInteger(maxQueued)) return undefined;
    if (maxConcurrent < 1 || maxQueued < 0) return undefined;
    return { maxConcurrent, maxQueued };
  } catch {
    return undefined;
  }
}
