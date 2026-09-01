import { join } from "node:path";
import type { AgentInstance } from "../../../domain/agent/AgentInstance";
import type {
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentKilledPayload,
  DomainEvent,
  InstanceClosurePayload,
} from "../../../domain/events/DomainEvent";
import type { EventPublisherPort } from "../../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../ports/outbound/ClockPort";
import type { SessionRepositoryPort } from "../../ports/outbound/SessionRepositoryPort";
import type { InstanceClosureOutcome } from "../InstanceRunner";
import type { KnowledgeWriteOp, WriteResult } from "../../../domain/kg/types";

/**
 * ClosureRecorder —— closure 收口链（拆自 SchedulerService，
 * architecture.md §2.4/§4/§6，AD-8 双通道 + O-5 双产物 + F3.0 三层修复）。
 *
 * 【职责】实例收口（done/failed/killed 三路径统一）的收口链执行：
 *   ① 报告双产物前置段（saveClosureArtifacts）：reportPath 解析 + closure 归一
 *      ——F3.0② SubAgent 自报 reportPath **原值透传**（daemon 只透传路径不
 *      重渲染，报告由 SubAgent 按任务完成报告模板写，AF-4 覆盖行为已移除）；
 *      无自报时兜底落盘最小摘要文件（renderClosureReport 保留为兜底路径）
 *      ——经 WriteQueue 单写队列原子写（TR-AD-6/13），重启后报告完整可读；
 *   ②③④ 尾段（finalizeClosure）：closure_records 记录行（SQLite，任务报告
 *      本体）+ agent_lifecycle 投影落盘（单写通道）+ agent.completed/failed/
 *      killed 领域事件（closure 归一：可选字段显式 null）+ SteerQueue 注入
 *      主线（F3.0① 一行通知 + reportPath 指针行——summary 足够决策要不要
 *      深入，深入才 read，报告全文不进主线，dense payload 教训 F-4）+
 *      F3.0③ findings→kg 落账管道（sediment 条目映射写 op，经注入的
 *      findingsSink＝KgWriteService 同形接口，绝不旁路；落账失败不阻塞
 *      closure 主流程，可重试语义由 change_log 幂等保证）。
 *
 * 【两段式拆点】门面在两段之间持有 `closures.set(instanceId, closure)`
 * （观测面留档 Map 归门面）——与拆分前 onInstanceClosure 内联序列逐行
 * 对齐，调用次序不得重排（见门面 onInstanceClosure）。
 *
 * 【多会话】报告/记录行按实例归属会话路由（reportsDirFor 注入
 * (sessionId) => dir；缺省不产报告文件——closure.reportPath 为 null，
 * 既有测试口径）。
 */
export interface ClosureRecorderDeps {
  /** 持久化（closure 记录行/报告文件/agent_lifecycle 投影，经 WriteQueue 单写通道）。 */
  readonly repository: SessionRepositoryPort;
  /** 事件流发布（终态领域事件 agent.completed/failed/killed）。 */
  readonly events: EventPublisherPort;
  /** 时间源（终态事件 occurredAt）。 */
  readonly clock: ClockPort;
  /**
   * 任务报告目录（O-5：<home>/reports/<session>；多会话：报告目录按实例
   * 归属会话解析——注入 (sessionId) => dir）。F3.0② 后仅作**无自报时的
   * 兜底落盘点**（自报 reportPath 恒优先透传）。
   */
  readonly reportsDirFor?: (sessionId: string) => string;
  /**
   * closure 注入主线回调（AD-8 双通道之一；组合根接 ChatService.injectClosure）。
   * 可选——无主线编排场景（纯调度 integration）不注入。
   * source（T11a）：closure=收口注入（缺省）；progress=周期进展报告。
   */
  readonly injectClosure?: (agentId: string, message: string, source?: "closure" | "progress") => void;
  /**
   * findings 落账管道（F3.0③，AD-17/AD-14）：closure findings 非空时映射
   * kg 写 op 落账。组合根接 kg 栈（write = KgWriteService 唯一写入口同形
   * 接口，绝不旁路；scanProjects = workspace 项目扫描，目标项目解析用）。
   * 缺省不落账（纯调度测试形态）。与 T3.3 kg-update 即时通道非竞争
   * （O-2：共用同一 API 入口）。
   */
  readonly findingsSink?: ClosureFindingsSink;
  /** 可观测 warn（findings 落账跳过/被拒/异常——不阻塞主流程；缺省静默）。 */
  readonly logger?: { warn: (message: string) => void };
  /**
   * pending_sync 的 job 归属解析（W2-D R13：闭环记录点 upsert 的 job_id 列）。
   * 组合根接线：task:* 会话 → jobId，chat 会话 → null。缺省恒 null（纯调度
   * 测试形态——job_id 可空列，不阻塞记录）。
   */
  readonly pendingSyncJobIdOf?: (sessionId: string) => string | null;
}

