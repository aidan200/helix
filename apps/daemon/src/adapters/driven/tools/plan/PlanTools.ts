import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { WorkItemData } from "../../../../application/ports/outbound/WorkLedgerPort";
import type { WorkLedgerService } from "../../../../application/services/task/WorkLedgerService";
import type { WorkItemStatus } from "../../../../domain/task/types";

/**
 * plan 工具族（T1.4，CL-2 F2.5，AD-6①）——实例工作台账三薄壳：
 *
 * - plan_create({ items })：一次建全部条目（seq 1..n，待开始）；同实例
 *   仅一次（重建被拒绝）；
 * - plan_update({ seq, status, note? })：逐项推进（in_progress/done/
 *   abandoned——abandoned 必须带非空 note 说明理由）+ 记 note（关键事实、
 *   产物指针、卡点）；
 * - plan_read({})：读本实例台账全行（收口前自查全部完成或带理由放弃）。
 *
 * 实例 identity 由装配面注入（子进程 HELIX_INSTANCE_ID 上下文）——工具
 * 参数零 instanceId（防 LLM 伪造他实例台账），实例作用域隔离在读口。
 * 工具面零派发方语义词（SubAgent 不感知谁派发，AD-6①）。
 *
 * 薄壳先例（KgUpdateTool）：createXxxTool(deps) → AgentHarnessTool 字面量 +
 * 模块级 as const schema + 失败 throw 由 executor 转 error 结果。
 */

const planCreateParameters = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "string" },
      description: "计划条目清单（按执行顺序，每条一项工作；一次给出全部，创建后不可重建）",
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

const planUpdateParameters = {
  type: "object",
  properties: {
    seq: { type: "number", description: "条目序号（取自 plan_read 返回行的 #序号）" },
    status: {
      type: "string",
      enum: ["in_progress", "done", "abandoned"],
      description: "目标状态：in_progress 开始执行 / done 完成 / abandoned 放弃（必须给 note 说明理由）",
    },
    note: {
      type: "string",
      description: "记录到该条目的关键事实与产物指针（文件路径、知识节点 id、卡点等）；abandoned 时必填",
    },
  },
  required: ["seq", "status"],
  additionalProperties: false,
} as const;

const planReadParameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export interface PlanToolDeps {
  /** WorkLedgerService 面（结构化注入——测试记录器同形；经 port 落表）。 */
  readonly service: Pick<WorkLedgerService, "createPlan" | "updateItem" | "getPlan" | "forceResolveInProgress">;
  /** 本实例 id（子进程上下文注入——工具参数零 instanceId，防伪造）。 */
  readonly instanceId: string;
}

/** plan_create 工具：注册名 "plan_create"。 */
export function createPlanCreateTool(
  deps: PlanToolDeps,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "plan_create",
    label: "plan_create",
    description:
      "创建本实例的工作台账：开工前一次给出全部计划条目（按执行顺序），创建后不可重建。" +
      "逐项推进用 plan_update，查看用 plan_read。条目应覆盖从开工到收口的全部关键步骤。",
    parameters: planCreateParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const raw = (params as Record<string, unknown>)["items"];
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error("items 必须为非空字符串数组（一次给出全部计划条目）");
      }
      const items = raw.map((item, i) => {
        if (typeof item !== "string" || item.trim() === "") {
          throw new Error(`items[${i}] 必须为非空字符串（每条一项工作描述）`);
        }
        return item;
      });
      const { created, rebuilt } = await deps.service.createPlan(deps.instanceId, items);
      return text(
        rebuilt
          ? `旧台账已全部办结——已重建工作台账 ${created} 项（#1~#${created}，全部待开始 pending）`
          : `已创建工作台账 ${created} 项（#1~#${created}，全部待开始 pending）`,
      );
    },
  };
}

/** plan_update 工具：注册名 "plan_update"。 */
export function createPlanUpdateTool(
  deps: PlanToolDeps,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "plan_update",
    label: "plan_update",
    description:
      "更新本实例工作台账条目：开始执行置 in_progress、完成置 done、放弃置 abandoned（必须带 note " +
      "说明理由与替代方案）；可同时记录 note（关键事实、产物指针、卡点）。状态只能沿 " +
      "in_progress → done/abandoned 推进，序号取自 plan_read 返回行。",
    parameters: planUpdateParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const args = params as Record<string, unknown>;
      const seq = args["seq"];
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
        throw new Error("seq 必须为正整数序号（取自 plan_read 返回行的 #序号）");
      }
      const status = args["status"];
      if (status !== "in_progress" && status !== "done" && status !== "abandoned") {
        throw new Error('status 仅接受 in_progress / done / abandoned');
      }
      const note = typeof args["note"] === "string" ? args["note"] : undefined;
      await deps.service.updateItem(deps.instanceId, seq, status as WorkItemStatus, note);
      const noteSuffix = note !== undefined ? "（note 已记录）" : "";
      return text(`#${seq} → ${status}${noteSuffix}`);
    },
  };
}

/** plan_read 工具：注册名 "plan_read"。 */
export function createPlanReadTool(
  deps: PlanToolDeps,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "plan_read",
    label: "plan_read",
    description:
      "读取本实例工作台账全部条目（序号、状态、note）——收口前自查：全部条目应为 done 或" +
      "带理由 abandoned，否则先推进再收口。",
    parameters: planReadParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      void params;
      const items = deps.service.getPlan(deps.instanceId);
      if (items.length === 0) {
        return text("工作台账为空（尚未 plan_create——轻量工作可不建台账）");
      }
      const counts = countByStatus(items);
      const head =
        `共 ${items.length} 项` +
        `（done ${counts["done"] ?? 0} / abandoned ${counts["abandoned"] ?? 0} / ` +
        `in_progress ${counts["in_progress"] ?? 0} / pending ${counts["pending"] ?? 0}）`;
      const lines = items.map((item) => {
        const note = item.note !== null && item.note.trim() !== "" ? `（note: ${item.note}）` : "";
        return `#${item.seq} [${item.status}] ${item.content}${note}`;
      });
      return text([head, ...lines].join("\n"));
    },
  };
}

function countByStatus(items: readonly WorkItemData[]): Partial<Record<WorkItemStatus, number>> {
  const counts: Partial<Record<WorkItemStatus, number>> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}
