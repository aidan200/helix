/** kg 域命令族：图谱查看 / bootstrap / 维护 / health / 评审 / 台账（契约见 PROTOCOL-CHANGELOG 各批）。 */
import type { CommandFrame } from "../envelope";
import type { EmptyPayload } from "./session";

// ── kg 批新增（iter-20260825-11fo T5.3，P-1 图谱查看页数据面；v0.11 后 additive 微批，版本位不 bump）──

/**
 * kg 族命令通则（register V-2/V-3）：六命令全部为全局命令（信封 sessionId
 * 省略）；后五个图谱命令携带必填 `project`（项目名或绝对路径，daemon
 * 单点解析——contracts/kg-viewer-api.md 总则），跨项目不串数据；kg.projects
 * 无参（workspace 根 = daemon 启动 cwd，TR-AD-6 零 env 键）。结果 =
 * kg.*.result 点对点回执帧（events/kg.ts；O-6 轮询裁决零推送事件）。
 */
export interface KgListPayload {
  /** 项目名（workspace 一级目录名）或绝对路径（必填）。 */
  project: string;
  kind?: "rule" | "entity";
  status?: "draft" | "confirmed" | "superseded";
  q?: string;
}
export interface KgListCommand extends CommandFrame<KgListPayload> {
  type: "kg.list";
}

export interface KgNodeDetailPayload {
  project: string;
  id: string;
}
export interface KgNodeDetailCommand extends CommandFrame<KgNodeDetailPayload> {
  type: "kg.node.detail";
}

export interface KgChangeReportPayload {
  project: string;
  /** 缺省 = 当前迭代（库内最近一次变更所属迭代）。 */
  iterationId?: string;
}
export interface KgChangeReportCommand extends CommandFrame<KgChangeReportPayload> {
  type: "kg.change.report";
}

export interface KgNodeConfirmPayload {
  project: string;
  id: string;
}
/** 页面唯一写动作（走 F2.3 KgWriteService，非旁路直写）；仅 draft 可转正。 */
export interface KgNodeConfirmCommand extends CommandFrame<KgNodeConfirmPayload> {
  type: "kg.node.confirm";
}

export interface KgNodeDiscardPayload {
  project: string;
  id: string;
  /** 驳回理由（可选——审计叙述落 change_log.reason；缺省「面板人审驳回（未填理由）」）。 */
  reason?: string;
}
/** 草稿人审驳回（P5 裁决动作集之二；走 KgWriteService supersede 无 replacement——审计型库无物理删除，驳回即翻 superseded 终态留审计链）；仅 draft 可驳回。 */
export interface KgNodeDiscardCommand extends CommandFrame<KgNodeDiscardPayload> {
  type: "kg.node.discard";
}

export interface KgIndexStatusPayload {
  project: string;
  /** true = 触发构建/重建（纯 codegraph 机械动作无知识层写，AD-10；absent 态触发即首次构建 B1）。 */
  rebuild?: boolean;
}
export interface KgIndexStatusCommand extends CommandFrame<KgIndexStatusPayload> {
  type: "kg.index.status";
}

export interface KgProjectsCommand extends CommandFrame<EmptyPayload> {
  type: "kg.projects";
}

// ── kg-bootstrap 批新增（iter-20260829-ys7q T3.2，/project 页 bootstrap 数据面五命令；契约 = contracts/kg-bootstrap-api.md）──

/**
 * kg-bootstrap 批通则：本批命令全部为全局命令（信封 sessionId 省略），携带
 * 必填 project（项目名或绝对路径，daemon 单点解析）；结果 = kg.*.result
 * 点对点回执帧（events/kg.ts，O-6 零推送同规）。命令清单以 COMMAND_TYPES
 * 为单源（本注不记计数）。V-1 语义：bootstrap 无 draft——产出落盘即
 * confirmed。准入机械定义 = 索引 synced/degraded ∧ nodeCount==0（前后端
 * 双保险复核；contracts/kg-bootstrap-api.md §1）。
 *
 * ⚠ 退役注记（**新消费面禁接线**，第 1 条为现状裁决）：kg.bootstrap.produce /
 * kg.node.update / kg.node.supersede / kg.bootstrap.impact 四条**无 UI 消费者**
 * ——shell 构造器已撤（「kg-bootstrap 仅 create」，见 E-84 现口径）；协议
 * 类型与 daemon 分发分支（WsServerAdapter + handlers/kg.ts）仍在册 =
 * 存量程序化入口（维护/只读推导语义在 service 内仍实现）。正式退役 = 同批
 * 清理类型目录 + 分发分支 + handler（E-118 裁决），单独删注释不算退役。
 * 未加 DEPRECATED_* 登记常量：事件侧先例（DEPRECATED_EVENT_TYPES）登记的是
 * daemon 双发兼容期帧，本四命令是「UI 消费者退役而 handler 存活」，登记为
 * 常量会与活体实现相反 —— 故用注记。
 */
