/**
 * kg 族命令处理（P-1 图谱查看页数据面，§9 六命令族；iter-20260825-11fo T5.3）。
 *
 * 先例 = handlers/trace.ts：unimplemented 门控（kg 栈未装配 →
 * command.unimplemented 回执不崩溃）+ sendNow 点对点结果帧（kg.*.result，
 * TR-AD-21；O-6 轮询裁决零推送事件——不经 EventStream 广播）+
 * commandError 错误回执（KG_E_* 结构化错误码经 connection.error code 透传，
 * 字段路径折叠进 message 文案）。
 *
 * 依赖面 = KgViewerService（application service，architecture.md §9 明文
 * 「driving/kg.ts：调 application service，不触 driven」——routeCommand
 * 一行转发注册，handler 只转发不决策）：project 参数经 service 内
 * KgProjectService 单点解析（§3.5；handlers 禁自带 join）。payload 字段
 * 形状校验收口本入口（project/id 必填 string、可选字段 string/boolean）；
 * 枚举越界与解析失败归 service（KG_E_PARAM 带 path）。
 *
 * 全局命令（信封 sessionId 不消费）：结果帧 sessionId = SYSTEM_SESSION_ID、
 * channel = "kg"（events/kg.ts 通则；model.catalog.result 同构先例）。
 */
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type {
  KgBootstrapCreateResultEvent,
  KgBootstrapImpactResultEvent,
  KgBootstrapProduceResultEvent,
  KgChangeReportDto,
  KgChangeReportResultEvent,
  KgGraphPurgeResultEvent,
  KgIndexDeleteResultEvent,
  KgIndexStatusDto,
  KgIndexStatusResultEvent,
  KgListResultEvent,
  KgNodeConfirmResultEvent,
  KgNodeDetailDto,
  KgNodeDetailResultEvent,
  KgNodeListRow,
  KgNodeRefDto,
  KgNodeSupersedeResultEvent,
  KgNodeUpdateResultEvent,
  KgProjectRow,
  KgProjectsResultEvent,
} from "@helix/protocol";
import type {
  ChangeReport,
} from "../../../../application/services/kg/KgReportService";
import type {
  KgProjectRowView,
} from "../../../../application/services/kg/KgProjectService";
import type {
  KgBootstrapError,
  KgBootstrapService,
  ProduceGroupView,
  ProduceNodeView,
} from "../../../../application/services/kg/KgBootstrapService";
import type {
  KgMaintenanceError,
  KgMaintenanceService,
} from "../../../../application/services/kg/KgMaintenanceService";
import type {
  KgConfirmView,
  KgIndexStatusView,
  KgListView,
  KgNodeDetailView,
  KgViewerError,
  KgViewerService,
} from "../../../../application/services/kg/KgViewerService";
import type { NodeDigestRow } from "../../../../domain/kg/types";
import type { KgCommandContext } from "./context";

/** kg.projects（F5.0：宽松口径一层扫描；只读零写）。W1：unbound 防御契约——空集结果非报错。 */
export function handleKgProjects(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) {
    if (ctx.workspaceUnbound) {
      const empty: KgProjectsResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "kg",
        type: "kg.projects.result",
        payload: { projects: [] },
      };
      return ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), empty);
    }
    return unimplemented(ctx);
  }
  const rows = ctx.kg.projects();
  const frame: KgProjectsResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "kg",
    type: "kg.projects.result",
    payload: { projects: rows.map(projectRowToDto) },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** kg.list（F5.1：q×kind×status 三路过滤叠加 + total/matched）。W1：unbound → 空集结果。 */
