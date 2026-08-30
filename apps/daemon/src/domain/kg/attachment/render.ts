/**
 * 📎 附着块渲染（architecture.md §5.3，CL-1 F1.2，AD-14）。
 *
 * digest + 指针形态（AD-3：图谱只附导航与约束摘要，内容永远来自 read/
 * kg get）；块尾固定一行 supersede 协议——多节点共用一行，是 supersede
 * 声明通道的第一道防线。
 *
 * 纯函数、零 IO（TR-AD-1）。
 */

import type { MatchedAnchor } from "./scope-matcher";
import type { AttachmentSelection } from "./budget";

/** 协议行（brief 契约逐字符；AD-14）。 */
export const ATTACHMENT_PROTOCOL_LINE =
  "若本次改动推翻此节点，随改动提交 supersede（kg-update）";

const HEADER = "📎 本次编辑命中以下知识节点（digest+指针，详情经 kg get 获取）：";

/** 单节点条目：粗体 name + kind 徽章 + digest + scene 段（空 scene 兑底省略）+ kg get 指针。 */
function renderEntry(a: MatchedAnchor): string {
  const sceneLine = a.scene !== "" ? `\n  适用：${a.scene}` : "";
  return `- **${a.name}** [${a.kind}] — ${a.digest}${sceneLine}\n  ↳ kg get ${a.nodeId}`;
}

/** 渲染附着块；空选择返回 ''（沉默零成本）。 */
export function renderAttachment(sel: AttachmentSelection): string {
  const { anchors } = sel;
  if (anchors.length === 0) return "";
  return [HEADER, ...anchors.map(renderEntry), ATTACHMENT_PROTOCOL_LINE].join("\n");
}

/**
 * 块字符数（预算估算口径与渲染同源：token 估算 = 渲染字符数 / 4）。
 * 供 budget.ts 贪心装入使用——估算与最终渲染永不漂移。
 */
export function attachmentBlockChars(anchors: readonly MatchedAnchor[]): number {
  return renderAttachment({ anchors }).length;
}
