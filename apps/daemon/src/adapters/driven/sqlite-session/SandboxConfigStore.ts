import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { SandboxConfig, SandboxConfigPort } from "../../../application/ports/outbound/SandboxConfigPort";
import { isDbClosedError } from "./RuntimeConfigStore";

/**
 * SandboxConfigStore —— 沙箱开关配置的语义包装（沙箱开关批，2026-09-12；
 * SchedulingConfigStore 同构模板：RuntimeConfigPort KV 上 sandbox_config
 * 键 JSON 读写，缺省回落关——失败安全方向是「不沙箱」而非「锁死」）。
 * 写面经 RuntimeConfigPort → WriteQueue 单写通道（AG-06）。
 *
 * 单键 JSON 而非布尔直存：后续扩展位（额外 roots/网络档）不换键格式。
 *
 * 消费面生效语义：装配期定格（main 会话创建 + SubAgent spawn 父进程读），
 * 非运行期即热——set 完成后新会话/新任务生效。
 */
export class SandboxConfigStore implements SandboxConfigPort {
  /** KV 里的沙箱开关键名（JSON 序列化 {enabled}）。 */
  private static readonly KEY = "sandbox_config";

  /** 最近已知值（shutdown 后 db 关闭时的读面兜底）。 */
  private cached: SandboxConfig;

  constructor(private readonly runtimeConfig: RuntimeConfigPort) {
    this.cached = { enabled: false };
  }

  /** 当前生效开关（存储值 ?? 缺省关；db 已关闭 → 最近已知值）。 */
  current(): SandboxConfig {
    try {
      const raw = this.runtimeConfig.get(SandboxConfigStore.KEY);
      const parsed = parseSandboxConfig(raw);
      if (parsed !== undefined) this.cached = parsed;
    } catch (error) {
      // db 已关闭（daemon 收尾后观测面）——最近已知值；非关闭类不静默
      if (!isDbClosedError(error)) {
        console.warn(`SandboxConfigStore 读面异常（非 db 关闭类）：${(error as Error).message}`);
      }
    }
    return this.cached;
  }

  /** 写入开关（单写通道，落盘完成即返回；同步观测缓存）。 */
  async set(config: SandboxConfig): Promise<void> {
    this.cached = { enabled: config.enabled };
    await this.runtimeConfig.set(SandboxConfigStore.KEY, JSON.stringify(config));
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