export function handleKgList(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) {
    if (ctx.workspaceUnbound) {
      const project = requireString(ctx, "project");
      if (project === undefined) return;
      const q = optionalString(ctx, "q");
      if (q === null) return;
      const kind = optionalString(ctx, "kind");
      if (kind === null) return;
      const status = optionalString(ctx, "status");
      if (status === null) return;
      const empty: KgListResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "kg",
        type: "kg.list.result",
        payload: { total: 0, matched: 0, nodes: [] },
      };
      return ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), empty);
    }
    return unimplemented(ctx);
  }
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const q = optionalString(ctx, "q");
  if (q === null) return;
  const kind = optionalString(ctx, "kind");
  if (kind === null) return;
  const status = optionalString(ctx, "status");
  if (status === null) return;
  const result = ctx.kg.list(project, { q, kind, status });
  if (!result.ok) return viewerError(ctx, result.error);
  const frame: KgListResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "kg",
    type: "kg.list.result",
    payload: listViewToDto(result.value),
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** kg.node.detail（F5.2：聚合——body 单段/锚/关系/supersede 链/变更日志）。 */
export function handleKgNodeDetail(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const id = requireString(ctx, "id");
  if (id === undefined) return;
  const result = ctx.kg.nodeDetail(project, id);
  if (!result.ok) return viewerError(ctx, result.error);
  const frame: KgNodeDetailResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "kg",
    type: "kg.node.detail.result",
    payload: detailViewToDto(result.value),
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** kg.change.report（F5.3：KgReportService 四类条目直传；缺省=当前迭代）。 */
export function handleKgChangeReport(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const iterationId = optionalString(ctx, "iterationId");
  if (iterationId === null) return;
  const result = ctx.kg.changeReport(project, iterationId);
  if (!result.ok) return viewerError(ctx, result.error);
  const frame: KgChangeReportResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "kg",
    type: "kg.change.report.result",
    payload: reportToDto(result.value),
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** kg.node.confirm（F5.4：页面唯一写动作——走 KgWriteService，仅 draft 可转正）。 */
export function handleKgNodeConfirm(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const id = requireString(ctx, "id");
  if (id === undefined) return;
  const result = ctx.kg.confirm(project, id);
  if (!result.ok) return viewerError(ctx, result.error);
  const frame: KgNodeConfirmResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "kg",
    type: "kg.node.confirm.result",
    payload: { applied: true, node: listRowToDto(result.value.row) },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** kg.index.status（F5.5：四态透传；rebuild=纯 codegraph 构建，无知识层写）。 */
export function handleKgIndexStatus(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  if (ctx.payload.rebuild !== undefined && typeof ctx.payload.rebuild !== "boolean") {
    return ctx.commandError(ctx.type, "KG_E_PARAM", "payload.rebuild 应为 boolean");
  }
  const rebuild = ctx.payload.rebuild === true;
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.kg
    .indexStatus(project, rebuild)
    .then((result) => {
      if (!result.ok) return viewerError(ctx, result.error);
      const frame: KgIndexStatusResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "kg",
        type: "kg.index.status.result",
        payload: statusViewToDto(result.value),
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err: unknown) => {
      // 意外异常兜底（service 契约面外）：不吞声不崩溃（trace.ts 同模式）
      ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
    });
}

// ── kg-bootstrap 批新增五命令（iter-20260829-ys7q T3.2；契约 contracts/kg-bootstrap-api.md） ──

/** kg.bootstrap.create（CL-1 F1.1/F1.2：后端准入机械复核 → createTask 同源，createdBy="page"）。 */
export function handleKgBootstrapCreate(ctx: KgCommandContext): void {
  if (ctx.bootstrap === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const scope = optionalString(ctx, "scope");
  if (scope === null) return;
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.bootstrap
    .create(project, scope)
    .then((result) => {
      if (!result.ok) return bootstrapError(ctx, result.error);
      const frame: KgBootstrapCreateResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "kg",
        type: "kg.bootstrap.create.result",
        payload: { ok: true, jobId: result.value.jobId },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err: unknown) => {
      ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
    });
}

/** kg.bootstrap.produce（CL-4 F4.1：产出三级分组读面；absent → 空 groups）。 */
export function handleKgBootstrapProduce(ctx: KgCommandContext): void {
  if (ctx.bootstrap === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const result = ctx.bootstrap.produce(project);
  if (!result.ok) return bootstrapError(ctx, result.error);
  const frame: KgBootstrapProduceResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "kg",
    type: "kg.bootstrap.produce.result",
    payload: { groups: result.value.map(groupViewToDto) },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** kg.node.update（CL-4 F4.2 修正写面一：保存即 updateNode，节点保持 confirmed）。 */
export function handleKgNodeUpdate(ctx: KgCommandContext): void {
  if (ctx.bootstrap === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const nodeId = requireString(ctx, "nodeId");
  if (nodeId === undefined) return;
  const digest = optionalString(ctx, "digest");
  if (digest === null) return;
  const body = optionalString(ctx, "body");
  if (body === null) return;
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.bootstrap
    .update(project, nodeId, { ...(digest !== undefined ? { digest } : {}), ...(body !== undefined ? { body } : {}) })
    .then((result) => {
      if (!result.ok) return bootstrapError(ctx, result.error);
      const frame: KgNodeUpdateResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "kg",
        type: "kg.node.update.result",
        payload: { ok: true, node: nodeViewToDto(result.value.node) },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err: unknown) => {
      ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
    });
}

/** kg.node.supersede（CL-4 F4.2 修正写面二：理由必填双防线 + 留史）。 */
export function handleKgNodeSupersede(ctx: KgCommandContext): void {
  if (ctx.bootstrap === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const nodeId = requireString(ctx, "nodeId");
  if (nodeId === undefined) return;
  const reason = requireString(ctx, "reason");
  if (reason === undefined) return;
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.bootstrap
    .supersede(project, nodeId, reason)
    .then((result) => {
      if (!result.ok) return bootstrapError(ctx, result.error);
      const frame: KgNodeSupersedeResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "kg",
        type: "kg.node.supersede.result",
        payload: { ok: true },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err: unknown) => {
      ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
    });
}

/** kg.bootstrap.impact（CL-4 F4.3：edges 引用方只读推导；零写零广播）。 */
export function handleKgBootstrapImpact(ctx: KgCommandContext): void {
  if (ctx.bootstrap === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const nodeId = requireString(ctx, "nodeId");
  if (nodeId === undefined) return;
  const result = ctx.bootstrap.impact(project, nodeId);
  if (!result.ok) return bootstrapError(ctx, result.error);
  const frame: KgBootstrapImpactResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "kg",
    type: "kg.bootstrap.impact.result",
    payload: {
      affected: result.value.affected.map(refLiteToDto),
      count: result.value.count,
    },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

// ── kg 维护批两命令（C1，契约 PROTOCOL.md §22） ──

/** kg.graph.purge（清空图谱：门禁在 service 机械复核；UI 两步确认不信赖）。 */
export function handleKgGraphPurge(ctx: KgCommandContext): void {
  if (ctx.maintenance === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const result = ctx.maintenance.purge(project);
  if (!result.ok) return maintenanceError(ctx, result.error);
  const frame: KgGraphPurgeResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "kg",
    type: "kg.graph.purge.result",
    payload: {
      purged: true,
      nodesRemoved: result.value.nodesRemoved,
      symbolsRemoved: result.value.symbolsRemoved,
      filesRemoved: result.value.filesRemoved,
    },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** kg.index.delete（删除索引：停 watcher + 删 .codegraph + 状态复位 absent）。 */
export function handleKgIndexDelete(ctx: KgCommandContext): void {
  if (ctx.maintenance === undefined) return unboundOrUnimplemented(ctx);
  const project = requireString(ctx, "project");
  if (project === undefined) return;
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  void ctx.maintenance
    .deleteIndex(project)
    .then((result) => {
      if (!result.ok) return maintenanceError(ctx, result.error);
      const frame: KgIndexDeleteResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "kg",
        type: "kg.index.delete.result",
        payload: {
          deleted: true,
          state: result.value.state,
          watcherStopped: result.value.watcherStopped,
        },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err: unknown) => {
      // 意外异常兜底（service 契约面外）：不吞声不崩溃（kg.index.status 同模式）
      ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message);
    });
}

// ── payload 字段形状校验（枚举/解析语义归 service） ──────────

/** 必填 string 字段：缺失/非 string → KG_E_PARAM（契约：project 缺失/无法解析）。 */
function requireString(ctx: KgCommandContext, key: string): string | undefined {
  const value = ctx.payload[key];
  if (typeof value !== "string") {
    ctx.commandError(ctx.type, "KG_E_PARAM", `payload.${key} 应为 string（必填）`);
    return undefined;
  }
  return value;
}

/** 可选 string 字段：null=形状非法（已回执）；undefined=缺省透传。 */
function optionalString(ctx: KgCommandContext, key: string): string | undefined | null {
  const value = ctx.payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    ctx.commandError(ctx.type, "KG_E_PARAM", `payload.${key} 应为 string`);
    return null;
  }
  return value;
}

// ── 回执辅助 ────────────────────────────────────────────

/** kg 栈未装配门控（trace.ts 先例：回执不崩溃）。 */
function unimplemented(ctx: KgCommandContext): void {
  ctx.commandError(ctx.type, "command.unimplemented", "kg 数据面未装配");
}

/**
 * unbound 防御契约（W1 绑定闭环）：workspace 面已装配但未绑定——参数型
 * kg 命令（需具体 project 作用域，无空集形态）回 workspace.unbound 结构化
 * 错误 + 指引（非 command.unimplemented）；门禁前端本不发这些请求，此为
 * 防御。列表型读面（kg.projects/kg.list）的空集结果在各自 handler 分支。
 */
function unboundOrUnimplemented(ctx: KgCommandContext): void {
  if (ctx.workspaceUnbound) {
    ctx.commandError(ctx.type, "workspace.unbound", "未绑定工作空间：请先 workspace.open 选择工作空间");
    return;
  }
  unimplemented(ctx);
}

/** service 结构化错误 → connection.error 回执（错误码直传；字段路径折叠进文案）。 */
function viewerError(ctx: KgCommandContext, err: KgViewerError): void {
  ctx.commandError(ctx.type, err.code, err.path === undefined ? err.message : `${err.message}（字段 ${err.path}）`);
}

/** bootstrap service 结构化错误 → connection.error 回执（契约词表：not_eligible/not_found/validation_failed/KG_E_PARAM）。 */
function bootstrapError(ctx: KgCommandContext, err: KgBootstrapError): void {
  ctx.commandError(ctx.type, err.code, err.path === undefined ? err.message : `${err.message}（字段 ${err.path}）`);
}

/** 维护面结构化错误 → connection.error 回执（词表：KG_E_PARAM / kg.graph.purge_blocked）。 */
function maintenanceError(ctx: KgCommandContext, err: KgMaintenanceError): void {
  ctx.commandError(ctx.type, err.code, err.path === undefined ? err.message : `${err.message}（字段 ${err.path}）`);
}

// ── 应用层视图 → 协议 DTO（逐字段直拷；readonly → 可变帧形态） ──

/** 项目行 DTO 映射（kg.projects / workspace.open.result 两处共用同一口径）。 */
export function projectRowToDto(row: KgProjectRowView): KgProjectRow {
  return {
    name: row.name,
    path: row.path,
    status: row.status,
    ...(row.symbolCount !== undefined ? { symbolCount: row.symbolCount } : {}),
    ...(row.nodeCount !== undefined ? { nodeCount: row.nodeCount } : {}),
    ...(row.syncedAt !== undefined ? { syncedAt: row.syncedAt } : {}),
    ...(row.degradedNote !== undefined ? { degradedNote: row.degradedNote } : {}),
  };
}

function listRowToDto(row: NodeDigestRow): KgNodeListRow {
  return { id: row.id, name: row.name, kind: row.kind, domain: row.domain, status: row.status, digest: row.digest };
}

function listViewToDto(view: KgListView): KgListResultEvent["payload"] {
  return { total: view.total, matched: view.matched, nodes: view.rows.map(listRowToDto) };
}

/** NodeDigestRow → 人类面引用（AD-16：digest 首行截断，toNodeRef 同口径）。 */
function nodeRefDto(row: NodeDigestRow): KgNodeRefDto {
  const firstLine = row.digest.split("\n")[0] ?? row.digest;
  return { id: row.id, name: row.name, kind: row.kind, digestFirstLine: firstLine.trim() };
}

function detailViewToDto(view: KgNodeDetailView): KgNodeDetailDto {
  return {
    id: view.node.id,
    name: view.node.name,
    kind: view.node.kind,
    domain: view.node.domain,
    status: view.node.status,
    digest: view.node.digest,
    body: view.body,
    anchors: view.anchors.map((a) => ({
      ...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
      path: a.path,
      ...(a.line !== undefined ? { line: a.line } : {}),
      state: a.state,
    })),
    relations: view.relations.map((r) => ({ verb: r.verb, peer: nodeRefDto(r.peer) })),
    supersede: { history: view.supersede.history.map(nodeRefDto), current: nodeRefDto(view.supersede.current) },
    log: view.log.map((l) => ({ date: l.date, iterationId: l.iterationId, eventText: l.eventText })),
  };
}

function reportToDto(report: ChangeReport): KgChangeReportDto {
  return {
    iterationId: report.iterationId,
    entries: report.entries.map((e) => ({
      kind: e.kind,
      sev: e.sev,
      label: e.label,
      body: e.body,
      refs: {
        nodes: e.refs.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind, digestFirstLine: n.digestFirstLine })),
        symbols: e.refs.symbols.map((s) => ({
          name: s.name,
          path: s.path,
          ...(s.line !== undefined ? { line: s.line } : {}),
        })),
      },
    })),
  };
}

function statusViewToDto(view: KgIndexStatusView): KgIndexStatusDto {
  return {
    state: view.state,
    ...(view.syncedAt !== undefined ? { syncedAt: view.syncedAt } : {}),
    ...(view.symbolCount !== undefined ? { symbolCount: view.symbolCount } : {}),
    ...(view.degradedNote !== undefined ? { degradedNote: view.degradedNote } : {}),
  };
}

// ── kg-bootstrap 批新增：产出三级分组 → 协议 DTO（逐字段直拷；AD-16 同规） ──

function nodeViewToDto(view: ProduceNodeView): KgNodeUpdateResultEvent["payload"]["node"] {
  return {
    nodeId: view.nodeId,
    name: view.name,
    kind: view.kind,
    status: view.status,
    digest: view.digest,
    body: view.body,
    anchors: view.anchors.map((a) => ({ symbol: a.symbol, path: a.path, line: a.line })),
    rationale: view.rationale,
    origin: { taskTitle: view.origin.taskTitle, batchScope: view.origin.batchScope },
    ...(view.supersedeReason !== undefined ? { supersedeReason: view.supersedeReason } : {}),
  };
}

function groupViewToDto(view: ProduceGroupView): KgBootstrapProduceResultEvent["payload"]["groups"][number] {
  return {
    jobId: view.jobId,
    title: view.title,
    stages: view.stages.map((s) => ({
      layer: s.layer,
      name: s.name,
      batches: s.batches.map((b) => ({
        batchId: b.batchId,
        scope: b.scope,
        nodes: b.nodes.map(nodeViewToDto),
      })),
    })),
  };
}

/** NodeDigestRow → 受影响引用方人类面投影（AD-16：digest 首行截断）。 */
function refLiteToDto(row: NodeDigestRow): KgBootstrapImpactResultEvent["payload"]["affected"][number] {
  const firstLine = row.digest.split("\n")[0] ?? row.digest;
  return { nodeId: row.id, name: row.name, kind: row.kind, digestFirstLine: firstLine.trim() };
}