/** findings 落账接口（KgWriteService.write + workspace 项目扫描的最小消费面）。 */
export interface ClosureFindingsSink {
  /** kg 唯一写入口同形接口（schema 校验前置——非法 op 结构化拒绝）。 */
  readonly write: (projectRoot: string, op: KnowledgeWriteOp) => WriteResult;
  /** workspace 项目扫描（显式 project 名解析 + 唯一项目自动；多项目不猜）。 */
  readonly scanProjects: () => readonly string[];
  /**
   * 目标库最近迭代锚（iterationId 库内回落，与 kg-update 工具 resolveIterationId
   * 同语义）。可选——测试形态可缺省（缺省 = 无回落，iterationId 缺省落 null）。
   */
  readonly latestIteration?: (projectRoot: string) => string | null;
}

export class ClosureRecorder {
  constructor(private readonly deps: ClosureRecorderDeps) {}

  /**
   * ① 报告双产物前置段：reportPath 解析 + closure 归一。
   * F3.0②：SubAgent 自报 reportPath 优先**原值透传**（daemon 零重渲染）；
   * 无自报时兜底 = reportsDir 解析 + 最小摘要文件落盘（现状保留为兜底）。
   * 返回归一后 closure（门面 closures.set 留档 + 尾段复用）。
   */
  saveClosureArtifacts(instance: AgentInstance, outcome: InstanceClosureOutcome, task: string): InstanceClosurePayload {
    // 自报 reportPath：透传不越位（报告是 SubAgent 写的正文，daemon 只传路径）
    if (outcome.closure.reportPath !== undefined && outcome.closure.reportPath !== null) {
      return normalizeClosure(outcome.closure, outcome.closure.reportPath);
    }
    // 兜底路径（无自报）：O-5 落点 + 最小摘要文件（renderClosureReport）
    const instanceId = instance.instanceId;
    const reportsDir = this.deps.reportsDirFor?.(instance.sessionId);
    const reportPath = reportsDir !== undefined ? join(reportsDir, `${instanceId}.md`) : null;
    const closure = normalizeClosure(outcome.closure, reportPath);
    if (reportsDir !== undefined && reportPath !== null) {
      void this.deps.repository.saveReportFile(reportPath, renderClosureReport(instanceId, task, closure));
    }
    return closure;
  }

