/**
 * 附着去重预算（architecture.md §5.3，CL-1 F1.2，AD-4/AD-13）。
 *
 * 会话级跨通道去重（sessionSeen：已注入/已附节点不再入选，键型 =
 * `project\0nodeId` 复合键——多项目 workspace 同 id 节点互不静默排除；
 * 复合键由 seenKeyOf 单点生成，调用方 T3.2/T3.3 负责跨通道共享同一 Set）
 * + 单块 token 硬顶（估算=渲染字符数/4）
 * + 特异性排序（符号域 > 路径域；同域稳定保序）。全局域节点不进附着
 * （已在 scope-matcher 防御性过滤，预算层输入即无 global）。
 *
 * 纯函数、零 IO（TR-AD-1）；不改变调用方传入的 sessionSeen。
 */

import type { MatchedAnchor } from "./scope-matcher";
import { attachmentBlockChars } from "./render";

/** 单块 token 硬顶（实现期可调常量；token 估算 = 渲染字符数 / 4）。 */
export const ATTACHMENT_TOKEN_BUDGET = 800;

/**
 * 会话去重注册表键型单点（F3 修复：裸 nodeId → `project\0nodeId` 复合键）。
 * 多项目 workspace 下各项目 id 空间独立（TR-n/E-n 碰撞结构性必然）——注册表
 * （sessionSeen/markInjected）与排除/去重判定必须同用复合键，否则项目 A 已
 * 到达的 id 会静默排除项目 B 的同 id 不同节点。\u0000 分隔与 selectTaskSlice
 * 去重键同型（L111 既有口径归一）。
 */
export function seenKeyOf(project: string, nodeId: string): string {
  return `${project}\u0000${nodeId}`;
}

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
 * sessionSeen 持复合键（seenKeyOf 口径）；candidates 全部来自同一 project
 * （单次附着只读单项目快照），project 参数即该快照归属项目根。
 */
export function applyBudget(
  candidates: readonly MatchedAnchor[],
  sessionSeen: ReadonlySet<string>,
  budget: AttachmentBudget,
  project: string,
): AttachmentSelection {
  // ① 会话级去重 + 候选内去重（首见保留，稳定基序；复合键口径）
  const seen = new Set(sessionSeen);
  const unique: MatchedAnchor[] = [];
  for (const c of candidates) {
    const key = seenKeyOf(project, c.nodeId);
    if (seen.has(key)) continue;
    seen.add(key);
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
