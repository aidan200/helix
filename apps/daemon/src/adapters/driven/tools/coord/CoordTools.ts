/**
 * coord 工具族（U4）——占用协调的 LLM 声明/查询面（三薄壳）：
 *
 * - coord_claim({ scope, intent })：登记占用——永不拒绝，重叠返回冲突
 *   详情 + 裁决辅助序（系统不裁决：判不了「改没改完」就没有资格拒绝）；
 * - coord_release({ scope? })：释放本会话占用（scope 缺省全部）；
 * - coord_query({ scope? })：占用清单读面（scope 给定 = 该范围的阻塞
 *   冲突面；缺省 = 全部阻塞/ghost 租约概览）。
 *
 * 身份绑定照 PlanTools 先例：ownerSessionId/ownerAgentId 装配面注入
 * （工具参数零身份字段，防 LLM 伪造他会话租约）；仅 MainSessionProfile
 * 声明（执行者 SubAgent 不拿决策工具；orchestrator 子进程经 wire 访问
 * 父进程内存态租约表——留 U6 后批评估）。
 */

import type { AgentHarnessTool, AgentToolResult, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import type { LeaseScope } from "../../../../domain/agent/OccupancyLease";
import { describeScope } from "../../../../domain/agent/OccupancyLease";
import type { CoordinationService } from "../../../../application/services/CoordinationService";

/** 装配面注入的身份 + 服务（工具参数零身份字段——防伪造）。 */
export interface CoordToolDeps {
  readonly service: CoordinationService;
  readonly sessionId: string;
  readonly instanceId: string;
}

/** LLM 友好的 scope 参数（projectRoot / paths 二选一）。 */
interface ScopeParam {
  projectRoot?: string;
  paths?: string[];
}

function toScope(param: ScopeParam): LeaseScope {
  if (param.projectRoot !== undefined && param.projectRoot.trim() !== "") {
    return { kind: "project", projectRoot: param.projectRoot };
  }
  if (param.paths !== undefined && param.paths.length > 0) {
    return { kind: "paths", patterns: param.paths };
  }
  throw new Error("scope 需要给出 projectRoot 或 paths（至少一项）");
}

function describeAge(atMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - atMs);
  const min = Math.floor(delta / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

const claimParameters = {
  type: "object",
  properties: {
    scope: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "项目根绝对路径（目录前缀语义）" },
        paths: { type: "array", items: { type: "string" }, description: "路径/目录前缀清单（任一命中即覆盖）" },
      },
      additionalProperties: false,
      description: "占用范围：projectRoot 或 paths 二选一",
    },
    intent: { type: "string", description: "意图（自然语言——做什么，供冲突方理解）" },
  },
  required: ["scope", "intent"],
  additionalProperties: false,
} as const;

const releaseParameters = {
  type: "object",
  properties: {
    scope: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const queryParameters = {
  type: "object",
  properties: {
    scope: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
      description: "给定 = 只看该范围的阻塞冲突；缺省 = 全部占用概览",
    },
  },
  additionalProperties: false,
} as const;

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}

function conflictAdvisory(): string {
  return "建议：① 转 isolated spawn（agent_spawn writes=isolated，零协商成本）② agent_send 与占用方协商 ③ 缩小 scope。系统不裁决——处置权在占用方与你（含用户）";
}

export function createCoordClaimTool(deps: CoordToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "coord_claim",
    label: "coord_claim",
    description:
      "登记本会话对某范围的写占用（租约）。永不拒绝——与其他会话占用重叠时返回冲突详情与对方意图，由你决策（等待/协商/改走 isolated spawn）。动手改共享工作树内的项目前先 claim。",
    parameters: claimParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const a = params as { scope: ScopeParam; intent: string };
      const scope = toScope(a.scope);
      const result = deps.service.claim({
        ownerSessionId: deps.sessionId,
        ownerAgentId: deps.instanceId,
        scope,
        intent: a.intent,
      });
      const now = Date.now();
      const lines: string[] = [
        `${result.deduplicated ? "已有占用（幂等刷新活跃时刻）" : "已登记占用"}（${result.lease.leaseId}）：${describeScope(scope)} — ${a.intent}`,
      ];
      if (result.conflicts.length > 0) {
        lines.push(`⚠ 与以下占用重叠：`);
        for (const c of result.conflicts) {
          lines.push(
            `  - [${c.status}] ${describeScope(c.scope)} — owner=${c.ownerAgentId}（会话 ${c.ownerSessionId}），intent="${c.intent}"，${describeAge(c.lastActivityAt, now)}有活动`,
          );
        }
        lines.push(conflictAdvisory());
      } else {
        lines.push("当前无其他会话占用重叠范围。");
      }
      return text(lines.join("\n"));
    },
  };
}

export function createCoordReleaseTool(deps: CoordToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "coord_release",
    label: "coord_release",
    description: "释放本会话的占用租约（工作完成或明确让渡时调用；scope 缺省释放本会话全部）。",
    parameters: releaseParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const a = (params ?? {}) as { scope?: ScopeParam };
      const scope = a.scope !== undefined ? toScope(a.scope) : undefined;
      const { released } = deps.service.release({ ownerSessionId: deps.sessionId, scope });
      return text(released > 0 ? `已释放 ${released} 个占用租约。` : "本会话无匹配的占用租约（可能已自动 settled/释放）。");
    },
  };
}

export function createCoordQueryTool(deps: CoordToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "coord_query",
    label: "coord_query",
    description:
      "查询占用协调面：给定 scope = 该范围的阻塞冲突清单（动手前查）；缺省 = 全部占用概览。含 stale（久无活动）与 undeclared（未声明写自动补登）标记。",
    parameters: queryParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const a = (params ?? {}) as { scope?: ScopeParam };
      const now = Date.now();
      if (a.scope !== undefined) {
        const scope = toScope(a.scope);
        const conflicts = deps.service.conflictsFor(scope, deps.sessionId);
        if (conflicts.length === 0) {
          return text(`范围 ${describeScope(scope)} 无其他会话阻塞占用（可安全动手；仍建议 claim 声明意图）。`);
        }
        const lines = [`范围 ${describeScope(scope)} 的阻塞冲突面（${conflicts.length} 个）：`];
        for (const c of conflicts) {
          lines.push(
            `  - [${c.status}/${c.source}] ${describeScope(c.scope)} — owner=${c.ownerAgentId}（会话 ${c.ownerSessionId}），intent="${c.intent}"，${describeAge(c.lastActivityAt, now)}有活动`,
          );
        }
        lines.push(conflictAdvisory());
        return text(lines.join("\n"));
      }
      const all = deps.service.leases();
      if (all.length === 0) return text("当前无任何占用租约。");
      const lines = [`占用概览（${all.length} 个；阻塞判定含 active/stale）：`];
      for (const l of all) {
        const own = l.ownerSessionId === deps.sessionId ? "（本会话）" : "";
        lines.push(
          `  - [${l.status}/${l.source}] ${describeScope(l.scope)}${own} — intent="${l.intent}"，${describeAge(l.lastActivityAt, now)}有活动`,
        );
      }
      return text(lines.join("\n"));
    },
  };
}
