/**
 * shared/api/commands/kg —— kg 域（项目/节点/变更读面、节点裁决、bootstrap/维护/体检/评审批读面）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  KgAutoAuditCommand,
  KgAutoAuditPayload,
  KgBootstrapCreateCommand,
  KgBootstrapCreatePayload,
  KgCandidatesListCommand,
  KgCandidatesListPayload,
  KgChangeReportCommand,
  KgChangeReportPayload,
  KgGraphPurgeCommand,
  KgGraphPurgePayload,
  KgHealthCommand,
  KgHealthPayload,
  KgIndexDeleteCommand,
  KgIndexDeletePayload,
  KgIndexStatusCommand,
  KgIndexStatusPayload,
  KgListCommand,
  KgListPayload,
  KgNodeConfirmCommand,
  KgNodeConfirmPayload,
  KgNodeDiscardCommand,
  KgNodeDiscardPayload,
  KgNodeDetailCommand,
  KgNodeDetailPayload,
  KgProjectsCommand,
  KgReviewCreateCommand,
  KgReviewCreatePayload,
  KgTriageCreateCommand,
  KgTriageCreatePayload,
} from "@helix/protocol";

// ── kg 族命令（契约 v0.11 kg 批，contracts/kg-viewer-api.md；T5.4）────
// 六命令全部全局命令（信封 sessionId 省略）；五个图谱命令 payload 必填
// project（名称或绝对路径，daemon 单点解析）；kg.projects 无参。回执 =
// kg.*.result 点对点帧（O-6 轮询裁决零推送事件）。

/** kg.projects：workspace 项目列表（F5.0 左栏数据源；宽松口径含 absent）。 */
export function kgProjectsCommand(): KgProjectsCommand {
  return { v: PROTOCOL_VERSION, type: "kg.projects", payload: {} };
}

/** kg.list：节点列表+搜索（F5.1；q×kind×status 三路过滤可叠加，均可省略）。 */
export function kgListCommand(payload: KgListPayload): KgListCommand {
  return { v: PROTOCOL_VERSION, type: "kg.list", payload };
}

/** kg.node.detail：节点详情六段聚合（F5.2）。 */
export function kgNodeDetailCommand(payload: KgNodeDetailPayload): KgNodeDetailCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.detail", payload };
}

/** kg.change.report：知识变化报告（F5.3；iterationId 缺省 = 当前迭代）。 */
export function kgChangeReportCommand(payload: KgChangeReportPayload): KgChangeReportCommand {
  return { v: PROTOCOL_VERSION, type: "kg.change.report", payload };
}

/** kg.node.confirm：draft 审阅转正（F5.4 页面唯一写动作；仅 draft 可转正）。 */
export function kgNodeConfirmCommand(payload: KgNodeConfirmPayload): KgNodeConfirmCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.confirm", payload };
}

/** kg.node.discard：草稿人审驳回（P5 裁决动作集之二——supersede 无 replacement 留审计链，仅 draft 可驳回）。 */
export function kgNodeDiscardCommand(payload: KgNodeDiscardPayload): KgNodeDiscardCommand {
  return { v: PROTOCOL_VERSION, type: "kg.node.discard", payload };
}

/** kg.index.status：索引状态四态面板（F5.5；rebuild:true = 触发构建/重建，
 *  absent 态触发即首次构建 B1；O-6 前端轮询本命令获取进度）。 */
export function kgIndexStatusCommand(payload: KgIndexStatusPayload): KgIndexStatusCommand {
  return { v: PROTOCOL_VERSION, type: "kg.index.status", payload };
}

// ── kg-bootstrap 批五命令（iter-20260829-ys7q T3.2；契约 contracts/kg-bootstrap-api.md）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。
// V-1：产出即 confirmed 无草稿；修正 = update/supersede（理由必填）；连带 =
// impact 只读推导（不落库零自动写）。

/** kg.bootstrap.create：发起 bootstrap 任务（CL-1；后端准入机械复核 + createTask 同源）。 */
export function kgBootstrapCreateCommand(payload: KgBootstrapCreatePayload): KgBootstrapCreateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.bootstrap.create", payload };
}

// ── kg 维护批两命令（C1；契约 PROTOCOL-CHANGELOG.md §22）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。
// 职责分层：purge 清 kg 库全部内容（不动 .codegraph）；index.delete 删索引
// 目录（不动知识层）。

/** kg.graph.purge：清空图谱（危险操作——UI 两步确认；daemon 门禁：运行中 kg-bootstrap 任务拒绝）。 */
export function kgGraphPurgeCommand(payload: KgGraphPurgePayload): KgGraphPurgeCommand {
  return { v: PROTOCOL_VERSION, type: "kg.graph.purge", payload };
}

/** kg.index.delete：删除索引（停 watcher + 删 .codegraph + 状态复位 absent；可重建）。 */
export function kgIndexDeleteCommand(payload: KgIndexDeletePayload): KgIndexDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "kg.index.delete", payload };
}

// ── kg.health 批 + kg 评审批命令（W2-E 体检看板 / W2-F 轨二；契约 PROTOCOL.md §15.9/§23）────
// 全局命令（信封 sessionId 省略）；回执 = kg.*.result 点对点帧（零推送同规）。

/** kg.health：结构体检五项读面聚合（只列不修零写路径；absent 短路空态不建库）。 */
export function kgHealthCommand(payload: KgHealthPayload): KgHealthCommand {
  return { v: PROTOCOL_VERSION, type: "kg.health", payload };
}

/** kg.candidates.list：候选台账列表（status 四态过滤 + 分页；行含 body 全文；只读零裁决）。 */
export function kgCandidatesListCommand(payload: KgCandidatesListPayload): KgCandidatesListCommand {
  return { v: PROTOCOL_VERSION, type: "kg.candidates.list", payload };
}

/** kg.triage.create：发起待办面裁决任务（kg-triage；准入 = 索引存在 + 待办非空 + 仅禁并发）。 */
export function kgTriageCreateCommand(payload: KgTriageCreatePayload): KgTriageCreateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.triage.create", payload };
}

/** kg.auto.audit：自动裁决审计读面（auto: 前缀聚合 + 抽查条目；只读）。 */
export function kgAutoAuditCommand(payload: KgAutoAuditPayload): KgAutoAuditCommand {
  return { v: PROTOCOL_VERSION, type: "kg.auto.audit", payload };
}

/** kg.review.create：发起语义体检任务（准入从简 = 索引存在即可，允许反复发起）。 */
export function kgReviewCreateCommand(payload: KgReviewCreatePayload): KgReviewCreateCommand {
  return { v: PROTOCOL_VERSION, type: "kg.review.create", payload };
}
