/**
 * kg 族共享 DTO（P-1 图谱查看页数据面，iter-20260825-11fo T5.3）。
 *
 * 契约权威源 = 各迭代 `development/contracts/kg-viewer-api.md`（T5.3 daemon
 * 数据面与 T5.4 shell 前端的共同约定；逐字段以契约为准）。本文件是该契约
 * 的协议类型落位（AD-8/AG-13：两端同源，仓内不得平行手写）。
 *
 * 批次：v0.11 后 additive 微批（版本位不 bump，§14/§18 同构先例）——
 * O-6 裁决零推送事件：本族六个 `kg.*.result` 全部为命令点对点回执帧
 * （TR-AD-21 模式），索引进度走 kg.index.status 命令轮询。
 *
 * AD-16 引用规范（数据层强制）：NodeRef 携带 id 仅供详情跳转（前端
 * data-id 属性承载），人类可读字段（label/body/eventText 等）不出现
 * TR-n/E-n 裸形态；项目名（目录名）是人类面可见文本，不受 AD-16 限制。
 */

/** 项目索引四态（§3.5；absent=未建索引，B1 冷启动入口）。 */
export type KgProjectState = "absent" | "building" | "synced" | "degraded";

/** workspace 项目行（kg.projects 响应；左栏项目列表数据源）。 */
export interface KgProjectRow {
  /** 一级目录名（project 入参两形态之一；人类面可见文本）。 */
  name: string;
  /** 绝对路径（project 入参两形态之二）。 */
  path: string;
  /** 索引四态（与 KgIndexStatus.state 同枚举）。 */
  status: KgProjectState;
  /** synced 态：符号计数。 */
  symbolCount?: number;
  /** synced 态：知识节点计数。 */
  nodeCount?: number;
  /** synced 态：最近完成同步时间（ISO）。 */
  syncedAt?: string;
  /** degraded 态：影响说明。 */
  degradedNote?: string;
}

/** 节点类别徽章（rule=cyan / entity=violet，前端色映射）。 */
export type KgNodeKindDto = "rule" | "entity";

/** 节点生命周期（AD-11/AD-14：superseded 为终态）。 */
export type KgNodeStatusDto = "draft" | "confirmed" | "superseded";

/**
 * 节点列表行（kg.list 响应行）。domain 为 SoT 侧可空属性（NodeDigestRow
 * 同形）：null = 未声明域（前端不渲染域 chip）。
 */
export interface KgNodeListRow {
  /** 仅供详情跳转（data-id 属性承载），不作为可见文本（AD-16）。 */
  id: string;
  /** 粗体展示。 */
  name: string;
  kind: KgNodeKindDto;
  domain: "tech" | "business" | null;
  status: KgNodeStatusDto;
  /** 单行截断展示。 */
  digest: string;
}

/** 锚点行状态：dead=失效（⚠ 符号已删除）/ stale=长期无命中（?，启发式）/ ok。 */
export type KgAnchorState = "ok" | "dead" | "stale";

/** 节点详情锚点行（path 锚无 symbol；line 取上次 sync 符号 span 起点）。 */
export interface KgAnchorRow {
  symbol?: string;
  path: string;
  line?: number;
  state: KgAnchorState;
}

/** 人类面节点引用（AD-16：粗体 name+kind 徽章+digest 首行；id 供跳转）。 */
export interface KgNodeRefDto {
  id: string;
  name: string;
  kind: KgNodeKindDto;
  digestFirstLine: string;
}

/** 关系行（对方节点引用可跳转；verb 封闭词表透传）。 */
export interface KgRelationRow {
  verb: string;
  peer: KgNodeRefDto;
}

/** 变更日志行（最新在上，由 daemon 排序后下发）。 */
export interface KgLogRow {
  /** ISO 时间戳。 */
  date: string;
  iterationId: string;
  /** 事件叙述（无裸 id，AD-16）。 */
  eventText: string;
}

/** 节点详情六段聚合（kg.node.detail 响应）。 */
export interface KgNodeDetailDto {
  id: string;
  name: string;
  kind: KgNodeKindDto;
  domain: "tech" | "business" | null;
  status: KgNodeStatusDto;
  digest: string;
  /** 描述（body 的叙述段）。 */
  desc: string;
  /** 规则条目（body 的列表条目行）。 */
  rules: string[];
  anchors: KgAnchorRow[];
  relations: KgRelationRow[];
  /** 垂直链：历史项（旧→新）+ 现行项。 */
  supersede: { history: KgNodeRefDto[]; current: KgNodeRefDto };
  log: KgLogRow[];
}

/** 变化报告条目四类（封闭集，F3.3）。 */
export type KgReportEntryKind = "dead_anchor" | "rule_conflict" | "suspect_stale" | "knowledge_change";

/** 严重级：warn→⚠ / info→? / ok→✓（前端 glyph 与色映射）。 */
export type KgReportSev = "warn" | "info" | "ok";

/** 人类面代码符号引用（AD-16：符号名+路径(:行号)）。 */
export interface KgSymbolRefDto {
  name: string;
  path: string;
  line?: number;
}

/** 变化报告条目（T5.1 KgReportService 契约形状直传）。 */
export interface KgReportEntryDto {
  kind: KgReportEntryKind;
  sev: KgReportSev;
  /** 类型标签。 */
  label: string;
  /** 因果叙述句（事件导向，主语=你/本迭代；疑似类含限定词）。 */
  body: string;
  refs: { nodes: KgNodeRefDto[]; symbols: KgSymbolRefDto[] };
  /** 行动项选项（本迭代仅呈现不落库；转正例外走 kg.node.confirm）。 */
  options: string[];
}

/** 知识变化报告（kg.change.report 响应；按迭代聚合）。 */
export interface KgChangeReportDto {
  iterationId: string;
  entries: KgReportEntryDto[];
}

/** 索引状态面板（kg.index.status 响应；四态互斥）。 */
export interface KgIndexStatusDto {
  state: KgProjectState;
  /** building 态：N / M 符号进度（当前 sync 管道为单事务不可分，暂缺省）。 */
  progress?: { done: number; total: number };
  /** synced 态：完成时间（ISO）。 */
  syncedAt?: string;
  /** synced 态：符号计数。 */
  symbolCount?: number;
  /** degraded 态：影响说明。 */
  degradedNote?: string;
}
