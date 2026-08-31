/**
 * 引擎级 LLM 网络重试（P2 ⑦，裁决 2026-08-31）。
 *
 * 挂点纪律：包装 StreamFn——pi agentLoop 的唯一 LLM 调用出口
 * （StreamFn 契约：失败不抛错，经流内 `{type:"error"}` 终帧编码，
 * `error.stopReason === "error"` + `errorMessage` 承载 provider 原文）。
 * 由此主会话（engineFor）与 SubAgent 子进程（ChildMain）同源生效
 * ——包装在 PiAgentEngineAdapter 装配面，全局非 SubAgent 独有。
 *
 * 重试语义（零语义改动红线）：
 * - 退避序列固定 10s→30s→60s 三次（LLM_RETRY_BACKOFF_MS 常量注入，
 *   测试可换假时钟）；退避耗尽 → 原样转发最后一次 error 终帧，
 *   closure/错误语义与无重试时逐事件一致；
 * - P8 配额语义：配额类快速失败服务人工切账号——配额耗尽（token
 *   用尽/欠费，429+insufficient_quota/quota_exceeded/billing/balance
 *   类文案或 402 余额类）重试无意义，判永久类立即走既有失败路径，
 *   不吃 10/30/60 退避；其余 429（真限流）仍属瞬时类照常重试；
 * - 仅重试「零事件前导的请求期失败」（pi-ai 的 start 帧在 HTTP 响应
 *   到达后才发——连接失败/超时/429/5xx 均为纯 error 单帧）。已转发
 *   任何事件（中途断流）后不再重试：agentLoop 在 start 帧会把 partial
 *   push 进 context.messages，重试会造成重复消息（见 agent-loop
 *   streamAssistantResponse）——中途失败保持既有直通路径；
 * - abort（kill/SIGTERM）经 options.signal 感知：等待期 abort 立即
 *   以 aborted 终帧收口，不再重试；
 * - abort 终帧（reason "aborted"）与用户可见错误均不重试。
 *
 * pi-ai 自带 SDK 级短退避（retryProviderRequest，0.5–8s×2）——本层
 * 覆盖更长抖动，且携带 onRetry 可观测回调（chat 状态可见性的数据源）。
 */
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** 退避序列（裁决：10s→30s→60s，三次失败后走既有 failed 路径）。 */
export const LLM_RETRY_BACKOFF_MS: readonly number[] = [10_000, 30_000, 60_000];

/** 错误分类：瞬时（可重试）/ 永久（直接走既有失败路径）。 */
export type LlmErrorClass = "transient" | "permanent";

/** 请求期网络错/超时关键词（无 HTTP 状态码时的判据）。 */
const TRANSIENT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /fetch failed|failed to fetch/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i,
  /socket hang up|socket error|connection reset|connection refused|connection closed|connection terminated/i,
  /network (?:error|timeout)|request timed? ?out|timed out|timeout/i,
  /rate limit|too many requests|overloaded|service unavailable|internal server error|bad gateway|gateway timeout/i,
];

/**
 * P8 配额耗尽文案特征（429+配额标记/402 余额类判据）：命中即永久类——
 * 配额类快速失败服务人工切账号。导出供单测直接覆盖特征面。
 * 词边界防护：'balance' 不误伤 "unbalanced"；连写形态
 * （insufficient_quota/quota_exceeded，下划线为 \w 需独立条目）单独列。
 */
export const QUOTA_MESSAGE_PATTERNS: readonly RegExp[] = [
  /insufficient[ _-]?quota/i, // OpenAI insufficient_quota 连写形态
  /quota[ _-]?(?:exceeded|exhausted)/i, // quota_exceeded / quota exhausted
  /\bquota\b/i, // 宽松兑底：独立 quota 词（429 配额语境）
  /\bbilling\b/i, // 计费（402 Payment Required 语境）
  /\bbalance\b/i, // 余额（词边界防 "unbalanced" 误伤）
];

/** 独立三位数 HTTP 状态码提取（"429: …"/"(503) …"/"HTTP 500 …" 等嵌入形态）。 */
const HTTP_STATUS_RE = /\b([45]\d{2})\b/;

/**
 * LLM 调用错误分类（纯函数，单测面）。
 *
 * - stopReason 非 "error"（含 "aborted"/"stop" 等）→ 永久：重试只针对
 *   请求失败的 error 终帧，用户 abort 永不重试；
 * - 配额耗尽文案（QUOTA_MESSAGE_PATTERNS 命中）→ 永久（P8）：优先于
 *   状态码裁决——429+quota 标记与 402 余额类一律零重试立即失败；
 * - 消息中嵌入 HTTP 状态码 → 状态码裁决：408/409/429/5xx 瞬时，
 *   其余 4xx（401/403/400/402 等鉴权/参数/余额）永久；
 * - 无状态码 → 网络错/超时关键词命中 → 瞬时；
 * - 未知形态 → 永久（安全缺省：不重试未知错误，立即走既有失败路径）。
 */