export interface KgBootstrapCreatePayload {
  /** 项目名（kg.projects 项目标识；daemon 复核准入后调 createTask 同源 API）。 */
  project: string;
  /** 范围参数（可选收窄，进 job.params.scope）。 */
  scope?: string;
}
/** CL-1 F1.1/F1.2：发起 kg-bootstrap 任务（createdBy="page"，与 chat task_create 同源）。 */
export interface KgBootstrapCreateCommand extends CommandFrame<KgBootstrapCreatePayload> {
  type: "kg.bootstrap.create";
}

export interface KgBootstrapProducePayload {
  project: string;
}
/** CL-4 F4.1：产出呈现读面（任务→阶段→批次三级分组，originBatchId+layer 元数据驱动）。
 *  ⚠ 无 UI 消费者（退役注记见本段通则）——禁新接线。 */
export interface KgBootstrapProduceCommand extends CommandFrame<KgBootstrapProducePayload> {
  type: "kg.bootstrap.produce";
}

export interface KgNodeUpdatePayload {
  project: string;
  nodeId: string;
  /** 至少携带其一（空 patch → task.validation_failed）。 */
  digest?: string;
  body?: string;
}
/** CL-4 F4.2 修正写面（一）：内联编辑保存即 updateNode，节点保持 confirmed。
 *  ⚠ 无 UI 消费者（退役注记见本段通则）——禁新接线。 */
export interface KgNodeUpdateCommand extends CommandFrame<KgNodeUpdatePayload> {
  type: "kg.node.update";
}

export interface KgNodeSupersedePayload {
  project: string;
  nodeId: string;
  /** 必填非空（前后端双防线；空 → task.validation_failed）。 */
  reason: string;
}
/** CL-4 F4.2 修正写面（二）：superseded 留史 + change_log 记理由；无转正无否决。
 *  ⚠ 无 UI 消费者（退役注记见本段通则）——禁新接线。 */
export interface KgNodeSupersedeCommand extends CommandFrame<KgNodeSupersedePayload> {
  type: "kg.node.supersede";
}

export interface KgBootstrapImpactPayload {
  project: string;
  /** 被修正（update/supersede）的节点 id。 */
  nodeId: string;
}
/** CL-4 F4.3：受影响连带只读推导（edges 引用方；不落库零自动写）。
 *  ⚠ 无 UI 消费者（退役注记见本段通则）——禁新接线。 */
export interface KgBootstrapImpactCommand extends CommandFrame<KgBootstrapImpactPayload> {
  type: "kg.bootstrap.impact";
}

// ── kg 维护批新增（C1：清空图谱 + 删除索引两命令；全局命令，必填 project）──

export interface KgGraphPurgePayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
}
/**
 * 清空本项目 kg 库全部内容（知识面 + 符号面 + meta 基准，全量清 + 索引态复位
 * absent——不动 .codegraph，那是 kg.index.delete 的职责）。安全门禁：存在
 * 任一 kg 写任务族（kg-bootstrap/kg-triage/kg-review）的非终态
 * （running/pending/paused）任务时拒绝（kg.graph.purge_blocked）。
 */
export interface KgGraphPurgeCommand extends CommandFrame<KgGraphPurgePayload> {
  type: "kg.graph.purge";
}

export interface KgIndexDeletePayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
}
/**
 * 删除项目 .codegraph 索引目录 + kg 索引态复位 absent（联动停 fs-watch
 * watcher；知识层不动——下次 triggerManual 重建索引后符号面自动恢复）。
 */
export interface KgIndexDeleteCommand extends CommandFrame<KgIndexDeletePayload> {
  type: "kg.index.delete";
}

