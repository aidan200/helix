/**
 * 管家投影纯函数面（体量门 P4：自 StewardService.ts 原样迁出）。
 *
 * 无状态纯函数（记录→LLM 消息窗口 / 工具结果体量护栏 / 列表紧凑投影 /
 * 标题与回执行文）：行为单点可测，不含服务状态。门面 StewardService.ts
 * 精确再导出——消费方 import 路径与符号零变化。
 */
import type { StewardLlmContentBlock, StewardLlmMessage } from "../ports/outbound/StewardLlmPort";
import { matchStewardCancelPhrase, matchStewardConfirmPhrase, type StewardHistoryRecord } from "@helix/protocol";
import type { StewardSessionMetaRow } from "./stewardServiceTypes";
import {
  DELIVER_TITLE_MAX_CHARS,
  INSTANCE_SUMMARY_MAX_CHARS,
  INSTANCE_TASK_MAX_CHARS,
  STEWARD_MISSING_TOOL_RESULT_TEXT,
  TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATION_MARK,
} from "./stewardConstants";

/** args 摘要（feed 帧面——JSON 截断 120 字符）。 */
export function summarizeArgsLite(args: unknown): string {
  try {
    const json = JSON.stringify(args) ?? "null";
    return json.length > 120 ? `${json.slice(0, 120)}…` : json;
  } catch {
    return "(unserializable)";
  }
}

/** 豁免旗标嗅探（M2 突变面）：任何「免确认」企图位——闸面整单拒绝。 */
export function hasExemptionAffordance(args: Record<string, unknown>): boolean {
  for (const key of ["exempt", "auto_confirm", "autoConfirm", "skip_confirmation", "skipConfirm", "confirmed"]) {
    if (args[key] === true) return true;
  }
  return false;
}

/** act 回执文本（带序列号回流——D7-1）。 */
export function formatActReceipt(result: { ok: boolean; seq: number; detail: string }): string {
  return `动作回执（seq=${result.seq}）：${result.ok ? "成功" : "失败"}——${result.detail}`;
}

/** 会话显示标题单源（TR-207：title > topic > firstUserText > 兜底——
 *  快照/清单/read_session 三消费面共用，不得另写推导链）。 */
export function displayTitleOf(r: StewardSessionMetaRow): string {
  return r.title ?? r.topic ?? r.firstUserText ?? "（无主题）";
}

/** 工作记忆记录 → LLM 消息（同源映射：记录携带 at，LLM 面不含时间戳；
 *  Phase 1 块模型：投影记录（text/thinking/toolCall 三可选）→ assistant
 *  content 块数组——翻译层单点，投影面形状稳定不随块模型变）。 */
function recordToMessage(record: StewardHistoryRecord): StewardLlmMessage {
  if (record.kind === "user") return { role: "user", text: record.text };
  // 压缩摘要记录（事故热修批⑤）：LLM 窗口重建仍转换为 user 形态摘要消息注入
  // 上下文（压缩机制语义不变——摘要是最早上下文）；仅落库形态与 UI 回放退出
  // user 轮域。旧存量（kind=user + compaction:true）同构兼容。
  if (record.kind === "compaction") return { role: "user", text: record.text };
  if (record.kind === "toolResult") {
    return { role: "toolResult", toolCallId: record.toolCallId, name: record.name, text: record.text };
  }
  const content: StewardLlmContentBlock[] = [];
  if (record.thinking !== undefined && record.thinking.text !== "") {
    content.push({
      type: "thinking",
      text: record.thinking.text,
      ...(record.thinking.signature !== undefined ? { signature: record.thinking.signature } : {}),
    });
  }
  if (record.text !== undefined && record.text !== "") content.push({ type: "text", text: record.text });
  if (record.toolCall !== undefined) {
    content.push({ type: "toolCall", id: record.toolCall.id, name: record.toolCall.name, args: record.toolCall.args });
  }
  return { role: "assistant", content };
}

/** 字段级截断（紧凑投影用；超限截断加省略号）。 */
export function capChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** 投递回执组装（纯函数导出供单测+组合根消费——回执文案单源）：
 *  标题在场 → 「已投递到『<标题>』会话」（idle 新轮次）/「已加入『<标题>』
 *  执行队列」（steered 入队）；标题缺席 → 维持旧文案（含 sessionId）。 */