export function classifyLlmError(stopReason: string, errorMessage: string | undefined): LlmErrorClass {
  if (stopReason !== "error") return "permanent";
  const message = errorMessage ?? "";
  if (message.trim() === "") return "permanent";
  // P8：配额耗尽优先于状态码裁决——账号资源问题任何状态下重试都无意义
  if (QUOTA_MESSAGE_PATTERNS.some((re) => re.test(message))) return "permanent";
  const status = HTTP_STATUS_RE.exec(message)?.[1];
  if (status !== undefined) {
    const code = Number(status);
    return code === 408 || code === 409 || code === 429 || code >= 500 ? "transient" : "permanent";
  }
  return TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(message)) ? "transient" : "permanent";
}

/** 单次重试的可观测载荷（chat 状态行/日志的数据源）。 */
export interface LlmRetryInfo {
  /** 即将执行的重试序号（1 起，最大 = totalAttempts）。 */
  readonly attempt: number;
  /** 重试总次数（退避序列长度）。 */
  readonly totalAttempts: number;
  /** 本次重试前等待毫秒数。 */
  readonly waitMs: number;
  /** 触发重试的 provider 错误原文。 */
  readonly message: string;
}

/** 默认等待：abort 感知（signal 中断即 reject AbortError，kill/abort 立即打断退避）。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const e = new Error("retry wait aborted");
  e.name = "AbortError";
  return e;
}

/** 合成终帧消息（abort 打断等待/防御路径收口用——镜像 pi-ai 失败消息形状）。 */
function syntheticMessage(
  model: Model<any>,
  stopReason: "error" | "aborted",
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 重试包装器选项（backoffMs/sleep 注入 = 测试假时钟面）。 */
export interface NetworkRetryOptions {
  /** 退避序列（缺省 LLM_RETRY_BACKOFF_MS）。 */
  readonly backoffMs?: readonly number[];
  /** 等待函数（缺省 abortableSleep；测试注入假时钟）。 */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 每次进入重试等待前回调（可观测：chat 反馈/日志数据源）。 */
  readonly onRetry?: (info: LlmRetryInfo) => void;
}

/**
 * StreamFn 网络重试包装（防腐墙内装配件，与 wrapStreamFnThinking 同哲学）。
 *
 * 返回新 StreamFn：透传底层流事件（live 转发不缓冲，流式 UX 不变）；
 * 遇「零前导事件的 error 终帧 + 瞬时分类 + 退避未耗尽」→ 扣留该终帧、
 * onRetry 回调、abort 感知等待后重调底层（消费者只见最终成功/最终失败
 * 的单一流）；其余一切情况逐事件原样透传（含 done/aborted/永久错误/
 * 退避耗尽的最后一次 error——既有失败路径零改动）。
 */
export function withNetworkRetry(streamFn: StreamFn, opts: NetworkRetryOptions = {}): StreamFn {
  const backoffMs = opts.backoffMs ?? LLM_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? abortableSleep;
  return (model, context, options): ReturnType<StreamFn> => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      // 第 i 轮调用（0 起）；i < backoffMs.length 时失败仍可退避重试
      for (let attemptIndex = 0; ; attemptIndex++) {
        let stream: Awaited<ReturnType<StreamFn>>;
        try {
          stream = await streamFn(model, context, options);
        } catch (err) {
          // StreamFn 契约要求不抛错——防御：非契约流按永久错误收口
          const message = err instanceof Error ? err.message : String(err);
          out.push({ type: "error", reason: "error", error: syntheticMessage(model, "error", message) });
          out.end();
          return;
        }
        let forwarded = false; // 本轮已转发事件（中途断流 → 不可重试）
        let retry = false; // 本轮 error 终帧已进入退避重试（区别于流耗尽的防御收口）
        for await (const event of stream) {
          if (event.type === "error") {
            const errorEvent: Extract<AssistantMessageEvent, { type: "error" }> = event;
            const cls = classifyLlmError(errorEvent.error.stopReason, errorEvent.error.errorMessage);
            const canRetry = !forwarded && cls === "transient" && attemptIndex < backoffMs.length;
            if (!canRetry) {
              out.push(errorEvent); // 原样转发：既有失败路径零改动
              out.end();
              return;
            }
            const info: LlmRetryInfo = {
              attempt: attemptIndex + 1,
              totalAttempts: backoffMs.length,
              waitMs: backoffMs[attemptIndex]!,
              message: errorEvent.error.errorMessage ?? "",
            };
            opts.onRetry?.(info);
            try {
              await sleep(info.waitMs, options?.signal);
            } catch (err) {
              if (options?.signal?.aborted) {
                // kill/abort 打断等待：立即 aborted 收口，不再重试
                out.push({
                  type: "error",
                  reason: "aborted",
                  error: syntheticMessage(model, "aborted", "retry wait aborted"),
                });
                out.end();
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              out.push({ type: "error", reason: "error", error: syntheticMessage(model, "error", message) });
              out.end();
              return;
            }
            retry = true;
            break; // 进入下一轮重试
          }
          out.push(event);
          forwarded = true;
          if (event.type === "done") {
            out.end();
            return;
          }
        }
        if (retry) continue; // 退避完成 → 重调底层（下一 attemptIndex）
        // 流耗尽但无 done/error 终帧（底层非契约形态）：防御性收口防 result() 悬空
        out.end();
        return;
      }
    })();
    return out;
  };
}
