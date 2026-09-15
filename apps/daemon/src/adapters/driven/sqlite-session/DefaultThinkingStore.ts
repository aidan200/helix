import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { DefaultThinkingPort } from "../../../application/ports/outbound/DefaultThinkingPort";
import { makeKvConfigStore, type KvConfigStore } from "./KvConfigStore";

/**
 * DefaultThinkingStore —— 全局默认推理强度的语义包装（R7 全局兜底批；
 * DefaultModelStore 同构：RuntimeConfigPort KV 上 default_thinking 键
 * 读写，无 builtin 兜底——未配置 = null）。
 *
 * AD-2 分层语义与 default_model 同款：「经常变的状态不进 JSON」——落
 * SQLite KV；写面经 RuntimeConfigPort → WriteQueue 单写通道（AG-06）。
 * 骨架收编于 makeKvConfigStore（code-review 低危组7，四件同构收编）。
 */
export class DefaultThinkingStore implements DefaultThinkingPort {
  private readonly store: KvConfigStore<string | null>;

  constructor(runtimeConfig: RuntimeConfigPort) {
    this.store = makeKvConfigStore<string | null>(runtimeConfig, {
      key: "default_thinking",
      // 未配置/空串 = null（合法域值——显式「未配置」语义，非「不可用」哨兵）
      parse: (raw) => (raw === undefined || raw === "" ? null : raw),
      fallback: null,
      clone: (v) => v,
      serialize: (v) => v ?? "",
      warnLabel: "DefaultThinkingStore",
    });
  }

  /** KV 原值（未设置/空串 → null；db 已关闭 → 最近已知值）。 */
  stored(): string | null {
    return this.store.current();
  }

  /** 写入（单写通道，落盘完成即返回；null = 清除键；同步观测缓存）。 */
  set(level: string | null): Promise<void> {
    return this.store.set(level);
  }
}