  /**
   * ②③④ 收口链尾段：closure_records 记录行 + agent_lifecycle 投影 +
   * 终态领域事件（closure 归一后全字段必发）+ SteerQueue 注入主线 +
   * findings→kg 落账（F3.0③，失败不阻塞）。
   */
  finalizeClosure(instance: AgentInstance, outcome: InstanceClosureOutcome, closure: InstanceClosurePayload): void {
    const instanceId = instance.instanceId;
    void this.deps.repository.saveClosureRecord(instance.sessionId, instanceId, outcome.result, closure);

    // agent_lifecycle 投影行落盘（单写通道；失败不崩——WriteQueue onError 上报）
    void this.deps.repository.saveAgentLifecycle(instance.sessionId, instanceId, instance.current);

    if (outcome.result === "failed") {
      this.publish(instance, "agent.failed", {
        agentId: instanceId,
        error: outcome.error ?? closure.summary,
        closure,
      } satisfies AgentFailedPayload);
    } else if (outcome.result === "killed") {
      this.publish(instance, "agent.killed", { agentId: instanceId, closure } satisfies AgentKilledPayload);
    } else {
      this.publish(instance, "agent.completed", { agentId: instanceId, closure } satisfies AgentCompletedPayload);
    }

    // SteerQueue 注入主线（唯一入口进主线上下文，AD-8 双通道）：F3.0①
    // 一行通知 + reportPath 指针行——`agent-N closure: <status> — <summary>`
    // + `详情: <reportPath> — 需要细节时 read`（全文不进主线）。MainAgent
    // idle 立即新 turn / running 下轮 turn 边界 drain（与用户 steer 同队列
    // FIFO）。reportPath 缺失（无自报且无兜底目录）时保持单行。
    const notifyLine = `${instanceId} closure: ${closure.status} — ${closure.summary}`;
    this.deps.injectClosure?.(
      instanceId,
      closure.reportPath !== null ? `${notifyLine}\n详情: ${closure.reportPath} — 需要细节时 read` : notifyLine,
      "closure",
    );

    // F3.0③ findings→kg 落账（断头处接通管道；失败不阻塞收口）
    this.recordFindings(instanceId, closure);

    // W2-D R13 闭环记录点：机械查 tool_calls 有 write 类成功调用才 upsert
    // pending_sync（不无脑记录）；job 终态扫描提示归编排侧（不进引擎，AD-10）
    this.recordPendingSync(instance);
  }

  /**
   * pending_sync 闭环记录点（W2-D R13/R22）：本 session 有 write 类工具成功
   * 调用（v1 口径仅 edit/write+completed，bash 不算）→ upsert 台账行
   *（changed_at=now、notified 复位 0——新变更需重新提示）；无则不记。
   * 三终态统一记录（failed/killed 也可能已产生实际变更）。
   */
  private recordPendingSync(instance: AgentInstance): void {
    if (!this.deps.repository.hasSuccessfulWriteToolCall(instance.sessionId)) return;
    const jobId = this.deps.pendingSyncJobIdOf?.(instance.sessionId) ?? null;
    void this.deps.repository.savePendingSync(instance.sessionId, jobId, this.deps.clock.now());
  }

  /** findings 落账管道：sediment 条目映射写 op → sink（跳过/被拒/异常均 warn 不抛）。 */
  private recordFindings(instanceId: string, closure: InstanceClosurePayload): void {
    const sink = this.deps.findingsSink;
    if (sink === undefined) return; // 未装配（纯调度测试形态）：断头面保持静默
    const findings = closure.findings ?? [];
    if (findings.length === 0) return; // 显式「无」（空数组/null）：不落账不报错
    for (const item of mapFindingsToOps(findings, closure.taskId ?? undefined)) {
      if (!item.ok) {
        this.warnFindings(instanceId, `跳过（${item.reason}）`);
        continue;
      }
      const projectRoot = resolveFindingProject(sink, item.project);
      if (projectRoot === undefined) {
        this.warnFindings(instanceId, "跳过（目标项目无法解析：project 名未命中或 workspace 多项目未显式指明——写操作不猜）");
        continue;
      }
      // 迭代锚回落：finding 缺 iterationId 时回落目标库最近迭代锚（与 kg-update
      // 工具 resolveIterationId 同语义——无锚 null 不报错，溯源主锚切 source_task_id）
      const op =
        item.needsIterationFallback === true
          ? (() => {
              const iter = sink.latestIteration?.(projectRoot) ?? null;
              return { ...item.op, iterationId: iter, ...(iter !== null ? { sourceIterationId: iter } : {}) };
            })()
          : item.op;
      try {
        const result = sink.write(projectRoot, op);
        if (!result.ok) {
          this.warnFindings(instanceId, `落账被拒（${result.error.code}：${result.error.message}）`);
        }
      } catch (err) {
        // 落账失败不阻塞 closure 主流程（注入与落库照常；可重试语义由 change_log 幂等保证）
        this.warnFindings(instanceId, `落账异常（${(err as Error).message}）`);
      }
    }
  }

