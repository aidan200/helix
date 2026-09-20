/**
 * PiLoopStreamAdapter —— loop 域 LoopStreamFn 的装配适配（helix-loop L0 批）。
 *
 * 管家面的 LLM 单步流式补全经 StewardLlmPort（PiStewardLlmAdapter 真体，
 * 本目录 = pi-ai 唯一 import 执行点）→ 包装为 LoopEngine 消费的
 * LoopStreamFn duck-type 契约。本文件是纯胶水（零 pi import）：
 * - 散参回调面（onDelta/onThinking/signal）→ callbacks 收拢面；
 * - StewardLlmResponse ↔ LoopStreamResult 结构同构（编译期断言锚定——
 *   两侧形状漂移即断，AG/设计 §7-3 同精神）。
 *
 * L3 主会话引擎替换时，本包装退役为 pi-ai 原始流直连（LoopStreamFn 真体
 * 直接消费 streamSimple 事件流），LoopEngine 契约面不动。
 */
import type { StewardLlmPort } from "../../../application/ports/outbound/StewardLlmPort";
import type { LoopStreamFn, LoopStreamResult } from "../../../domain/loop/LoopTypes";
import type { StewardLlmResponse } from "../../../application/ports/outbound/StewardLlmPort";

// ── 结构同构编译锚（零运行时成本——形状漂移即编译断） ──────────

/** StewardLlmResponse 与 LoopStreamResult 判别面同构（kind 集合 + 载荷形状）。 */
type AssertSameShape<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
type _StewardResponseMatchesLoopResult = AssertSameShape<
  StewardLlmResponse,
  LoopStreamResult
>;
const _stewardResponseMatchesLoopResult: _StewardResponseMatchesLoopResult = true;

// ── 装配面 ────────────────────────────────────────────────

/** StewardLlmPort → LoopStreamFn（散参回调面 → callbacks 收拢面）。 */
export function piAdapterAsStreamFn(llm: StewardLlmPort): LoopStreamFn {
  return async (input, callbacks) => {
    const response: StewardLlmResponse = await llm.complete(
      {
        systemPrompt: input.systemPrompt,
        messages: input.messages,
        tools: input.tools,
      },
      callbacks?.onDelta,
      callbacks?.onThinking,
      callbacks?.signal,
    );
    return response as LoopStreamResult; // 结构同构经上方编译锚保证
  };
}
