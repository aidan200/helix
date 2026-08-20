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

/**
 * ClosureRecorder —— closure 收口链（T3.3 拆自 SchedulerService，
 * architecture.md §2.4/§4，AD-8 双通道 + O-5 双产物）。
 *
 * 【职责】实例收口（done/failed/killed 三路径统一）的收口链执行：
 *   ① 报告双产物前置段（saveClosureArtifacts）：目录解析 + closure 归一 +
 *      reportPath 文件（markdown 摘要+findings）——经 WriteQueue 单写队列
 *      原子写（TR-AD-6/13），重启后报告完整可读；
 *   ②③④ 尾段（finalizeClosure）：closure_records 记录行（SQLite，任务报告
 *      本体）+ agent_lifecycle 投影落盘（单写通道）+ agent.completed/failed/
 *      killed 领域事件（closure 归一：可选字段显式 null）+ SteerQueue 注入
 *      主线（`agent-N closure: <status> — <summary>`，与用户 steer 同队列
 *      FIFO——MainAgent idle 则立即新 turn / running 则下轮 turn 边界 drain，
 *      AD-8 双通道）。
 *
 * 【两段式拆点】门面在两段之间持有 `closures.set(instanceId, closure)`
 * （观测面留档 Map 归门面）——与拆分前 onInstanceClosure 内联序列逐行
 * 对齐（原 SchedulerService L607 位于 saveReportFile 与 saveClosureRecord
 * 之间），调用次序不得重排（见门面 onInstanceClosure）。
 *
 * 【T2.2 多会话】报告/记录行按实例归属会话路由（reportsDirFor 注入
 * (sessionId) => dir；缺省不产报告文件——closure.reportPath 为 null，
 * T1.1 既有测试口径）。
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
   * 归属会话解析——注入 (sessionId) => dir）。
   */
  readonly reportsDirFor?: (sessionId: string) => string;
  /**
   * closure 注入主线回调（AD-8 双通道之一；组合根接 ChatService.injectClosure）。
   * 可选——无主线编排场景（纯调度 integration）不注入。
   */
  readonly injectClosure?: (agentId: string, message: string) => void;
}

export class ClosureRecorder {
  constructor(private readonly deps: ClosureRecorderDeps) {}

  /**
   * ① 报告双产物前置段：reportsDir 解析 + closure 归一 + reportPath 文件落盘。
   * 返回归一后 closure（门面 closures.set 留档 + 尾段复用）。
   */
  saveClosureArtifacts(instance: AgentInstance, outcome: InstanceClosureOutcome, task: string): InstanceClosurePayload {
    const instanceId = instance.instanceId;
    const reportsDir = this.deps.reportsDirFor?.(instance.sessionId);
    const reportPath =
      reportsDir !== undefined ? join(reportsDir, `${instanceId}.md`) : (outcome.closure.reportPath ?? null);
    const closure = normalizeClosure(outcome.closure, reportPath);
    if (reportsDir !== undefined && reportPath !== null) {
      void this.deps.repository.saveReportFile(reportPath, renderClosureReport(instanceId, task, closure));
    }
    return closure;
  }

  /**
   * ②③④ 收口链尾段：closure_records 记录行 + agent_lifecycle 投影 +
   * 终态领域事件（closure 归一后全字段必发）+ SteerQueue 注入主线。
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

    // SteerQueue 注入主线（唯一入口进主线上下文）：`agent-N closure:
    // <status> — <summary>`——MainAgent idle 立即新 turn / running 下轮
    // turn 边界 drain（与用户 steer 同队列 FIFO，AD-8 双通道）
    this.deps.injectClosure?.(instanceId, `${instanceId} closure: ${closure.status} — ${closure.summary}`);
  }

  private publish<P>(instance: AgentInstance, type: DomainEvent["type"], payload: P): void {
    this.deps.events.publish({
      type,
      sessionId: instance.sessionId, // T2.2 多会话：事件归属 = 实例归属会话
      instanceId: instance.instanceId, // ≡ agentId（契约 §2）：落盘/路由四维用
      payload,
      occurredAt: this.deps.clock.now(),
    });
  }
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
