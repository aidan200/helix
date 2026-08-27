/**
 * kg 节点 id 发号规则（domain/kg 纯函数，framework-free）。
 *
 * AD-16：形态 <kind前缀>-<序号>（rule→TR-n，entity→E-n）；序号按 kind 单调
 * 递进、落库事务内分配、永不复用（supersede 只翻 status 不换号）；
 * 存量保号迁移（T5.2）：旧 id 原样保留、新号从全空间数字 max+1 起——
 * parseExistingMax 为该迁移提供复合前缀（TR-AD-N / TR-TEST-N）的数字提取。
 */
import type { NodeId, NodeKind } from "./types";

/** kind → id 前缀（AD-16）。 */
export function nodeIdPrefix(kind: NodeKind): "TR" | "E" {
  return kind === "rule" ? "TR" : "E";
}

/** 序号 → 规范形态 id（新号空间唯一合法形态：`TR-47` / `E-3`）。 */
export function formatNodeId(kind: NodeKind, seq: number): NodeId {
  return `${nodeIdPrefix(kind)}-${seq}`;
}

/** 新号空间严格形态解析（`TR-AD-47` 复合前缀 / 大小写变体 / 非数字尾缀一律 null）。 */
export function parseNodeId(id: string): { kind: NodeKind; seq: number } | null {
  const match = /^(TR|E)-(\d+)$/.exec(id);
  if (match === null) return null;
  return { kind: match[1] === "TR" ? "rule" : "entity", seq: Number(match[2]) };
}

/**
 * 存量 id 集合的按 kind 数字最大值提取（T5.2 保号迁移 max+1 发号起点）：
 * 兼容 v1 复合前缀（`TR-AD-47`→47、`TR-TEST-2`→2）与非数字尾缀（`E-客户`→忽略）；
 * 前缀决定 kind 归属（TR→rule / E→entity），其余前缀（SPEC-2 等）不参与。
 * 空集 / 无可提取数字 → { rule: 0, entity: 0 }。
 */
export function parseExistingMax(ids: readonly string[]): { rule: number; entity: number } {
  const max = { rule: 0, entity: 0 };
  for (const id of ids) {
    const match = EXISTING_ID_RE.exec(id);
    if (match === null) continue;
    const seq = Number(match[2]);
    if (match[1] === "TR") {
      if (seq > max.rule) max.rule = seq;
    } else if (seq > max.entity) {
      max.entity = seq;
    }
  }
  return max;
}

/** 存量 id 全形态（新号空间 + 保号复合前缀 + 中文尾缀；与 parseExistingMax 同一口径）。 */
const EXISTING_ID_RE = /^(TR|E)(?:-[A-Za-z\u4e00-\u9fff]+)*-(\d+)$/;

/**
 * 保号迁移 id 形态解析（T5.2 显式 id 写入口消费）：TR/E 前缀 + 任意存量
 * 尾缀（新号空间 TR-47 / 复合前缀 TR-AD-47、TR-TEST-8 / 中文尾缀 E-客户
 * 均合法）；数字尾缀可提取则给 seq（计数器推进），无数字尾缀 seq=null
 * （不推进计数器——非数字存量号不占新号空间序数）。
 * 非 TR/E 前缀（SPEC-2 等）/裸串 → null（KG_E_SCHEMA 输入面）。
 */
export function parseMigrationId(id: string): { kind: NodeKind; seq: number | null } | null {
  const prefix = /^(TR|E)-.+/.exec(id);
  if (prefix === null) return null;
  const seqMatch = /-(\d+)$/.exec(id);
  return { kind: prefix[1] === "TR" ? "rule" : "entity", seq: seqMatch === null ? null : Number(seqMatch[1]) };
}

/**
 * 存量 id 形态校验（T3.3 kg 工具 get 消费）：TR-n / E-n 新号空间 + 保号
 * 复合形态（TR-AD-47 / E-客户 等）均合法；其余（SPEC-2 / TR-abc / 裸串）
 * false——非法形态在工具层结构化报错而非空结果（参数供给闭环，CL-4.A3）。
 */
export function isValidNodeRef(id: string): boolean {
  return EXISTING_ID_RE.test(id);
}
