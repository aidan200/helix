/**
 * ActivationPolicy —— 管家主动环激活判定（批 4a：E-250 升级接点兑现）。
 *
 * 判据（设计 §3.2⑤）：Activation = presence(面板 ∨ 光球) ∧ recentAsk(衰减窗)。
 *
 * 为什么存在：原判据只有 feedGate.hasStewardSubscribers（面板订阅）——语音
 * 用户主形态是光球（不开面板），任务完成时判不在场 → done 静默 toast，
 * 人在旁边却没语音告知（E-201/E-202 行为断点、E-250 升级接点）。光球
 * 在场信号经 surface 事件 presence 上行（shell 光球层 duplex 边沿 + 周期
 * 续报），daemon 侧登记器维护光球位（TTL 防断连残留）。
 *
 * 纯函数（零 IO 零时钟持有——now 由调用方注入）；面板位保留 feedGate 代理
 * 判据（面板开 = 订阅 steward feed，连接级信号对该面是准的）。
 */

/** 激活判定输入（调用方现拍）。 */
export interface ActivationInput {
  /** 面板在场代理：steward feed 订阅连接在场（连接级——面板开即订阅）。 */
  readonly panelSubscribed: boolean;
  /** 光球最近在场信号时间戳（null = 从未上报）；负值 = 尚无。 */
  readonly orbPresentAt: number | null;
  /** 最近用户 ask 时间戳（负值/无 = 从未问过）。 */
  readonly lastAskAt: number;
  /** 当前时间。 */
  readonly now: number;
  /** ask 衰减窗（ms——presence 之外的另一半判据）。 */
  readonly askWindowMs: number;
  /** 光球在场信号 TTL（ms——超时视为离场：断连/崩溃残留防御）。 */
  readonly presenceTtlMs: number;
}

/** 光球在场位判定（TTL 内 = 在场）。 */
export function isOrbPresent(orbPresentAt: number | null, now: number, ttlMs: number): boolean {
  if (orbPresentAt === null || orbPresentAt < 0) return false;
  return now - orbPresentAt <= ttlMs;
}

/** 激活判定：presence(面板 ∨ 光球) ∧ recentAsk。 */
export function computeActivation(input: ActivationInput): boolean {
  // 半判据①：任一表面在场（面板订阅 ∨ 光球 TTL 内）
  const present = input.panelSubscribed || isOrbPresent(input.orbPresentAt, input.now, input.presenceTtlMs);
  if (!present) return false;
  // 半判据②：近期问过（衰减窗内——原 D12-⑪ 语义保留）
  if (input.lastAskAt < 0) return false;
  return input.now - input.lastAskAt <= input.askWindowMs;
}
