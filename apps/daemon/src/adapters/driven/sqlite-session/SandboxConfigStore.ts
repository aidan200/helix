import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { SandboxConfig, SandboxConfigPort } from "../../../application/ports/outbound/SandboxConfigPort";
import { makeKvConfigStore, type KvConfigStore } from "./KvConfigStore";

/**
 * SandboxConfigStore —— 沙箱开关配置的语义包装（沙箱开关批，2026-09-12；
 * SchedulingConfigStore 同构模板：RuntimeConfigPort KV 上 sandbox_config
 * 键 JSON 读写，缺省回落关——失败安全方向是「不沙箱」而非「锁死」）。
 * 写面经 RuntimeConfigPort → WriteQueue 单写通道（AG-06）。骨架收编于
 * makeKvConfigStore（code-review 低危组7）。
 *
 * 单键 JSON 而非布尔直存：后续扩展位（额外 roots/网络档）不换键格式。
 *
 * 消费面生效语义：装配期定格（main 会话创建 + SubAgent spawn 父进程读），
 * 非运行期即热——set 完成后新会话/新任务生效。
 */
export class SandboxConfigStore implements SandboxConfigPort {
  private readonly store: KvConfigStore<SandboxConfig>;

  constructor(runtimeConfig: RuntimeConfigPort) {
    this.store = makeKvConfigStore<SandboxConfig>(runtimeConfig, {
      key: "sandbox_config",
      parse: parseSandboxConfig,
      fallback: { enabled: false },
      clone: (v) => ({ enabled: v.enabled }),
      serialize: (v) => JSON.stringify(v),
      warnLabel: "SandboxConfigStore",
    });
  }

  /** 当前生效开关（存储值 ?? 缺省关；db 已关闭 → 最近已知值）。 */
  current(): SandboxConfig {
    return this.store.current();
  }

  /** 写入开关（单写通道，落盘完成即返回；同步观测缓存）。 */
  set(config: SandboxConfig): Promise<void> {
    return this.store.set(config);
  }
}

/** 解析 KV JSON 值 → SandboxConfig；非法/缺失 enabled → undefined（调用方保缺省关）。 */
function parseSandboxConfig(raw: string | undefined): SandboxConfig | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed["enabled"] !== "boolean") return undefined;
    return { enabled: parsed["enabled"] };
  } catch {
    return undefined;
  }
}
