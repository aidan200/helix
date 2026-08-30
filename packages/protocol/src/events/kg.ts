import type { EventFrame } from "../envelope";
import type {
  KgChangeReportDto,
  KgIndexStatusDto,
  KgNodeDetailDto,
  KgNodeListRow,
  KgNodeRefLiteDto,
  KgProduceGroupDto,
  KgProduceNodeDto,
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

// ── kg-bootstrap 批新增回执（iter-20260829-ys7q T3.2，五命令；契约 = contracts/kg-bootstrap-api.md）──

/** kg.bootstrap.create.result：任务已创建（前端引导「前往『任务』页观察 →」）。 */
export interface KgBootstrapCreateResultPayload {
  ok: true;
  jobId: string;
}

/** kg.bootstrap.produce.result：产出三级分组（payload 即分组本体；空 groups = 无 bootstrap 产出）。 */
export interface KgBootstrapProduceResultPayload {
  groups: KgProduceGroupDto[];
}

/** kg.node.update.result：修改后状态回读（节点保持 confirmed；payload = 产出条目投影）。 */
export interface KgNodeUpdateResultPayload {
  ok: true;
  node: KgProduceNodeDto;
}

/** kg.node.supersede.result：已废弃留史（change_log 记理由；前端翻条目 + 消隐动作钮）。 */
export interface KgNodeSupersedeResultPayload {
  ok: true;
}

/** kg.bootstrap.impact.result：受影响引用方只读推导（前端渲染 warning 标记 + toast count）。 */
export interface KgBootstrapImpactResultPayload {
  affected: KgNodeRefLiteDto[];
  count: number;
}

export interface KgBootstrapCreateResultEvent extends EventFrame<KgBootstrapCreateResultPayload> {
  channel?: "kg";
  type: "kg.bootstrap.create.result";
}
export interface KgBootstrapProduceResultEvent extends EventFrame<KgBootstrapProduceResultPayload> {
  channel?: "kg";
  type: "kg.bootstrap.produce.result";
}
export interface KgNodeUpdateResultEvent extends EventFrame<KgNodeUpdateResultPayload> {
  channel?: "kg";
  type: "kg.node.update.result";
}
export interface KgNodeSupersedeResultEvent extends EventFrame<KgNodeSupersedeResultPayload> {
  channel?: "kg";
  type: "kg.node.supersede.result";
}
export interface KgBootstrapImpactResultEvent extends EventFrame<KgBootstrapImpactResultPayload> {
  channel?: "kg";
  type: "kg.bootstrap.impact.result";
}

// ── kg 维护批新增回执（C1：kg.graph.purge / kg.index.delete 两命令）──

/** kg.graph.purge.result：清空完成回执（全表清零计数 + 索引态已复位 absent）。 */
export interface KgGraphPurgeResultPayload {
  purged: true;
  /** 清除的知识节点行数（含 superseded 留史行）。 */
  nodesRemoved: number;
  /** 清除的符号行数（符号面同步基准一并清零）。 */
  symbolsRemoved: number;
  /** 清除的文件基准行数。 */
  filesRemoved: number;
}

/** kg.index.delete.result：索引删除回执（.codegraph 已删 + 状态复位 absent + watcher 已停）。 */
export interface KgIndexDeleteResultPayload {
  deleted: true;
  /** 删除后索引态（恒 absent——状态机自洽断言位）。 */
  state: "absent";
  /** fs-watch watcher 已停（B3 stopWatching 接缝消费确认）。 */
  watcherStopped: boolean;
}

export interface KgGraphPurgeResultEvent extends EventFrame<KgGraphPurgeResultPayload> {
  channel?: "kg";
  type: "kg.graph.purge.result";
}
export interface KgIndexDeleteResultEvent extends EventFrame<KgIndexDeleteResultPayload> {
  channel?: "kg";
  type: "kg.index.delete.result";
}
