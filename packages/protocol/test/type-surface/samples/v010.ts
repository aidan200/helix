import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  ChatMessageCompletedEvent,
  ChatSendCommand,
  CommandEnvelope,
  EventEnvelope,
  ToolCallResultEvent,
} from "../../../src/index";

/**
 * v0.10 样例帧（图片上下行 additive：chat.send.images 上行 + MessageEntryDto/
 * ToolCallEntryDto.images 下行；T9）。零新增命令/事件（27/47 计数不变）——
 * 全链 base64 data URL（`data:image/png;base64,…`）自包含透传，构造即类型
 * 检查（payload 字面量对位窄化）。
 */

// ── 命令样例 ──

/** 1×1 透明 PNG 的 base64（最小合法图片载荷）。 */
export const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** chat.send：带图片附件（用户发图给 LLM；images 可选 data URL 数组）。 */
export const chatSendWithImages: ChatSendCommand = {
  v: PROTOCOL_VERSION,
  type: "chat.send",
  sessionId: "sess-1",
  payload: { text: "看看这张截图", images: [TINY_PNG_DATA_URL] },
};

// ── 事件样例 ──

/** chat.message.completed：user 消息携带 images（气泡缩略图渲染依据）。 */
export const messageCompletedUserImages: ChatMessageCompletedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "chat",
  type: "chat.message.completed",
  payload: {
    entry: {
      kind: "message",
      id: "e5",
      role: "user",
      content: "看看这张截图",
      ts: 1755000000000,
      images: [TINY_PNG_DATA_URL],
    },
  },
};

/** tool.call.result：工具结果附带截图（工具卡缩略图渲染依据）。 */
export const toolCallResultImages: ToolCallResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "chat",
  type: "tool.call.result",
  payload: {
    entry: {
      kind: "tool-call",
      id: "e6",
      name: "browser",
      args: "{\"action\":\"screenshot\",\"tabId\":\"t1\",\"file\":\"/tmp/s.png\"}",
      result: "{\"saved\":\"/tmp/s.png\"}",
      state: "done",
      durationMs: 420,
      ts: 1755000000500,
      images: [TINY_PNG_DATA_URL],
    },
  },
};

export const v010Commands: CommandEnvelope[] = [chatSendWithImages];
export const v010Events: EventEnvelope[] = [messageCompletedUserImages, toolCallResultImages];
