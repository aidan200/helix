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
  KgChangeReportDto,
  KgChangeReportResultEvent,
  KgIndexStatusDto,
  KgIndexStatusResultEvent,
  KgListResultEvent,
  KgNodeConfirmResultEvent,
  KgNodeDetailDto,
  KgNodeDetailResultEvent,
  KgNodeListRow,
  KgNodeRefDto,
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
  KgConfirmView,
  KgIndexStatusView,
  KgListView,
  KgNodeDetailView,
  KgViewerError,
  KgViewerService,
} from "../../../../application/services/kg/KgViewerService";
import type { NodeDigestRow } from "../../../../domain/kg/types";
import type { KgCommandContext } from "./context";

/** kg.projects（F5.0：宽松口径一层扫描；只读零写）。 */
export function handleKgProjects(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) return unimplemented(ctx);
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

/** kg.list（F5.1：q×kind×status 三路过滤叠加 + total/matched）。 */
export function handleKgList(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) return unimplemented(ctx);
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

/** kg.node.detail（F5.2：六段聚合——描述/规则/锚/关系/supersede 链/变更日志）。 */
export function handleKgNodeDetail(ctx: KgCommandContext): void {
  if (ctx.kg === undefined) return unimplemented(ctx);
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
  if (ctx.kg === undefined) return unimplemented(ctx);
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
  if (ctx.kg === undefined) return unimplemented(ctx);
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
  if (ctx.kg === undefined) return unimplemented(ctx);
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

/** service 结构化错误 → connection.error 回执（错误码直传；字段路径折叠进文案）。 */
function viewerError(ctx: KgCommandContext, err: KgViewerError): void {
  ctx.commandError(ctx.type, err.code, err.path === undefined ? err.message : `${err.message}（字段 ${err.path}）`);
}

// ── 应用层视图 → 协议 DTO（逐字段直拷；readonly → 可变帧形态） ──

function projectRowToDto(row: KgProjectRowView): KgProjectRow {
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
    desc: view.desc,
    rules: [...view.rules],
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
      options: [...e.options],
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
