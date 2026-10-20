/**
 * speech-diag —— 语音链诊断环形缓冲（发哑自检，「回答不播报」排查教训沉淀）。
 *
 * 为什么存在：语音链跨 daemon/shell 多环（收文本→喂切句→发合成→收 chunk→
 * 入队→播放），任一环静默断掉都表现为「整轮没声音」且零报错——2026-10-10
 * 排查为此花了整晚（帧探针逐环实证才收敛断点）。本模块把每个环的事件记入
 * 环形缓冲并持久化 localStorage（`helix.steward.speechDiag`），下次发哑时
 * 直接读盘即可看到「最后一环停在哪」，不再靠猜。
 *
 * 设计纪律：
 * - 记录零语义判断（只记事实事件名 + 可选短详情），分析归人；
 * - 写盘节流（DIAG_PERSIST_DEBOUNCE_MS 合并写）——记录点在热路径上；
 * - 环容量有界（DIAG_RING_CAPACITY 条），超限挤掉最旧；
 * - 存储面可注入（测试注入假 storage；生产缺省 localStorage，不可用即内存态）。
 */

/** 环容量（一轮问答 ~30-80 事件——覆盖最近 2-4 轮足够定位断点）。 */
export const DIAG_RING_CAPACITY = 240;

/** 持久化节流窗（合并写；页面卸载兜底 flush）。 */
export const DIAG_PERSIST_DEBOUNCE_MS = 2_000;

/** 持久化键（localStorage；键名入 useStewardWelcomeAudio 先例族）。 */
export const DIAG_STORAGE_KEY = "helix.steward.speechDiag";

export interface SpeechDiagEntry {
  /** 事件时刻（Date.now()）。 */
  readonly t: number;
  /** 事件名（点位约定：链路方向前缀——ask./feed./issue./chunk./play./result./fallback./stop./gate.）。 */
  readonly ev: string;
  /** 短详情（可选；只记判定要素——utterId/理由/计数，不记正文音频）。 */
  readonly detail?: string;
}

/** 存储面（测试注入；生产缺省 localStorage 包装）。 */
export interface DiagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ring: SpeechDiagEntry[] = [];
const listeners = new Set<() => void>();
let storage: DiagStorage | null = defaultStorage();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function defaultStorage(): DiagStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // 隐私模式/不可用——内存态降级（诊断照记，只是不持久）
  }
  return null;
}

/** 注入存储面（测试/定制；null = 纯内存）。 */
export function setDiagStorage(next: DiagStorage | null): void {
  storage = next;
}

/** 记录一条诊断事件（热路径——同步入环 + 节流落盘）。 */
export function recordSpeechDiag(ev: string, detail?: string): void {
  const entry: SpeechDiagEntry = detail === undefined ? { t: Date.now(), ev } : { t: Date.now(), ev, detail };
  ring.push(entry);
  if (ring.length > DIAG_RING_CAPACITY) ring.splice(0, ring.length - DIAG_RING_CAPACITY);
  for (const cb of listeners) cb();
  schedulePersist();
}

/** 取诊断快照（时间序全量拷贝）。 */
export function dumpSpeechDiag(): SpeechDiagEntry[] {
  return [...ring];
}

/** 清空（新一轮排查前手动清场；清空即落盘）。 */
export function clearSpeechDiag(): void {
  ring.length = 0;
  flushPersist();
}

/** 订阅记录边沿（呈现面可选消费——当前无消费者，为 UI 面预留）。 */
export function onSpeechDiagChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 持久化快照字符串（测试断言面）。 */
export function serializeDiag(): string {
  return JSON.stringify(ring);
}

/** 立即落盘（卸载兜底/清场）。 */
export function flushPersist(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (storage === null) return;
  try {
    storage.setItem(DIAG_STORAGE_KEY, serializeDiag());
  } catch {
    // 配额满等——内存态照常，诊断不因落盘失败丢事件
  }
}

/** 读盘恢复（应用启动时把上次发哑现场捞回环——重启不丢证据）。 */
export function hydrateDiagFromStorage(): number {
  if (storage === null) return 0;
  let raw: string | null = null;
  try {
    raw = storage.getItem(DIAG_STORAGE_KEY);
  } catch {
    return 0;
  }
  if (raw === null || raw === "") return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return 0;
    const entries = parsed.filter(
      (e): e is SpeechDiagEntry =>
        typeof e === "object" && e !== null && typeof (e as SpeechDiagEntry).t === "number" && typeof (e as SpeechDiagEntry).ev === "string",
    );
    ring.length = 0;
    ring.push(...entries.slice(-DIAG_RING_CAPACITY));
    // 返回**实际入环条数**（旧实现返回合法条目数：超容量截断后两者不等，
    // 调用方当「恢复计数」展示会虚高）
    return ring.length;
  } catch {
    return 0;
  }
}

function schedulePersist(): void {
  if (storage === null) return;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist();
  }, DIAG_PERSIST_DEBOUNCE_MS);
}

/** 事件帧名速记（帧到达类事件统一前缀，免逐处拼字符串）。 */
export function frameEv(kind: "in" | "drop", frame: { type: string }, detail?: string): void {
  recordSpeechDiag(`${kind === "in" ? "frame." : "gate.drop."}${frame.type}`, detail);
}

// 模块加载即恢复上次现场（发哑自检：重启不丢证据——环里保留崩溃前最后
// DIAG_RING_CAPACITY 条，新事件从旧时间线之后续记）。
hydrateDiagFromStorage();
