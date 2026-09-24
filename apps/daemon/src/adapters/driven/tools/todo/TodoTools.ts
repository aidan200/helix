import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { WorkItemData } from "../../../../application/ports/outbound/WorkLedgerPort";
import type { WorkLedgerService } from "../../../../application/services/task/WorkLedgerService";
import type { WorkItemStatus } from "../../../../domain/task/types";

/**
 * todo 工具族（plan 三工具改名批，C+B）：实例待办清单双薄壳——
 *
 * - todo_write({ todos }): 全量替换式写（Claude Code TodoWrite 同构）：
 *   每次传入完整清单（seq 由位置隐含 1..n），替换整表；status ∈
 *   pending/in_progress/done/abandoned，abandoned 必须带 note；
 * - todo_read({}): 读全量清单（收口自查/压缩恢复）。
 *
 * 设计动机（plan-tool-adoption-analysis，2026-09-24）：plan 三工具在 chat 域
 * 中段任务建账率 0-14%，主因是触发判据不在决策现场（skill 二跳）+ 状态机
 * 摩擦（plan_update 失败率 18.7%，92% 为 pending→done 拒绝）。本设计：
 * ①触发判据内嵌工具 description（Anthropic 工具工程实践——描述是最有效
 * 手段，无需读 skill）；②全量替换消灭逐项状态机（无 pending→done 两步
 * 强制，787 次/历史 的失败面归零）；③todo 命名对齐训练语料先验
 * （TodoWrite/todo_write 生态），「台账」一词让位给 kg 候选台账消歧。
 *
 * 数据面不变：work_item 表、状态枚举、isFullyResolved 机械判据、
 * plan-changed 观察链——只改 LLM 可见面。
 *
 * 实例 identity 由装配面注入（子进程 HELIX_INSTANCE_ID 上下文）——工具
 * 参数零 instanceId（防 LLM 伪造他实例清单），实例作用域隔离在读口。
 *
 * 薄壳先例（PlanTools/KgUpdateTool）：createXxxTool(deps) →
 * AgentHarnessTool 字面量 + 模块级 as const schema + 失败 throw 由
 * executor 转 error 结果。
 */

const todoWriteParameters = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description:
        "完整待办清单（全量替换——每次都传全部条目，不能只传增量的部分；位置即序号）",
      items: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "一条工作描述（非空；一项工作一条，按执行顺序排列）",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "done", "abandoned"],
            description:
              "该条状态：pending 未开始 / in_progress 进行中 / done 完成 / abandoned 放弃（必须带 note 说明理由与替代方案）",
          },
          note: {
            type: "string",
            description:
              "记录到该条的关键事实与产物指针（文件路径、知识节点 id、卡点）——供接力恢复与幂等重跑；abandoned 时必填",
          },
        },
        required: ["content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
} as const;

const todoReadParameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export interface TodoToolDeps {
  /** WorkLedgerService 面（结构化注入——测试记录器同形；经 port 落表）。
   * forceResolveInProgress 非工具消费（工具面无收口 op），但 ChildMain
   * closure done 兜底经本对象复用消费（tools.service 同一引用），保留在
   * Pick。 */
  readonly service: Pick<WorkLedgerService, "writeTodos" | "getPlan" | "forceResolveInProgress">;
  /** 本实例 id（子进程上下文注入——工具参数零 instanceId，防伪造）。 */
  readonly instanceId: string;
}

