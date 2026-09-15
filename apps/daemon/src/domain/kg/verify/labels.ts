/**
 * 验证期检查共享叙述 helper（单源收口：三检查此前逐字重复的标签函数）。
 *
 * kindLabelOf 此前在 orphans/conflicts/activity-mismatch 三文件逐字重复，
 * anchorLabel 在 orphans（私有）与 activity-mismatch（内联三元）两处同构
 * ——收口本文件，叙述面词汇不两套（对齐 AD-16 叙述纪律）。零写路径。
 */

import type { KnowledgeNode, MaterializedAnchor } from "../types";

/** 节点 kind 的人读标签（summary 叙述前缀——「规则」/「实体」统一词汇）。 */
export function kindLabelOf(kind: KnowledgeNode["kind"]): string {
  return kind === "rule" ? "规则" : "实体";
}

/** 锚叙述名：符号锚 path#symbol；文件锚 path。 */
export function anchorLabel(anchor: MaterializedAnchor): string {
  return anchor.anchorSymbol === null || anchor.anchorSymbol === ""
    ? anchor.anchorPath
    : `${anchor.anchorPath}#${anchor.anchorSymbol}`;
}
