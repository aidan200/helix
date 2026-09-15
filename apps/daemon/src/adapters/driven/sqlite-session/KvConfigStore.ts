import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import { isDbClosedError } from "./RuntimeConfigStore";

/**
 * makeKvConfigStore —— RuntimeConfigPort KV 上「键语义包装 store」的通用骨架
 * （DefaultThinkingStore / CompactionConfigStore / SandboxConfigStore /
 * SchedulingConfigStore 四件同构收编，code-review 低危组7）。
 *
 * 统一契约（四件既有语义的最大公约数）：
 * - 读：KV 原值经 parse 归一为域值；parse 返回 undefined（未配置/非法 JSON/
 *   形状不符）→ 保持最近已知值（构造期初值 = fallback 克隆）——与读面异常
 *   （db 已关闭等 catch 分支）同一兜底方向（观测面可用性优先：最近已知 >
 *   固定缺省 > 抛错）。收编决策：Compaction/Scheduling 原实现 parse 失败
 *   回落固定 fallback，与自身 catch 分支（保持最近值）不一致——统一取
 *   「保持最近值」；差异窗口仅限「曾成功读到合法值后 KV 被外部脏写」
 *   （daemon 内部写面只有 set，会同步缓存，无该窗口）。
 * - 写：同步观测缓存 + serialize 后经 RuntimeConfigPort → WriteQueue 单写
 *   通道（AG-06），await 返回即 write-through。
 */

/** 每件 store 的差异化参数（键名/解析/缺省/拷贝/序列化/观测文案）。 */
export interface KvConfigStoreOptions<T> {
  /** KV 键名。 */
  readonly key: string;
  /** KV 原值 → 域值；undefined = 不可用（保持最近已知值）。 */
  readonly parse: (raw: string | undefined) => T | undefined;
  /** 缺省值（最近已知值初值）。 */
  readonly fallback: T;
  /** 域值拷贝（cached 与外部传入对象解耦——对象值件用 { ...v } 语义）。 */
  readonly clone: (value: T) => T;
  /** 写面序列化。 */
  readonly serialize: (value: T) => string;
  /** 读面非关闭类异常 warn 文案前缀（调用方类名）。 */
  readonly warnLabel: string;
}

/** 工厂产物形状（薄壳 store 类委托面）。 */
export interface KvConfigStore<T> {
  /** 当前生效值（KV 不可用/读面异常 → 最近已知值；初值 = fallback）。 */
  current(): T;
  /** 写入（单写通道，落盘完成即返回；同步观测缓存）。 */
  set(value: T): Promise<void>;
}

export function makeKvConfigStore<T>(
  runtimeConfig: RuntimeConfigPort,
  options: KvConfigStoreOptions<T>,
): KvConfigStore<T> {
  let cached = options.clone(options.fallback);
  return {
    current(): T {
      try {
        const parsed = options.parse(runtimeConfig.get(options.key));
        if (parsed !== undefined) cached = parsed;
      } catch (error) {
        // db 已关闭（daemon 收尾后观测面）——最近已知值；非关闭类不静默
        if (!isDbClosedError(error)) {
          console.warn(`${options.warnLabel} 读面异常（非 db 关闭类）：${(error as Error).message}`);
        }
      }
      return cached;
    },
    async set(value: T): Promise<void> {
      cached = options.clone(value);
      await runtimeConfig.set(options.key, options.serialize(value));
    },
  };
}
