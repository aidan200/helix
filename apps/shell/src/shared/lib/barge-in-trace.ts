/**
 * barge-in 误触埋点（B3 校准数据面）：触发帧特征入 localStorage 环形缓冲
 * （最近 BARGE_IN_TRACE_CAP 条）——后续校准批消费（设置面可不展示）。
 *
 * 形态与 voice-pref 同构存储面：纯函数（append 环形收口）+ 存储包装
 * （损坏 JSON / 形状不合法 / 存储不可用一律静默兜底，绝不因埋点扰动打断链）。
 */

/** 埋点存储键（环形缓冲 JSON 数组）。 */
export const VOICE_BARGE_IN_TRACE_KEY = "helix.voice.bargeIn.trace";

/** 环形缓冲容量（最近 ~50 条触发帧特征）。 */
export const BARGE_IN_TRACE_CAP = 50;

/** 触发帧特征（校准数据：什么声在什么相位触发了打断）。 */
export interface BargeInTraceEntry {
  /** 触发时戳（epoch ms）。 */
  readonly at: number;
  /** 触发帧 RMS。 */
  readonly rms: number;
  /** 触发帧过零率 ZCR。 */
  readonly zcr: number;
  /** 触发相位（speaking | asking——字符串面：shared 层不引 features 类型）。 */
  readonly phase: string;
  /** ⑦ 双态打点：true = 触发帧；false = 未触发候选段收口（段内峰值帧特征——
   *  「说话但打不断」的校准样本，档位系数复核依据）；缺省 = 旧版条目
   *  （历史均为触发帧，向前兼容）。 */
  readonly fired?: boolean;
}

/** 环形缓冲追加（纯函数：超容量丢最旧、最新在尾）。 */
export function appendBargeInTrace(
  buf: readonly BargeInTraceEntry[],
  entry: BargeInTraceEntry,
  cap = BARGE_IN_TRACE_CAP,
): BargeInTraceEntry[] {
  return [...buf, entry].slice(-cap);
}

/** 条目形状校验（损坏/异物条目剔除；fired 缺省容忍——旧版条目）。 */
function isEntry(v: unknown): v is BargeInTraceEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.at === "number" &&
    typeof e.rms === "number" &&
    typeof e.zcr === "number" &&
    typeof e.phase === "string" &&
    (e.fired === undefined || typeof e.fired === "boolean")
  );
}

/** 读埋点缓冲（缺省/损坏 JSON/非数组/存储不可用 → 空清单，不抛错）。 */
export function readBargeInTrace(): BargeInTraceEntry[] {
  try {
    const raw = localStorage.getItem(VOICE_BARGE_IN_TRACE_KEY);
    if (raw === null || raw === "") return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** 记一条触发帧特征（读-追加-写回；存储不可用静默兜底——埋点零打扰）。 */
export function recordBargeInTrace(entry: BargeInTraceEntry): void {
  try {
    localStorage.setItem(VOICE_BARGE_IN_TRACE_KEY, JSON.stringify(appendBargeInTrace(readBargeInTrace(), entry)));
  } catch {
    // 静默兜底（校准数据丢失可接受，打断链不受影响）
  }
}
