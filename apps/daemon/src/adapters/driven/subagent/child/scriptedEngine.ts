import { readFileSync } from "node:fs";
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
 */
export function makeScriptedStreamFn(script: FakeEngineScript, model: Model<any>): StreamFn {
  const modelId = model.id;
  const replies = [...script.replies];
  const chunkDelayMs = script.chunkDelayMs ?? 6;
  return (_m, _ctx, opts) => {
    // provider 错误形态：每 turn 均为同一单帧 error（无 start/delta 前导帧，
    // 与真实 pi-ai 失败路径同构；agentLoop 收口 stopReason=error →
    // PiAgentEngineAdapter message_end + engine_error 连发）。
    if (script.error !== undefined) {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: errorAssistantMessage(modelId, script.error.message) });
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
