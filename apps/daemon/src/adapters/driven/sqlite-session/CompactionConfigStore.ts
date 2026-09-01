import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { CompactionConfig, CompactionConfigPort } from "../../../application/ports/outbound/CompactionConfigPort";

/**
 * CompactionConfigStore —— 压缩参数配置的语义包装（DefaultModelStore 同构：
 * RuntimeConfigPort KV 上 compaction_config 键（JSON 序列化）读写，缺省回落
 * AgentProfile.DEFAULT_COMPACTION）。写面经 RuntimeConfigPort → WriteQueue
 * 单写通道（AG-06）。
 *
 * 单键 JSON 而非双键：set 一次落盘原子（reserveTokens/keepRecentTokens 不
 * 半写）；读面非法值（脏数据/旧格式）回落默认，不抛错。
 */
export class CompactionConfigStore implements CompactionConfigPort {
  /** KV 里的压缩参数键名（JSON 序列化 {reserveTokens, keepRecentTokens}）。 */
  private static readonly KEY = "compaction_config";

  /** 最近已知值（shutdown 后 db 关闭时的读面兜底）。 */
  private cached: CompactionConfig;

  constructor(
    private readonly runtimeConfig: RuntimeConfigPort,
    private readonly fallback: CompactionConfig,
  ) {
    this.cached = { ...fallback };
  }

  /** 当前生效压缩参数（存储值 ?? 内置默认；db 已关闭 → 最近已知值）。 */
  current(): CompactionConfig {
    try {
      const raw = this.runtimeConfig.get(CompactionConfigStore.KEY);
      this.cached = parseCompactionConfig(raw) ?? { ...this.fallback };
    } catch {
      // db 已关闭（daemon 收尾后观测面）——最近已知值
    }
    return this.cached;
  }

  /** 写入压缩参数（单写通道，落盘完成即返回；同步观测缓存）。 */
  async set(config: CompactionConfig): Promise<void> {
    this.cached = { ...config };
    await this.runtimeConfig.set(CompactionConfigStore.KEY, JSON.stringify(config));
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
