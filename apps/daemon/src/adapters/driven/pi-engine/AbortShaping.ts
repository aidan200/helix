/**
 * AbortShaping —— pi 通道打断善后修形层（E-198 判据的 pi-AgentMessage 形状，
 * pi 1.0.0 升级批次 3）。
 *
 * 为什么存在：pi 的打断哲学 = 不完整轮**整段丢弃**（pi-ai transform-messages
 * 对 stopReason=aborted/error 的 assistant 跳过——"Skip errored/aborted
 * assistant messages entirely"，1.0.0 未变）；helix E-198 定稿 = **安全块
 * 入账 + 截断标记**保持语义连续性（模型知道自己被打断前说过什么——语音/
 * 双工场景连续性关键；整段丢弃 = 模型从最后合法状态重来，丢失当轮语境）。
 *
 * 修形规则（E-198 判据 → pi 形状映射）：
 * - I3（thinking 签名约束）→ aborted assistant 的 thinking 块剔除（半截
 *   推理链回传触发 provider 硬拒 reasoning-without-following-item）；
 * - I5（无半成品 toolCall）→ toolCall 块剔除并记 id；I1（配对不变量）→
 *   后续孤儿 toolResult（toolCallId 命中被剔集合）一并剔除；
 * - text 块保留（半截无害）；
 * - 修形产物 = user 消息（INTERRUPTED_ASSISTANT_PREFIX + text + 截断标记），
 *   与 compactionSummary→user 同构（vendored messages.ts 先例），provider
 *   面恒合法——不洗壳 assistant（空 content/角色约束风险）；
 * - I6（审计面）→ 丢弃块经 onDropped 回调留痕（审计与模型面分离）。
 *
 * 挂点：Agent.convertToLlm 选项（AgentRuntime 装配）——包装 vendored
 * convertToLlm（内层继续负责 compactionSummary/branchSummary 转换）。
 * 注：transcript 本体不改（AgentRuntime 的 messages 投影零漂移），修形
 * 只发生在发往 provider 的转换面——与 helix-loop AbortSettler（入账前
 * 修形）的挂点差异是两通道架构差异，判据同源（E-198）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { LOOP_INTERRUPTED_MARKER_TEXT } from "../../../domain/loop/contracts/markers";

/** 修形 user 消息的声明前缀（模型面：说明这段内容的来源与截断性质）。 */
export const INTERRUPTED_ASSISTANT_PREFIX =
	"The following is the partial output of the previous assistant reply, which was interrupted by the user. Incomplete reasoning and unfinished tool calls were dropped:";

/** 丢弃块审计回调（I6——调用方日志面，丢弃内容不进上下文）。 */
export type OnDroppedBlock = (block: { kind: "thinking" | "toolCall"; summary: string }) => void;

/**
 * 包装 base 转换器为带打断修形的 convertToLlm。
 *
 * @param base 内层转换器（vendored messages.ts convertToLlm——负责自定义
 *   角色 → user 的常规转换）；修形层先处理 aborted 语义再交内层。
 * @param onDropped 可选审计回调（I6）。
 */
export function abortShapingConvertToLlm(
	base: (messages: AgentMessage[]) => Message[] | Promise<Message[]>,
	onDropped?: OnDroppedBlock,
): (messages: AgentMessage[]) => Message[] | Promise<Message[]> {
	return (messages: AgentMessage[]): Message[] | Promise<Message[]> => {
		/** 被剔 toolCall id 集（孤儿 toolResult 配对判定）。 */
		const droppedToolCallIds = new Set<string>();
		const shaped: AgentMessage[] = [];

		for (const message of messages) {
			if (message.role === "assistant") {
				const assistant = message as { stopReason?: string; content?: readonly unknown[] };
				if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
					shaped.push(shapeAbortedAssistant(message, droppedToolCallIds, onDropped));
					continue;
				}
			}
			if (message.role === "toolResult") {
				const result = message as { toolCallId?: string };
				if (result.toolCallId !== undefined && droppedToolCallIds.has(result.toolCallId)) {
					continue; // I1：被剔 toolCall 的孤儿结果（含 pi 合成的 aborted 回执）
				}
			}
			shaped.push(message);
		}

		return base(shaped);
	};
}

/** aborted/error assistant → 修形 user 消息（text 保留 + thinking/toolCall 剔除 + 标记）。 */
function shapeAbortedAssistant(
	message: AgentMessage,
	droppedToolCallIds: Set<string>,
	onDropped?: OnDroppedBlock,
): UserMessage {
	const assistant = message as unknown as {
		content: readonly any[];
		timestamp?: number;
	};
	const parts: string[] = [];
	for (const block of assistant.content ?? []) {
		if (block?.type === "text") {
			parts.push((block as TextContent).text);
		} else if (block?.type === "thinking") {
			onDropped?.({ kind: "thinking", summary: String((block as { text?: string }).text ?? "").slice(0, 80) });
		} else if (block?.type === "toolCall") {
			const call = block as { id?: string; name?: string };
			if (call.id !== undefined) droppedToolCallIds.add(call.id);
			onDropped?.({ kind: "toolCall", summary: `toolCall ${call.name ?? "?"} (${call.id ?? "?"})` });
		}
		// 其余块类型（image 等）在 aborted 轮不保留（半截判定不可得，从严剔除）
	}
	const body = parts.length > 0 ? `${INTERRUPTED_ASSISTANT_PREFIX}\n${parts.join("\n")}\n${LOOP_INTERRUPTED_MARKER_TEXT}` : LOOP_INTERRUPTED_MARKER_TEXT;
	return {
		role: "user",
		content: [{ type: "text", text: body }],
		timestamp: assistant.timestamp ?? Date.now(),
	};
}
