/**
 * StewardTuning —— 管家行为阈值配置域（DDD 重构批 0：纯搬家 KV 化）。
 *
 * 定位：管家域全部生命周期阈值的**单源缺省 + KV 解析**（设计文档
 * docs/temp/steward-ddd-redesign.md §3.3）。批 0 前这些值是
 * StewardService/StewardPerceptionService 的硬编码 export const；本模块
 * 把它们收编为值对象，经 helix.db runtime KV（steward.tuning.* 键族）
 * 可改，非法值静默回退缺省 + warn（memoryConfig.resolveMemoryRecallParams
 * 同款哲学：配置绝不挡对话）。**先不上设置页 UI（裁决 #3）**。
 *
 * 值语义纪律：
 * - 合法值 = 正整数文本且落在该键 [min,max] 域内（域表 STEWARD_TUNING_BOUNDS）；
 * - 缺席/空串 = 未配置态 → 缺省值（零行为变化——批 0 纯搬家不变量）；
 * - 非法值（非数/负数/小数/零/超域）→ 静默回退缺省 + warn 不抛错；
 * - 逐键独立回退（无组合校验——各键语义互不约束）。
 *
 * 边界设计（域下限防「误配即疯狂」：watchdogMs 配 100 会把看门狗变成
 * 秒级 abort 风暴；域上限防失控量级）：
 * - run.watchdogMs [10s, 1h]：被动看门狗挂起判定（缺省 180s）；
 * - run.watchdogTickMs [1s, 60s]：巡检节拍（缺省 5s）；
 * - run.watchdogAbortGraceMs [1s, 5min]：abort 后强制收口宽限（缺省 15s）；
 * - run.manualAbortGraceMs [1s, 2min]：手动停止快进宽限（缺省 8s，E-285）；
 * - run.maxToolRounds [1, 50]：工具轮熔断（缺省 6）；
 * - ask.queueMax [1, 10]：排队上限（缺省 3）；
 * - confirm.ttlMs [30s, 1h]：确认卡有效期（缺省 300s）；
 * - confirm.remindAfterMs [5s, 10min]：可达性提醒（缺省 30s）；
 * - activation.windowMs [30s, 1h]：感知激活衰减窗（缺省 5min）。
 *
 * 为什么存在：管家语音/文字双场景对阈值容忍度不同（10-09 卡死事故实证
 * 180s 对语音太慢），阈值必须按场景可调而无需改代码（用户偏好 id=167：
 * 阈值落配置域并留边界合法值）。domain 层零 IO：解析函数收窄接口
 * `{ get(key) }`（结构类型兼容 RuntimeConfigPort，不 import IO 类型）。
 */

// ── 值对象 ──────────────────────────────────────────────────

/** 管家生命周期阈值生效值（只读快照——tuningOf() 现拍）。 */
export interface StewardTuning {
  /** run 执行轮域。 */
  readonly run: {
    /** 看门狗：无事件推进挂起判定窗（ms）。 */
    readonly watchdogMs: number;
    /** 可靠性巡检节拍（ms）。 */
    readonly watchdogTickMs: number;
    /** 看门狗 abort 后强制收口宽限（ms）。 */
    readonly watchdogAbortGraceMs: number;
    /** 手动 abort 快进强制收口宽限（ms）。 */
    readonly manualAbortGraceMs: number;
    /** 工具循环熔断轮数。 */
    readonly maxToolRounds: number;
  };
  /** ask 输入域。 */
  readonly ask: {
    /** 排队上限（溢出拒新）。 */
    readonly queueMax: number;
  };
  /** 确认闸域。 */
  readonly confirm: {
    /** pending 卡 TTL（ms，超时自动作废）。 */
    readonly ttlMs: number;
    /** 可达性提醒（ms，无人消费出提醒）。 */
    readonly remindAfterMs: number;
  };
  /** 感知激活域。 */
  readonly activation: {
    /** 近期 ask 衰减窗（ms——投递面激活判据）。 */
    readonly windowMs: number;
  };
}

/** 缺省值单源（= 批 0 前各硬编码常量原值——纯搬家，零行为变化）。 */
export const STEWARD_TUNING_DEFAULTS: StewardTuning = {
  run: {
    watchdogMs: 180_000,
    watchdogTickMs: 5_000,
    watchdogAbortGraceMs: 15_000,
    manualAbortGraceMs: 8_000,
    maxToolRounds: 6,
  },
  ask: { queueMax: 3 },
  confirm: { ttlMs: 300_000, remindAfterMs: 30_000 },
  activation: { windowMs: 300_000 },
};

// ── KV 键位（steward.tuning.* 键族，runtime_config 表）─────────

