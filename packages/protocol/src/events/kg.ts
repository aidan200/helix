import type { EventFrame } from "../envelope";
import type {
  KgChangeReportDto,
  KgIndexStatusDto,
  KgNodeDetailDto,
  KgNodeListRow,
  KgProjectRow,
} from "../types/kg";

// ── kg 批新增信封（iter-20260825-11fo T5.3；P-1 图谱查看页六命令族） ──

/**
 * kg 族结果帧通则：六个结果帧全部为**命令点对点回执**（TR-AD-21 模式，
 * 仅发发起命令的连接，不经 EventStream 广播）；信封 sessionId =
 * SYSTEM_SESSION_ID、channel = "kg"。O-6 裁决零推送事件——索引进度走
 * kg.index.status 命令轮询（500ms-1s 间隔前端定），本族无任何广播事件。
 */

/** kg.projects.result：workspace 项目列表（宽松口径，含 absent 项目）。 */
export interface KgProjectsResultPayload {
  projects: KgProjectRow[];
}

/** kg.list.result：节点列表+搜索（q×kind×status 三路过滤可叠加）。 */
export interface KgListResultPayload {
  /** 项目内全部节点数（过滤前）。 */
  total: number;
  /** 过滤后命中数。 */
  matched: number;
  nodes: KgNodeListRow[];
}

/** kg.node.detail.result：节点详情六段聚合（payload 即详情本体）。 */
export type KgNodeDetailResultPayload = KgNodeDetailDto;

/** kg.change.report.result：知识变化报告（按迭代聚合；payload 即报告本体）。 */
export type KgChangeReportResultPayload = KgChangeReportDto;

/** kg.node.confirm.result：draft 审阅转正回执（翻转后状态回读）。 */
export interface KgNodeConfirmResultPayload {
  applied: true;
  node: KgNodeListRow;
}

/** kg.index.status.result：索引状态面板（四态；轮询通道本体）。 */
export type KgIndexStatusResultPayload = KgIndexStatusDto;

export interface KgProjectsResultEvent extends EventFrame<KgProjectsResultPayload> {
  channel?: "kg";
  type: "kg.projects.result";
}
export interface KgListResultEvent extends EventFrame<KgListResultPayload> {
  channel?: "kg";
  type: "kg.list.result";
}
export interface KgNodeDetailResultEvent extends EventFrame<KgNodeDetailResultPayload> {
  channel?: "kg";
  type: "kg.node.detail.result";
}
export interface KgChangeReportResultEvent extends EventFrame<KgChangeReportResultPayload> {
  channel?: "kg";
  type: "kg.change.report.result";
}
export interface KgNodeConfirmResultEvent extends EventFrame<KgNodeConfirmResultPayload> {
  channel?: "kg";
  type: "kg.node.confirm.result";
}
export interface KgIndexStatusResultEvent extends EventFrame<KgIndexStatusResultPayload> {
  channel?: "kg";
  type: "kg.index.status.result";
}