export function formatDeliverReceipt(
  title: string | undefined,
  mode: "steered" | "new",
  sessionId: string,
): string {
  if (title !== undefined && title !== "") {
    const short = capChars(title, DELIVER_TITLE_MAX_CHARS);
    return mode === "steered" ? `已加入「${short}」执行队列` : `已投递到「${short}」会话`;
  }
  return mode === "steered"
    ? `已注入会话 ${sessionId} 的 steer 队列（turn 边界生效）`
    : `已送达会话 ${sessionId}（空闲会话——作为新轮次开启）`;
}

/** 工具结果送 LLM 前体量护栏（A1-hotfix 纯函数，导出供单测）：超
 *  TOOL_RESULT_MAX_CHARS 截断 + 标记（防任何工具的病理体量直达上下文）。 */
export function capToolResultText(text: string): string {
  return text.length <= TOOL_RESULT_MAX_CHARS ? text : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}${TOOL_RESULT_TRUNCATION_MARK}`;
}

/** list_instances 结果紧凑投影（A1-hotfix 纯函数，导出供单测）：根因实证
 *  orchestration.status() 全量携带完整 task brief 文本与全部历史实例。瘦身：
 *  active 保 id/state/task(≤INSTANCE_TASK_MAX_CHARS)/summary；非 active
 *  （done/failed/killed 等）仅 id/state/summary(≤INSTANCE_SUMMARY_MAX_CHARS)
 *  ——displayState 与终态实例的 task 无决策价值，弃。取舍：专用投影而非
 *  通用 JSON 字段级截断——哪些字段对管家 LLM 有用是领域知识，专用更准；
 *  任意工具的体积上限由 capToolResultText 4000 兑底。 */
export function compactInstanceRows(
  statuses: readonly {
    agentId: string;
    state: string;
    displayState?: string;
    task?: string | null;
    summary?: string | null;
  }[],
): Record<string, string>[] {
  return statuses.map((s) => {
    if (s.state === "running") {
      return {
        agentId: s.agentId,
        state: s.state,
        ...(s.task ? { task: capChars(s.task, INSTANCE_TASK_MAX_CHARS) } : {}),
        ...(s.summary ? { summary: capChars(s.summary, INSTANCE_TASK_MAX_CHARS) } : {}),
      };
    }
    return {
      agentId: s.agentId,
      state: s.state,
      ...(s.summary ? { summary: capChars(s.summary, INSTANCE_SUMMARY_MAX_CHARS) } : {}),
    };
  });
}

/** 工作记忆记录 → LLM 消息窗口（A1-hotfix 配对防御，纯函数导出供单测）：
 *  ① 孤儿 toolResult（配对 assistant toolCall 不在窗内——脏 KV/裁剪残留）
 *    丢弃；② assistant toolCall 无后续结果 → 追加合成 toolResult 占位
 *    （STEWARD_MISSING_TOOL_RESULT_TEXT）紧随其后。仅作用于送 LLM 的窗口，
 *    不改 KV 存储与 history 回放读面（UI 显示照旧）。 */
export function buildLlmWindow(records: readonly StewardHistoryRecord[]): StewardLlmMessage[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const r of records) {
    if (r.kind === "assistant" && r.toolCall !== undefined) callIds.add(r.toolCall.id);
    else if (r.kind === "toolResult") resultIds.add(r.toolCallId);
  }
  const messages: StewardLlmMessage[] = [];
  for (const r of records) {
    if (r.kind === "toolResult") {
      if (!callIds.has(r.toolCallId)) continue; // 孤儿：丢弃（自愈脏 KV，零迁移）
      messages.push(recordToMessage(r));
      continue;
    }
    messages.push(recordToMessage(r));
    if (r.kind === "assistant" && r.toolCall !== undefined && !resultIds.has(r.toolCall.id)) {
      messages.push({
        role: "toolResult",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        text: STEWARD_MISSING_TOOL_RESULT_TEXT,
      });
    }
  }
  return messages;
}

/** 口令判定（极轻纯函数，零 LLM；非词表全等 → undefined 原样走 LLM）。
 *  口令词表单源 @helix/protocol stewardPhrases（TR-240：仅 pending 在场时路由）。 */
export function matchStewardCommandPhrase(text: string): "confirm" | "cancel" | undefined {
  if (matchStewardConfirmPhrase(text)) return "confirm";
  if (matchStewardCancelPhrase(text)) return "cancel";
  return undefined;
}
