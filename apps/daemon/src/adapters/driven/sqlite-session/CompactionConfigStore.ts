import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { CompactionConfig, CompactionConfigPort } from "../../../application/ports/outbound/CompactionConfigPort";
import { makeKvConfigStore, type KvConfigStore } from "./KvConfigStore";

/**
 * CompactionConfigStore —— 压缩参数配置的语义包装（DefaultModelStore 同构：
 * RuntimeConfigPort KV 上 compaction_config 键（JSON 序列化）读写，缺省回落
 * AgentProfile.DEFAULT_COMPACTION）。写面经 RuntimeConfigPort → WriteQueue
 * 单写通道（AG-06）。骨架收编于 makeKvConfigStore（code-review 低危组7）。
 *
 * 单键 JSON 而非双键：set 一次落盘原子（reserveTokens/keepRecentTokens 不
 * 半写）；读面非法值（脏数据/旧格式）回落默认，不抛错。
 */
export class CompactionConfigStore implements CompactionConfigPort {
  private readonly store: KvConfigStore<CompactionConfig>;

  constructor(
    runtimeConfig: RuntimeConfigPort,
    fallback: CompactionConfig,
  ) {
    this.store = makeKvConfigStore(runtimeConfig, {
      key: "compaction_config",
      parse: parseCompactionConfig,
      fallback,
      clone: (v) => ({ ...v }),
      serialize: (v) => JSON.stringify(v),
      warnLabel: "CompactionConfigStore",
    });
  }

  /** 当前生效压缩参数（存储值 ?? 内置默认；db 已关闭 → 最近已知值）。 */
  current(): CompactionConfig {
    return this.store.current();
  }

  /** 写入压缩参数（单写通道，落盘完成即返回；同步观测缓存）。 */
  set(config: CompactionConfig): Promise<void> {
    return this.store.set(config);
  }
}

/** 解析 KV JSON 值 → CompactionConfig；非法/缺失字段回落 undefined（调用方取默认）。 */
function parseCompactionConfig(raw: string | undefined): CompactionConfig | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const reserveTokens = parsed["reserveTokens"];
    const keepRecentTokens = parsed["keepRecentTokens"];
    if (typeof reserveTokens !== "number" || typeof keepRecentTokens !== "number") return undefined;
    if (!Number.isInteger(reserveTokens) || !Number.isInteger(keepRecentTokens)) return undefined;
    if (reserveTokens < 0 || keepRecentTokens < 0) return undefined;
    return { reserveTokens, keepRecentTokens };
  } catch {
    return undefined;
  }
}
