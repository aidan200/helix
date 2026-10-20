/**
 * JudgePolicy —— 判官降级链统一（DDD 重构批 3a）。
 *
 * 定位：判官三消费面（addressee/stop-intent/pending-intent）的同构降级链
 * （开关关→静默 / 端点未配→WARN / 抛错→WARN 不重试）收编单一泛型封装，
 * 消灭三份复制粘贴（排查清单 A-15「判官降级链三份复制」）。每消费面独立
 * 问题文本（question）、解释函数（interpret）与降级日志文案（onDegraded
 * 回调组装——文案各面历史不同，逐字保留）。
 *
 * 降级语义（与批 3a 前逐面等价）：
 * - off：判官缺席/开关关 → 零日志 fallback（默认态零日志纪律）；
 * - unready：开启但端点未配/失效 → onDegraded + fallback；
 * - error：判定抛错 → onDegraded 不重试 + fallback（保守偏置归 interpret
 *   的 fallback 语义——「宁多应答不漏」）。
 */

export type JudgeDegradation = "off" | "unready" | "error";

/** 判官窄面（enabled/ready/noul——各端口的消费面投影）。 */
export interface JudgeFace {
  enabled(): boolean;
  ready(): boolean;
  noul(text: string, question: string): Promise<number>;
}

export interface JudgeOrFallbackInput<T> {
  readonly judge: JudgeFace | undefined;
  readonly question: string;
  readonly text: string;
  /** 分数解释（判定成功才调用）。 */
  readonly interpret: (score: number) => T;
  /** 降级回退值（保守偏置的载体——各面自定）。 */
  readonly fallback: T;
  /** 降级通知（unready/error 携原文；off 零通知——默认态零日志纪律）。 */
  readonly onDegraded?: (kind: JudgeDegradation, message?: string) => void;
}

/** 抛出物 → 原因文本（Error 取 message，其余 String(err) 兜底——降级通知
 *  不得丢原因）。 */
export function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

/** 判定封装：降级链三态（off/unready/error）统一骨架，判定成功 = interpret(score)。 */
export async function judgeOrFallback<T>(
  input: JudgeOrFallbackInput<T>,
): Promise<{ value: T; degraded?: JudgeDegradation }> {
  const { judge, question, text, interpret, fallback, onDegraded } = input;
  if (judge === undefined) return { value: fallback, degraded: "off" };
  if (!judge.enabled()) return { value: fallback, degraded: "off" }; // 开关关：默认态零日志（同款）
  if (!judge.ready()) {
    onDegraded?.("unready");
    return { value: fallback, degraded: "unready" };
  }
  try {
    const score = await judge.noul(`用户这句话：${text}`, question);
    return { value: interpret(score) };
  } catch (err) {
    // 非 Error 抛出物（string/undefined）不得取 .message（评审 low #78）：
    // 降级通知会丢原因文本（undefined）。统一经 reasonOf 归一。
    onDegraded?.("error", reasonOf(err));
    return { value: fallback, degraded: "error" };
  }
}