export const STEWARD_TUNING_KEYS = {
  runWatchdogMs: "steward.tuning.run.watchdogMs",
  runWatchdogTickMs: "steward.tuning.run.watchdogTickMs",
  runWatchdogAbortGraceMs: "steward.tuning.run.watchdogAbortGraceMs",
  runManualAbortGraceMs: "steward.tuning.run.manualAbortGraceMs",
  runMaxToolRounds: "steward.tuning.run.maxToolRounds",
  askQueueMax: "steward.tuning.ask.queueMax",
  confirmTtlMs: "steward.tuning.confirm.ttlMs",
  confirmRemindAfterMs: "steward.tuning.confirm.remindAfterMs",
  activationWindowMs: "steward.tuning.activation.windowMs",
} as const;

/** 逐键合法域 [min,max]（边界含端点；域外 = 非法回退）。 */
export const STEWARD_TUNING_BOUNDS = {
  runWatchdogMs: { min: 10_000, max: 3_600_000 },
  runWatchdogTickMs: { min: 1_000, max: 60_000 },
  runWatchdogAbortGraceMs: { min: 1_000, max: 300_000 },
  runManualAbortGraceMs: { min: 1_000, max: 120_000 },
  runMaxToolRounds: { min: 1, max: 50 },
  askQueueMax: { min: 1, max: 10 },
  confirmTtlMs: { min: 30_000, max: 3_600_000 },
  confirmRemindAfterMs: { min: 5_000, max: 600_000 },
  activationWindowMs: { min: 30_000, max: 3_600_000 },
} as const;

// ── 解析（纯函数，零 IO——窄接口结构类型兼容 RuntimeConfigPort）────

/** 正整数文本解析（"5" → 5；0/负数/小数/非数字/超安全整数 → null）。 */
function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 单键解析：缺席/空串 → 缺省；非法/域外 → 缺省 + warn。 */
function resolveNumber(
  raw: string | undefined,
  fallback: number,
  bounds: { readonly min: number; readonly max: number },
  label: string,
  warn?: (message: string) => void,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = parsePositiveInt(raw);
  if (parsed === null || parsed < bounds.min || parsed > bounds.max) {
    warn?.(`steward.tuning.${label} 非法（${raw}，合法域 [${bounds.min}, ${bounds.max}]）——回退缺省 ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * 生效值读面（值语义单点裁决）：KV 原值 → StewardTuning 快照。
 * 逐键独立解析，非法静默回退缺省 + warn 不抛错；缺席/空串 = 未配置态。
 * 调用方（组合根 tuningOf）每次现拍——运行期改 KV 即热生效，无需重启。
 */
export function resolveStewardTuning(
  config: { readonly get: (key: string) => string | undefined },
  warn?: (message: string) => void,
): StewardTuning {
  return {
    run: {
      watchdogMs: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.runWatchdogMs),
        STEWARD_TUNING_DEFAULTS.run.watchdogMs,
        STEWARD_TUNING_BOUNDS.runWatchdogMs,
        "run.watchdogMs",
        warn,
      ),
      watchdogTickMs: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.runWatchdogTickMs),
        STEWARD_TUNING_DEFAULTS.run.watchdogTickMs,
        STEWARD_TUNING_BOUNDS.runWatchdogTickMs,
        "run.watchdogTickMs",
        warn,
      ),
      watchdogAbortGraceMs: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.runWatchdogAbortGraceMs),
        STEWARD_TUNING_DEFAULTS.run.watchdogAbortGraceMs,
        STEWARD_TUNING_BOUNDS.runWatchdogAbortGraceMs,
        "run.watchdogAbortGraceMs",
        warn,
      ),
      manualAbortGraceMs: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.runManualAbortGraceMs),
        STEWARD_TUNING_DEFAULTS.run.manualAbortGraceMs,
        STEWARD_TUNING_BOUNDS.runManualAbortGraceMs,
        "run.manualAbortGraceMs",
        warn,
      ),
      maxToolRounds: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.runMaxToolRounds),
        STEWARD_TUNING_DEFAULTS.run.maxToolRounds,
        STEWARD_TUNING_BOUNDS.runMaxToolRounds,
        "run.maxToolRounds",
        warn,
      ),
    },
    ask: {
      queueMax: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.askQueueMax),
        STEWARD_TUNING_DEFAULTS.ask.queueMax,
        STEWARD_TUNING_BOUNDS.askQueueMax,
        "ask.queueMax",
        warn,
      ),
    },
    confirm: {
      ttlMs: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.confirmTtlMs),
        STEWARD_TUNING_DEFAULTS.confirm.ttlMs,
        STEWARD_TUNING_BOUNDS.confirmTtlMs,
        "confirm.ttlMs",
        warn,
      ),
      remindAfterMs: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.confirmRemindAfterMs),
        STEWARD_TUNING_DEFAULTS.confirm.remindAfterMs,
        STEWARD_TUNING_BOUNDS.confirmRemindAfterMs,
        "confirm.remindAfterMs",
        warn,
      ),
    },
    activation: {
      windowMs: resolveNumber(
        config.get(STEWARD_TUNING_KEYS.activationWindowMs),
        STEWARD_TUNING_DEFAULTS.activation.windowMs,
        STEWARD_TUNING_BOUNDS.activationWindowMs,
        "activation.windowMs",
        warn,
      ),
    },
  };
}