  private warnFindings(instanceId: string, detail: string): void {
    this.deps.logger?.warn(`[closure] findings 落账（实例 ${instanceId}）${detail}`);
  }

  private publish<P>(instance: AgentInstance, type: DomainEvent["type"], payload: P): void {
    this.deps.events.publish({
      type,
      sessionId: instance.sessionId, // 多会话：事件归属 = 实例归属会话
      instanceId: instance.instanceId, // ≡ agentId（契约 §2）：落盘/路由四维用
      payload,
      occurredAt: this.deps.clock.now(),
    });
  }
}

// ── findings → kg 写 op 映射（纯函数） ─────────────────────

/** 单条 finding 映射结果：ok=可落账 op（含可选 project 名）；否则跳过原因（warn 可观测）。 */
export type FindingOp =
  | { readonly ok: true; readonly op: KnowledgeWriteOp; readonly project?: string; readonly needsIterationFallback?: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * findings 数组 → kg 写 op 序列（F3.0③ 管道的映射面，纯函数）。
 *
 * 条目消费口径（与 SubAgent 报告模板 findings 段对齐，T4.2 段库）——
 * **W1-C 改道（D0/R2）：sediment 条目不再直接建点/推翻，改写 candidates
 * 表 pending 行**（proposeCandidate；落库后人审 decideCandidate 裁决——
 * 候选写入权 MainAgent 单点，SubAgent 只能经本管道上报）：
 * - 仅 kind="sediment" 条目落账（deviation/issue/boundary 等无落账语义——
 *   全条目无 sediment 语义 = 显式「无」，零落账零报错）；
 * - changeType=新增 → title=name（必填；digest 等进 body）；
 * - changeType=修改/废弃 → title=`${changeType}：${targetNode}`（targetNode
 *   必填；reason 进 body——裁决与落地归人审，不在闭环现场直改节点）；
 * - sourceIterationId=条目 iterationId（必填，缺了跳过）；sourceTaskId=
 *   closure.taskId 机械注入（AD-10 三路径同源；非任务上下文 = 不携带）；
 * - 缺必填/形态非法 → 跳过（原因入 warn，不阻塞其余条目）。
 */
export function mapFindingsToOps(findings: readonly unknown[], sourceTaskId?: string): readonly FindingOp[] {
  return findings.map((entry) => findingOpOf(entry, sourceTaskId));
}

function findingOpOf(entry: unknown, sourceTaskId: string | undefined): FindingOp {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return skip("条目非对象");
  }
  const record = entry as Record<string, unknown>;
  if (record["kind"] !== "sediment") {
    return skip(`kind=${String(record["kind"])} 无落账语义（仅 sediment 落账）`);
  }
  // iterationId 缺省不再 skip——由 recordFindings 回落目标库最近迭代锚（与
  // kg-update 工具 resolveIterationId 同语义：显式携带优先，缺省回落 latestIteration，
  // 无锚 null 不报错；溯源主锚切 source_task_id）。
  const iterationId = str(record["iterationId"]);
  const needsIterationFallback = iterationId === undefined;
  const iterFields =
    iterationId !== undefined
      ? { iterationId, sourceIterationId: iterationId }
      : { iterationId: null as string | null }; // 缺省先落 null，回落时 recordFindings 重填
  const project = str(record["project"]);
  const changeType = record["changeType"];
  const injected = sourceTaskId !== undefined ? { sourceTaskId } : {};
  if (changeType === "新增") {
    const name = str(record["name"]);
    if (name === undefined) return skip("新增缺 name（候选标题）");
    return {
      ok: true,
      op: {
        kind: "proposeCandidate",
        ...iterFields,
        candidateKind: "sediment",
        title: name,
        body: candidateBody(record),
        ...injected,
      },
      ...(needsIterationFallback ? { needsIterationFallback: true } : {}),
      ...(project !== undefined ? { project } : {}),
    };
  }
  if (changeType === "修改" || changeType === "废弃") {
    const targetNode = str(record["targetNode"]);
    if (targetNode === undefined) return skip(`${changeType}缺 targetNode（候选标题定位目标节点）`);
    return {
      ok: true,
      op: {
        kind: "proposeCandidate",
        ...iterFields,
        candidateKind: "sediment",
        title: `${changeType}：${targetNode}`,
        body: candidateBody(record),
        ...injected,
      },
      ...(needsIterationFallback ? { needsIterationFallback: true } : {}),
      ...(project !== undefined ? { project } : {}),
    };
  }
  return skip(`changeType=${String(changeType)} 未知（合法：新增/修改/废弃）`);
}

