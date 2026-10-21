/**
 * 管家 feed 播报文本面（体量门 P4：自 StewardService.ts 原样迁出）。
 *
 * feed 两层判据：①层粗筛集合（STEWARD_FEED_EVENT_TYPES 单源——扩集合改此处
 * + 测试同步）+ ②层模板直出（中文文本行，不进 LLM——BroadcastService 先例
 * 同构）。纯函数面：帧组装与订阅闸归播报编排域 StewardOutlet，本模块只管
 * 「事件 → 文本」。门面 StewardService.ts 精确再导出——消费方零改动。
 */
import type {
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentKilledPayload,
  AgentParkedPayload,
  AgentResumedPayload,
  AgentSpawnedPayload,
  DomainEvent,
} from "../../domain/events/DomainEvent";

/** feed ①层粗筛集合单源（agent 生命周期事件流子集；扩集合改此处 + 测试同步）。 */
export const STEWARD_FEED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.spawned",
  "agent.completed",
  "agent.failed",
  "agent.killed",
  "agent.parked",
  "agent.resumed",
]);

/** feed 文本行摘要截断上限（~80 字符——BroadcastService 先例同构）。 */
export const FEED_SUMMARY_MAX_CHARS = 80;


function truncateSummary(summary: string): string {
  if (summary.length <= FEED_SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, FEED_SUMMARY_MAX_CHARS)}…`;
}

/**
 * feed ②层模板直出（纯函数，测试单点）：生命周期六事件 → 中文文本行。
 * 非粗筛集合事件返回 undefined。
 */
export function buildFeedText(event: DomainEvent): string | undefined {
  switch (event.type) {
    case "agent.spawned": {
      const p = event.payload as AgentSpawnedPayload;
      return `${p.agentId} 已启动：${truncateSummary(p.task)}`;
    }
    case "agent.completed": {
      const p = event.payload as AgentCompletedPayload;
      return `${p.agentId} 已完成：${truncateSummary(p.closure.summary ?? "")}`;
    }
    case "agent.failed": {
      const p = event.payload as AgentFailedPayload;
      const reason = p.error !== undefined && p.error !== "" ? p.error : (p.closure.summary ?? "");
      return `${p.agentId} 失败：${truncateSummary(reason)}`;
    }
    case "agent.killed": {
      const p = event.payload as AgentKilledPayload;
      return `${p.agentId} 已终止：${truncateSummary(p.closure.summary ?? "")}`;
    }
    case "agent.parked": {
      const p = event.payload as AgentParkedPayload;
      return `${p.agentId} 已挂起（${p.reason === "user" ? "用户" : "任务暂停"}）`;
    }
    case "agent.resumed": {
      const p = event.payload as AgentResumedPayload;
      return `${p.agentId} 已恢复执行`;
    }
    default:
      return undefined;
  }
}
