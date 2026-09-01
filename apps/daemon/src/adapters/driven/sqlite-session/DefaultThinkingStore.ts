import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { DefaultThinkingPort } from "../../../application/ports/outbound/DefaultThinkingPort";

/**
 * DefaultThinkingStore —— 全局默认推理强度的语义包装（R7 全局兜底批；
 * DefaultModelStore 同构：RuntimeConfigPort KV 上 default_thinking 键
 * 读写，无 builtin 兜底——未配置 = null）。
 *
 * AD-2 分层语义与 default_model 同款：「经常变的状态不进 JSON」——落
 * SQLite KV；写面经 RuntimeConfigPort → WriteQueue 单写通道（AG-06）。
 */
export class DefaultThinkingStore implements DefaultThinkingPort {
  /** KV 里的全局默认推理强度键名。 */
  private static readonly KEY = "default_thinking";

  /** 最近已知值（shutdown 后 db 关闭时的读面兜底）。 */
  private cached: string | null = null;

  constructor(private readonly runtimeConfig: RuntimeConfigPort) {}

  /** KV 原值（未设置/空串 → null；db 已关闭 → 最近已知值）。 */
  stored(): string | null {
    try {
      const raw = this.runtimeConfig.get(DefaultThinkingStore.KEY);
      this.cached = raw === undefined || raw === "" ? null : raw;
    } catch {
      // db 已关闭（daemon 收尾后观测面）——最近已知值
    }
    return this.cached;
  }

  /** 写入（单写通道，落盘完成即返回；null = 清除键；同步观测缓存）。 */
  async set(level: string | null): Promise<void> {
    this.cached = level;
    await this.runtimeConfig.set(DefaultThinkingStore.KEY, level ?? "");
  }
}
