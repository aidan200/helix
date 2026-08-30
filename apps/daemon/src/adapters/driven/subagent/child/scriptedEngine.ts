import { appendFileSync, readFileSync } from "node:fs";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * 剧本注入（E 层测试基建）：子进程引擎剧本经 env `HELIX_FAKE_ENGINE_SCRIPT=<path>`
 * 注入——ChildMain 检测到该 env 即用本剧本 streamFn 装配（离线、无网络、
 * 无真实 key），E 层 SubAgent 真链路测试据此驱动子进程行为。
 *
 * 生产路径（env 缺失）不受影响——本模块只在显式注入时被装配。
 */

/** 剧本文件形状（父进程测试写入 JSON 文件，子进程读取）。 */
export interface FakeEngineScript {
  /** 顺序回复（每 turn 消费一条；耗尽后用占位回复）。 */
  readonly replies: readonly string[];
  /** 流式分片间隔 ms（缺省 6；调大以制造注入/kill 时窗）。 */
  readonly chunkDelayMs?: number;
  /** 模拟不可中断引擎（O-6 SIGKILL 升级路径）：忽略 abort 信号。 */
  readonly ignoreAbort?: boolean;
  /**
   * provider 错误形态：每 turn 均产出与真引擎 error 轮同构的单帧
   * { type:"error", reason:"error", error }——逐字段 mirror 主线 E 层剧本
   * （apps/daemon/test/e2e/launcher.ts errorMessage + kind:"error" 分支）。
   */
  readonly error?: { readonly message: string };
  /**
   * 首 turn 工具调用形态（H-3④：子进程 browser 工具调用剧本）——首 turn
   * 产出 stopReason="toolUse" 的单 toolCall 消息（runtime 执行工具后续轮），
   * 次 turn 起回退 replies 文本流。mirror 主线 e2e/launcher.ts kind:"tool" 条目。
   */
  readonly toolCall?: { readonly name: string; readonly args: Record<string, unknown> };
  /**
   * 多轮工具调用序列（T4.1 bootstrap e2e）：每 turn 依次消费一项（工具名+参数），
   * 耗尽后回退 replies 文本流。与单 toolCall 并存时优先本序列。参数字符串值可
   * 携带模板占位（见 templateToolArgs）：{batchId}/{taskId} 从首条用户消息
   * （批次 brief）正则提取——剧本钉 LLM 输出，工具执行全真（TR-TEST-3）。
   */
  readonly toolCalls?: readonly { readonly name: string; readonly args: Record<string, unknown> }[];
  /**
   * stream options.reasoning 捕获面（thinking 批 T1.3 测试基建）：每次 stream
   * 调用把 `options.reasoning ?? null` JSON 行追加到该路径——断言 §3.5 注入器
   * 包装（定格值写入 / 不支持不动 options）经 fake 剧本通道到达。
   */
  readonly captureReasoningPath?: string;
}

/** 读取并校验剧本文件（非法即抛错 → ChildMain crash 路径 exit(1)）。 */
export function loadFakeEngineScript(path: string): FakeEngineScript {
  const raw = JSON.parse(readFileSync(path, "utf8")) as FakeEngineScript;
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.replies)) {
    throw new Error(`剧本文件格式错误：${path}（应为 { replies: string[], chunkDelayMs?, ignoreAbort?, error? }）`);
  }
  const err = (raw as { error?: unknown }).error;
  if (err !== undefined && (typeof err !== "object" || err === null || typeof (err as { message?: unknown }).message !== "string")) {
    throw new Error(`剧本文件格式错误：${path}（error 应为 { message: string }）`);
  }
  const tc = (raw as { toolCall?: unknown }).toolCall;
  if (
    tc !== undefined &&
    (typeof tc !== "object" ||
      tc === null ||
      typeof (tc as { name?: unknown }).name !== "string" ||
      typeof (tc as { args?: unknown }).args !== "object" ||
      (tc as { args?: unknown }).args === null)
  ) {
    throw new Error(`剧本文件格式错误：${path}（toolCall 应为 { name: string, args: object }）`);
  }
  const tcs = (raw as { toolCalls?: unknown }).toolCalls;
  if (
    tcs !== undefined &&
    (!Array.isArray(tcs) ||
      tcs.some(
        (e) =>
          typeof e !== "object" ||
          e === null ||
          typeof (e as { name?: unknown }).name !== "string" ||
          typeof (e as { args?: unknown }).args !== "object" ||
          (e as { args?: unknown }).args === null,
      ))
  ) {
    throw new Error(`剧本文件格式错误：${path}（toolCalls 应为 [{ name, args }] 数组）`);
  }
  return raw;
}