// ── kg.health 批新增（W2-E 轨一结构体检看板；设计 kg-driven-dev-loop-design D5 + R15）──

export interface KgHealthPayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
}
/**
 * 结构体检五项读面聚合（findConflicts / findOrphans / orphan 计数 / index
 * 状态 / candidates 四态计数）——纯只读零写路径；absent 项目短路返回空态
 * （不建库）。结果 = kg.health.result 点对点回执帧（O-6 零推送同规）。
 */
export interface KgHealthCommand extends CommandFrame<KgHealthPayload> {
  type: "kg.health";
}

// ── kg.candidates.list 批新增（台账读面三件套之三：P-1 台账查看面板数据面；只读零裁决） ──

export interface KgCandidatesListPayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
  /** 状态过滤（可选四态；缺省全量最新在前）。 */
  status?: "pending" | "deferred" | "applied" | "discarded";
  /** 分页（可选：行数上限 / 跳过行数；缺省全量）。 */
  limit?: number;
  offset?: number;
}
/**
 * 候选台账列表读面（candidates 表 status 过滤 + 分页；行含 body 全文——
 * 选中行展开详情数据源）。只读零写路径——本轮无页面裁决写命令（裁决归
 * kg-review 人审 / decideCandidate）；unbound 防御 = 空集结果非报错
 * （kg.list 同规）。结果 = kg.candidates.list.result 点对点回执帧。
 */
export interface KgCandidatesListCommand extends CommandFrame<KgCandidatesListPayload> {
  type: "kg.candidates.list";
}

// ── kg 评审批新增（W2-F 轨二语义体检任务 kg-review；设计 kg-driven-dev-loop-design D5 + R21/R23）──

export interface KgReviewCreatePayload {
  /** 项目名或绝对路径（daemon 单点解析 + 准入复核：索引存在即可，允许反复发起）。 */
  project: string;
}
/**
 * 发起 kg-review 语义体检任务（type="kg-review"、projects=[project]、
 * params={projectRoot}、createdBy="page"，与 kg.bootstrap.create 同源 createTask）。
 * 与 bootstrap 一次性语义不同：体检面向存量图谱，知识层非空恰是评审对象，
 * 可反复发起；准入从简 = 索引存在（index_absent → kg.review.not_eligible）。
 */
export interface KgReviewCreateCommand extends CommandFrame<KgReviewCreatePayload> {
  type: "kg.review.create";
}

// ── kg.triage.create（kg-triage P1：待办面即时裁决任务发起）──

export interface KgTriageCreatePayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
}
/**
 * 发起 kg-triage 待办面裁决任务（type="kg-triage"、projects=[project]、
 * params={projectRoot}、createdBy="page"，与 kg.review.create 同源 createTask）。
 * 准入 = 索引存在 + 待办面非空（pending+deferred+dead_anchor 三计数 > 0）
 * + 仅禁并发；nothing_pending / index_absent → kg.triage.not_eligible。
 */
export interface KgTriageCreateCommand extends CommandFrame<KgTriageCreatePayload> {
  type: "kg.triage.create";
}

// ── kg.auto.audit（P2 自动裁决审计面：auto: 前缀聚合 + 抽查条目）──

export interface KgAutoAuditPayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
  /** 抽查条目上限（缺省 50；<=0 回缺省；不影响 stats total）。 */
  limit?: number;
}
/**
 * 自动裁决审计读面（change_log auto: 前缀行聚合）：L0 机械重定位 +
 * kg-triage 自动裁决的统一事后抽查入口（面板低频抽评准确率用）；只读。
 */
export interface KgAutoAuditCommand extends CommandFrame<KgAutoAuditPayload> {
  type: "kg.auto.audit";
}

// ── code.review.create（code-review v1.5：P-1 体检区双入口之代码评审发起）──

export interface CodeReviewCreatePayload {
  /** 项目名或绝对路径（daemon 单点解析；准入从简——无索引门槛，允许反复发起）。 */
  project: string;
}
/**
 * 发起 code-review 代码评审任务（type="code-review"、projects=[project]、
 * params={projectRoot}、createdBy="page"，与 kg.review.create 同源 createTask）。
 * 无准入门槛（不要求 .helix-kg 索引——评审对象是代码不是图谱）。
 */
export interface CodeReviewCreateCommand extends CommandFrame<CodeReviewCreatePayload> {
  type: "code.review.create";
}

