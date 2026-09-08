/**
 * 引擎级 LLM 网络重试（P2 ⑦ 初版；裁决修订 2026-09-08：仅传输层错误重试）。
 *
 * 挂点纪律：包装 StreamFn——pi agentLoop 的唯一 LLM 调用出口
 * （StreamFn 契约：失败不抛错，经流内 `{type:"error"}` 终帧编码，
 * `error.stopReason === "error"` + `errorMessage` 承载 provider 原文）。
 * 由此主会话（engineFor）与 SubAgent 子进程（ChildMain）同源生效
 * ——包装在 PiAgentEngineAdapter 装配面，全局非 SubAgent 独有。
 *
 * 重试语义（裁决 2026-09-08，取代 P2 ⑦ 状态码裁决与 P8 配额特判）：
 * - 只重试「传输层错误」= 没拿到 LLM 接口响应的请求期失败（连接拒绝/
 *   重置/超时/socket 断开——undici/Node fetch/node:http 库常量文案与
 *   errno 族，有限可枚举，非 provider 散文）；
 * - LLM 接口返回了响应（errorMessage 含 HTTP 状态码 4xx/5xx）一律快速
 *   失败：provider 活着且明确拒绝——429（限流与配额同码）/5xx/鉴权/
 *   参数均不再自动重试。证据：GLM 429+code 1308（5 小时限额）事故，
 *   4 个 agent 各白等 100s 退避；而错判 fail-fast 的代价只是用户发
 *   一次「继续」（会话可续），成本严重不对称 → 偏向 fail-fast；
 * - 退避序列固定 10s→30s→60s 三次（LLM_RETRY_BACKOFF_MS 常量注入，
 *   测试可换假时钟）；退避耗尽 → 原样转发最后一次 error 终帧，
 *   closure/错误语义与无重试时逐事件一致；
 * - 仅重试「零事件前导的请求期失败」（pi-ai 的 start 帧在 HTTP 响应
 *   到达后才发——连接失败/超时均为纯 error 单帧）。已转发任何事件
 *   （中途断流）后不再重试：agentLoop 在 start 帧会把 partial push 进
 *   context.messages，重试会造成重复消息（见 agent-loop
 *   streamAssistantResponse）——中途失败保持既有直通路径；
 * - abort（kill/SIGTERM）经 options.signal 感知：等待期 abort 立即
 *   以 aborted 终帧收口，不再重试；abort 终帧永不重试；
 * - 未知形态 → permanent（fail-fast 安全缺省）。
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

/**
 * 传输层错误文案（重试的唯一依据；裁决 2026-09-08）：undici/Node fetch/
 * node:http 的库常量文案与 errno 族——有限可枚举的库实现细节，非
 * provider 散文，无文案打地鼠面。LLM 接口返回的响应（消息含 HTTP
 * 状态码）先于本表判永久，不与本表竞争。
 */
const TRANSPORT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /fetch failed|failed to fetch/i, // Node fetch TypeError
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i, // errno 族
  /socket hang up|socket error|socket connection was closed/i, // node:http / undici UND_ERR_SOCKET
  /connection reset|connection refused|connection closed|connection terminated|other side closed/i,
  /Headers Timeout Error|Body Timeout Error|Connect Timeout Error/i, // undici UND_ERR_*_TIMEOUT
  /\bterminated\b/i, // undici UND_ERR_TERMINATED
  /network (?:error|timeout)|request timed? ?out|timed out|timeout/i,
];

/**
 * 独立三位数 HTTP 状态码提取（"429: …"/"(503) …"/"HTTP 500 …" 等嵌入形态）。
 * 否定后顾排除 host:port（"connect ECONNREFUSED 127.0.0.1:443" 的 443）
 * 与 IP 段误伤——端口数字不是状态码，传输层错误消息常携带。
 */
const HTTP_STATUS_RE = /(?<![:.\d])([45]\d{2})\b/;

/**
 * LLM 调用错误分类（纯函数，单测面；裁决 2026-09-08：仅传输层错误瞬时）。
 *
 * - stopReason 非 "error"（含 "aborted"/"stop" 等）→ 永久：重试只针对
 *   请求失败的 error 终帧，用户 abort 永不重试；
 * - 消息含 HTTP 状态码（4xx/5xx）→ 永久：LLM 接口返回了响应，provider
 *   活着且明确拒绝（429 限流/配额、5xx、401/403/400/402 等一律快速失败）；
 * - 无状态码 + 传输层库常量命中（TRANSPORT_MESSAGE_PATTERNS）→ 瞬时；
 * - 未知形态 → 永久（fail-fast 安全缺省：错判代价 = 用户发一次「继续」）。
 */
export function classifyLlmError(stopReason: string, errorMessage: string | undefined): LlmErrorClass {
  if (stopReason !== "error") return "permanent";
  const message = errorMessage ?? "";
  if (message.trim() === "") return "permanent";
  // LLM 接口返回了响应 → 快速失败（状态码是「拿到响应」的机械判据）
  if (HTTP_STATUS_RE.test(message)) return "permanent";
  return TRANSPORT_MESSAGE_PATTERNS.some((re) => re.test(message)) ? "transient" : "permanent";
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