function assistantMessage(modelId: string, text: string, stopReason: "stop" | "aborted"): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: modelId,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 工具调用消息（mirror e2e/launcher.ts toolCallMessage：stopReason=toolUse）。 */
function toolCallMessage(modelId: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: modelId,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** provider 失败消息：空 content + stopReason=error + errorMessage 原文 +
 *  全零 usage（含 reasoning=0）——与 launcher.ts errorMessage 逐字段对齐。 */
function errorAssistantMessage(modelId: string, message: string): AssistantMessage {
  const m = {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: modelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  (m as AssistantMessage & { errorMessage?: string }).errorMessage = message;
  return m;
}

/**
 * 剧本化 StreamFn（FakeLLM 同构）：按 4 字符分片流出 replies 中的下一条，
 * 信号感知（abort → aborted 消息收尾；ignoreAbort 时忽略——模拟真实
 * provider 卡死不可中断，O-6 升级路径的测试构造）。
 *
 * T4.1：toolCalls 序列优先于 replies（每 turn 一项工具调用；耗尽回退文本），
 * 参数模板占位 {batchId}/{taskId} 从首条用户消息（批次 brief）提取——LLM
 * 输出由剧本钉定，工具执行/结果回注全真。
 */
const BRIEF_BATCH_ID_RE = /origin_batchId=([A-Za-z0-9][A-Za-z0-9._-]*)/;
const BRIEF_TASK_ID_RE = /taskId=([A-Za-z0-9][A-Za-z0-9._-]*)/;
const BRIEF_LAYER_RE = /(?:目标层|layer)=(L[0-2])/;

function templateToolArgs(
  args: Record<string, unknown>,
  brief: { batchId?: string; taskId?: string; layer?: string },
): Record<string, unknown> {
  const template = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      if (brief.batchId !== undefined) out = out.replaceAll("{batchId}", brief.batchId);
      if (brief.taskId !== undefined) out = out.replaceAll("{taskId}", brief.taskId);
      if (brief.layer !== undefined) out = out.replaceAll("{layer}", brief.layer);
      return out;
    }
    if (Array.isArray(value)) return value.map(template);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = template(v);
      return out;
    }
    return value;
  };
  return template(args) as Record<string, unknown>;
}

/** 首条用户消息（批次 brief）中的任务元数据提取（origin_batchId=/taskId=/目标层= 标记行）。 */
function briefMetaOf(context: unknown): { batchId?: string; taskId?: string; layer?: string } {
  const messages = (context as { messages?: { role: string; content: { type: string; text?: string }[] }[] }).messages ?? [];
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser === undefined) return {};
  const text = firstUser.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
  const batchId = BRIEF_BATCH_ID_RE.exec(text)?.[1];
  const taskId = BRIEF_TASK_ID_RE.exec(text)?.[1];
  const layer = BRIEF_LAYER_RE.exec(text)?.[1];
  return {
    ...(batchId !== undefined ? { batchId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(layer !== undefined ? { layer } : {}),
  };
}

export function makeScriptedStreamFn(script: FakeEngineScript, model: Model<any>): StreamFn {
  const modelId = model.id;
  const replies = [...script.replies];
  const toolCalls = [...(script.toolCalls ?? [])];
  const chunkDelayMs = script.chunkDelayMs ?? 6;
  let toolCallPending = script.toolCall !== undefined; // 首 turn 消费（H-3④）
  return (_m, ctx, opts) => {
    // thinking 批捕获面（T1.3）：记录 options.reasoning（null = 未传参）
    if (script.captureReasoningPath !== undefined) {
      const reasoning = (opts as { reasoning?: string } | undefined)?.reasoning ?? null;
      appendFileSync(script.captureReasoningPath, `${JSON.stringify(reasoning)}\n`);
    }
    // provider 错误形态：每 turn 均为同一单帧 error（无 start/delta 前导帧，
    // 与真实 pi-ai 失败路径同构；agentLoop 收口 stopReason=error →
    // PiAgentEngineAdapter message_end + engine_error 连发）。
    if (script.error !== undefined) {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: errorAssistantMessage(modelId, script.error.message) });
      return stream;
    }
    const nextToolCall = toolCalls.shift();
    if (nextToolCall !== undefined) {
      const message = toolCallMessage(modelId, nextToolCall.name, templateToolArgs(nextToolCall.args, briefMetaOf(ctx)));
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    }
    if (toolCallPending) {
      toolCallPending = false;
      const message = toolCallMessage(modelId, script.toolCall!.name, script.toolCall!.args);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    }
    const reply = replies.shift() ?? "（剧本耗尽）";
    const signal = script.ignoreAbort ? undefined : (opts as { signal?: AbortSignal } | undefined)?.signal;
    const stream = createAssistantMessageEventStream();
    const final = assistantMessage(modelId, reply, "stop");
    void (async () => {
      stream.push({ type: "start", partial: final });
      for (let i = 0; i < reply.length; i += 4) {
        if (signal?.aborted) {
          stream.push({
            type: "done",
            reason: "stop",
            message: assistantMessage(modelId, reply.slice(0, i), "aborted"),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, chunkDelayMs));
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply.slice(i, i + 4), partial: final });
      }
      stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
}
