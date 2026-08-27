/**
 * 附着去重预算（architecture.md §5.3，CL-1 F1.2，AD-4/AD-13）。
 *
 * 会话级跨通道去重（sessionSeen：已注入/已附节点 id 不再入选；调用方
 * T3.2/T3.3 负责跨通道共享同一 Set）+ 单块 token 硬顶（估算=渲染字符数/4）
 * + 特异性排序（符号域 > 路径域；同域稳定保序）。全局域节点不进附着
 * （已在 scope-matcher 防御性过滤，预算层输入即无 global）。
 *
 * 纯函数、零 IO（TR-AD-1）；不改变调用方传入的 sessionSeen。
 */

import type { MatchedAnchor } from "./scope-matcher";
import { attachmentBlockChars } from "./render";

/** 单块 token 硬顶（实现期可调常量；token 估算 = 渲染字符数 / 4）。 */
export const ATTACHMENT_TOKEN_BUDGET = 800;

/** 预算参数（调用方传 { maxTokens: ATTACHMENT_TOKEN_BUDGET } 起步）。 */
export interface AttachmentBudget {
  readonly maxTokens: number;
}

/** 预算裁剪后的附着选择（渲染输入；空 anchors = 沉默）。 */
export interface AttachmentSelection {
  readonly anchors: readonly MatchedAnchor[];
}

/** 特异性：符号域 0 > 路径域 1（升序保留高特异性在前）。 */
function domainRank(a: MatchedAnchor): number {
  return a.domain === "symbol" ? 0 : 1;
}

/**
 * 去重 + 硬顶 + 排序：按特异性序贪心装入，超限项让位（保留更高特异性
 * 者）；无任何可容项 → 空选择（宁可沉默）。
 */
export function applyBudget(
  candidates: readonly MatchedAnchor[],
  sessionSeen: ReadonlySet<string>,
  budget: AttachmentBudget,
): AttachmentSelection {
  // ① 会话级去重 + 候选内 nodeId 去重（首见保留，稳定基序）
  const seen = new Set(sessionSeen);
  const unique: MatchedAnchor[] = [];
  for (const c of candidates) {
    if (seen.has(c.nodeId)) continue;
    seen.add(c.nodeId);
    unique.push(c);
  }
  if (unique.length === 0) return { anchors: [] };

  // ② 特异性排序：符号域 > 路径域；Array#sort 稳定 → 同域保持输入序
  const ranked = [...unique].sort((a, b) => domainRank(a) - domainRank(b));

  // ③ token 硬顶贪心装入（估算与渲染共用 attachmentBlockChars，口径一致）
  const picked: MatchedAnchor[] = [];
  for (const c of ranked) {
    if (attachmentBlockChars([...picked, c]) / 4 <= budget.maxTokens) {
      picked.push(c);
    }
  }
  return { anchors: picked };
}
