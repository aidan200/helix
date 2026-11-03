/**
 * 系统通知分流桥决策面（系统通知 P0）——「窗口前台 toast / 窗口后台系统通知」
 * 的分流判据单点（纯函数 + 本地偏好；零 IO、零 React，AG-14）。
 *
 * 三闸序（短路即止，序即优先级）：
 *   1. 空守卫（title/body 空 → 不发，避免空气泡）；
 *   2. 设置开关（关 = 整体短路，含 high 档）；
 *   3. 窗口前台（前台已有 Toast/StewardNotifyToast 呈现，零二次打扰）；
 *   4. 会话前台观察（chat.turn.completed 面：用户正看着这条会话，角标已计）；
 *   5. 60s 同内容去重窗（normal 档；与 StewardNotifyToast 的
 *      NOTIFY_DEDUP_WINDOW_MS 同值同义——服务端出口去重的前端兜底）。
 *
 * urgency 分流：high（warn 档，任务失败等）**直发**——不参与去重窗，同文案
 * 重复即真实重复；normal 走完整三闸。文案单源铁律（kg TR-249）归 daemon：
 * 本模块只做「发不发」，不改写 title/body。
 *
 * 偏好落点：localStorage 布尔（readPersistedFlag/writePersistedFlag），缺省开。
 */
import { readPersistedFlag, writePersistedFlag } from "./persisted-flag";

/** 系统通知开关存储键（"1"=开 / "0"=关；缺键 = 开）。 */
export const SYSTEM_NOTIFY_PREF_KEY = "helix.notify.system";

/** 同内容去重短窗（毫秒）——与 StewardNotifyToast NOTIFY_DEDUP_WINDOW_MS
 *  同值同义（同内容两条到达只投递一条；normal 档生效）。 */
export const SYSTEM_NOTIFY_DEDUP_WINDOW_MS = 60_000;

/** 去重表容量（LRU 挤出上限——与 StewardNotifyToast 去重窗同量级）。 */
const DEDUP_CAPACITY = 32;

/** 读系统通知开关（缺键/脏值 → 开：P0 默认开启）。 */
export function readSystemNotifyPref(): boolean {
  return readPersistedFlag(SYSTEM_NOTIFY_PREF_KEY, true);
}

/** 写系统通知开关（存储不可用时静默——不阻断交互）。 */
export function writeSystemNotifyPref(on: boolean): void {
  writePersistedFlag(SYSTEM_NOTIFY_PREF_KEY, on);
}

/** 窗口是否在前台（可见 ∧ 聚焦）——失焦/最小化/被遮挡一律按后台处理，
 *  系统通知只在后台发（前台已有 toast 面）。 */
export function isWindowForeground(): boolean {
  if (typeof document === "undefined") return true;
  const visible = document.visibilityState === "visible";
  const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return visible && focused;
}

/** 通知请求（title/body 均为 daemon 单源文案或会话名 + 固定标签）。 */
export interface SystemNotifyRequest {
  readonly title: string;
  readonly body: string;
  /** high = 门控高危（直发，不参与去重窗）；normal = 常规。 */
  readonly urgency: "high" | "normal";
  /** 会话是否在前台被观察（仅 chat.turn.completed 面传入；缺省 = 不参与判定）。 */
  readonly sessionForeground?: boolean;
}

/** 不发原因（诊断/测试面；不进用户可见文案）。 */
export type SystemNotifySkipReason =
  | "empty"
  | "disabled"
  | "foreground"
  | "session-active"
  | "duplicate";

export type SystemNotifyDecision =
  | { readonly send: true }
  | { readonly send: false; readonly reason: SystemNotifySkipReason };

/** 判定上下文（IO 面全部由调用方注入——纯函数可测）。 */
export interface SystemNotifyContext {
  /** 设置开关现态（readSystemNotifyPref）。 */
  readonly enabled: boolean;
  /** 窗口前台现态（isWindowForeground）。 */
  readonly foreground: boolean;
  /** 同 key 上次投递时刻（undefined = 未记录）。 */
  readonly seenAt: number | undefined;
  readonly now: number;
}

/** 分流判定（三闸 + urgency 分流的唯一实现）。 */
export function decideSystemNotify(
  req: SystemNotifyRequest,
  ctx: SystemNotifyContext,
): SystemNotifyDecision {
  if (req.title.trim() === "" || req.body.trim() === "") return { send: false, reason: "empty" };
  if (!ctx.enabled) return { send: false, reason: "disabled" };
  if (ctx.foreground) return { send: false, reason: "foreground" };
  if (req.sessionForeground === true) return { send: false, reason: "session-active" };
  if (
    req.urgency === "normal" &&
    ctx.seenAt !== undefined &&
    ctx.now - ctx.seenAt < SYSTEM_NOTIFY_DEDUP_WINDOW_MS
  ) {
    return { send: false, reason: "duplicate" };
  }
  return { send: true };
}

/**
 * 同内容去重记账窗（组件级实例态：重挂载即新窗）。Map 插入序即 LRU 序——
 * 命中先摘后插移到尾部，容量挤出取头部（最久未用）。
 */
export class SystemNotifyDedup {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number = SYSTEM_NOTIFY_DEDUP_WINDOW_MS,
    private readonly capacity: number = DEDUP_CAPACITY,
  ) {}

  /** 记账并回读上次时刻：undefined = 新达/窗外再达（已重开窗）；number = 窗内命中
   *  （返回首达时刻——窗不滑动，与 StewardNotifyToast 同语义）。 */
  seenAt(key: string, now: number): number | undefined {
    const last = this.seen.get(key);
    // 先摘后插（命中/新达都把键移到 Map 尾 = 最近使用位）
    this.seen.delete(key);
    if (last !== undefined && now - last < this.windowMs) {
      this.seen.set(key, last); // 命中：保留首达时刻（窗不滑动）
      return last;
    }
    this.seen.set(key, now);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return undefined;
  }

  /** 仅在窗外或未记录时刷新首达时刻（high 直发不查窗，但仍记账——
   *  避免随后同内容的 normal 立刻补发同一条）。 */
  mark(key: string, now: number): void {
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return;
    this.seen.delete(key);
    this.seen.set(key, now);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