/** 候选正文：finding 携带的结构化字段逐行平铺（人审阅读面；缺省字段不出现）。 */
function candidateBody(record: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const key of [
    "changeType",
    "targetNode",
    "digest",
    "reason",
    "scope",
    "evidence",
    "implementedCode",
    "implementationStatus",
    "sourceDecision",
    "body",
  ] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

/** 目标项目解析：显式 project 名命中扫描集；缺省唯一项目自动；多项目不猜。 */
function resolveFindingProject(
  sink: ClosureFindingsSink,
  project: string | undefined,
): string | undefined {
  const scanned = sink.scanProjects();
  if (project !== undefined) {
    return scanned.find((root) => projectName(root) === project);
  }
  return scanned.length === 1 ? scanned[0] : undefined;
}

function projectName(projectRoot: string): string {
  const parts = projectRoot.split("/");
  return parts[parts.length - 1] || projectRoot;
}

function skip(reason: string): FindingOp {
  return { ok: false, reason };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** closure 归一：可选字段缺失 → 显式 null（全字段必发纪律，test-design §4.3）；reportPath 为 O-5 报告文件落点。 */
function normalizeClosure(c: InstanceClosurePayload, reportPath: string | null): InstanceClosurePayload {
  return {
    status: c.status,
    summary: c.summary,
    reportPath,
    findings: c.findings ?? null,
    taskId: c.taskId ?? null,
  };
}

/**
 * O-5 报告文件渲染（markdown 摘要 + findings；<home>/reports/<session>/<agentId>.md）。
 * 纯函数——闭包字段直出，findings 以 JSON 行呈现（结构化本体在 SQLite 行）。
 * F3.0② 后仅作**无自报 reportPath 时的兜底**（SubAgent 按模板写的报告才是
 * 报告本体，daemon 不再对自报报告重渲染）。
 */
function renderClosureReport(agentId: string, task: string, closure: InstanceClosurePayload): string {
  const findings = closure.findings ?? null;
  const lines = [
    `# SubAgent 任务报告：${agentId}`,
    "",
    `- 收口：${closure.status}`,
    `- 摘要：${closure.summary}`,
    `- 任务：${task || "（未记录）"}`,
    `- 关联任务号：${closure.taskId ?? "无"}`,
    "",
    "## Findings",
    "",
  ];
  if (findings === null || findings.length === 0) {
    lines.push(findings === null ? "（无 findings）" : "（空）");
  } else {
    for (const f of findings) lines.push(`- ${JSON.stringify(f)}`);
  }
  lines.push("");
  return lines.join("\n");
}