/** todo_write 工具：注册名 "todo_write"（全量替换式待办清单写面）。 */
export function createTodoWriteTool(
  deps: TodoToolDeps,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "todo_write",
    label: "todo_write",
    description:
      "维护本实例的待办清单（对用户可见，是你的执行问责面）。全量替换语义：每次传入完整清单（位置即序号），系统整表替换。\n" +
      "何时必须用（主动用，不要等用户要求）：①开工时预估三步以上、跨文件/跨阶段、或需要中途交代进度的多步工作——先建清单再动手；" +
      "②工作从简单问答升级为多步时，立即补建；③一两步的轻量工作不建。\n" +
      "怎么用：每完成/放弃一项、或计划本身变化时，回传更新后的全量清单（正在做的那条置 in_progress，一次只推进一条）；" +
      "abandoned 必须带 note 说明理由与替代方案；note 记产物指针（文件路径/知识节点 id）与卡点；" +
      "收口或向用户交代前清单应全部 done 或带理由 abandoned——未清账先推进再收口；每完成一项且验证绿即提交一次（commit）。",
    parameters: todoWriteParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const raw = (params as Record<string, unknown>)["todos"];
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error("todos 必须为非空数组（全量替换——一次给出全部条目）");
      }
      const items = raw.map((item, i) => {
        if (typeof item !== "object" || item === null) {
          throw new Error(`todos[${i}] 必须为对象（content + status + 可选 note）`);
        }
        const rec = item as Record<string, unknown>;
        const content = rec["content"];
        if (typeof content !== "string" || content.trim() === "") {
          throw new Error(`todos[${i}].content 必须为非空字符串（一条工作描述）`);
        }
        const status = rec["status"];
        if (
          status !== "pending" &&
          status !== "in_progress" &&
          status !== "done" &&
          status !== "abandoned"
        ) {
          throw new Error('todos[].status 仅接受 pending / in_progress / done / abandoned');
        }
        const note = typeof rec["note"] === "string" ? rec["note"] : undefined;
        if (status === "abandoned" && (note ?? "").trim() === "") {
          throw new Error(`todos[${i}] abandoned 必须携带非空 note（放弃理由/替代方案）`);
        }
        return { content, status: status as WorkItemStatus, note };
      });
      const { written } = await deps.service.writeTodos(deps.instanceId, items);
      // 渲染从已验证入参本地构造（不回调 service.getPlan——包装面读也会广播，
      // 一次写入双帧是噪声；写后回显与落库行同源同形）
      const rows: WorkItemData[] = items.map((item, i) => ({
        instanceId: deps.instanceId,
        seq: i + 1,
        content: item.content,
        status: item.status,
        note: item.note ?? null,
        updatedAt: "",
      }));
      return text(renderTodos(rows, `已写入待办清单 ${written} 项`));
    },
  };
}

/** todo_read 工具：注册名 "todo_read"（只读全量清单）。 */
export function createTodoReadTool(
  deps: TodoToolDeps,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "todo_read",
    label: "todo_read",
    description:
      "读取本实例待办清单全部条目（序号、状态、note）——收口/向用户交代前自查：" +
      "全部条目应为 done 或带理由 abandoned，否则先推进再收口；上下文压缩后恢复现场也用它。",
    parameters: todoReadParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      void params;
      const items = deps.service.getPlan(deps.instanceId);
      if (items.length === 0) {
        return text("待办清单为空（尚未 todo_write——轻量工作可不建清单）");
      }
      return text(renderTodos(items));
    },
  };
}

/** 清单渲染（写/读共用形态）：计数头 + 逐行。 */
function renderTodos(items: readonly WorkItemData[], headPrefix?: string): string {
  const counts = countByStatus(items);
  const head =
    (headPrefix !== undefined ? `${headPrefix}：` : "") +
    `共 ${items.length} 项` +
    `（done ${counts["done"] ?? 0} / abandoned ${counts["abandoned"] ?? 0} / ` +
    `in_progress ${counts["in_progress"] ?? 0} / pending ${counts["pending"] ?? 0}）`;
  const lines = items.map((item) => {
    const note = item.note !== null && item.note.trim() !== "" ? `（note: ${item.note}）` : "";
    return `#${item.seq} [${item.status}] ${item.content}${note}`;
  });
  return [head, ...lines].join("\n");
}

function countByStatus(items: readonly WorkItemData[]): Partial<Record<WorkItemStatus, number>> {
  const counts: Partial<Record<WorkItemStatus, number>> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}
