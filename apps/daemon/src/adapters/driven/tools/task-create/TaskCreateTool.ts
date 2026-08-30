import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { CreateTaskInput, TaskEnginePort } from "../../../../application/ports/inbound/TaskEnginePort";
import { TaskError } from "../../../../application/services/task/TaskError";

/**
 * task_create 工具（T2.4，CL-1/F1.3，AD-7）——chat 第二创建入口薄壳。
 *
 * 薄壳职责仅三件事：参数整形 → createTask({ ..., createdBy: "chat" }) →
 * 回执组装。与 /project 入口**同一 createTask API**（双宿主，architecture
 * §4.1）——类型合法性/manifest 校验/阶段计划全部由引擎统一裁决，薄壳不
 * 维护类型清单（不 import Registry 做预过滤，type 错误走引擎
 * task.type_unknown 统一错误面）。
 *
 * 「对话即确认」（AD-7/AD-5）：工具**无** confirm/dryRun 参数、无预检模式
 * ——调用即创建；确认责任在 MainAgent 对话流（工具描述声明「与用户确认
 * 干什么之后再调用」）。免确认类型（manifest confirm=skip）由引擎语义
 * 处理，工具不分叉。
 *
 * 生效集：仅 MainAgent（CoreToolExecutor options.taskCreate 注入 +
 * MainSessionProfile 声明）；SubAgent 子进程（ChildMain 本地栈）不注入
 * ——批次 SubAgent 不能建任务（AD-2 创建按宿主）。
 *
 * 薄壳先例（KgUpdateTool）：createXxxTool(deps) → AgentHarnessTool 字面量
 * + 模块级 as const 参数 schema + 失败 throw 由 executor 转结构化 error。
 */

const taskCreateParameters = {
  type: "object",
  properties: {
    type: { type: "string", description: "任务类型（= 任务 skill 名，如 kg-bootstrap；注册表未收录会被拒绝）" },
    projects: {
      type: "array",
      items: { type: "string" },
      description: "项目标签集（缺省 = 空；基数按任务类型声明校验，如恰 1 个项目）",
    },
    params: {
      type: "object",
      description: "任务参数（按任务类型 paramsSchema 逐字段校验后定格，如 { projectRoot, scope }）",
    },
    confirmedStages: {
      type: "array",
      items: { type: "string" },
      description: "free 策略类型的发起者确认阶段名单（必填项由类型声明决定；fixed 策略忽略）",
    },
  },
  required: ["type", "params"],
  additionalProperties: false,
} as const;

export interface TaskCreateToolDeps {
  /** 引擎创建面（与 /project 入口同一 createTask API，AD-7 双宿主同源）。 */
  readonly engine: Pick<TaskEnginePort, "createTask">;
  /**
   * 回执读面（title/stageNames 人类可读投影；TaskQueryService.getTaskDetail
   * 结构同形——服务端组装，薄壳不拼文案）。
   */
  readonly query: { getTaskDetail(jobId: string): { title: string; stages: readonly { name: string }[] } };
}

/** task_create 工具：注册名 "task_create"。 */
export function createTaskCreateTool(
  deps: TaskCreateToolDeps,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "task_create",
    label: "task_create",
    description:
      "创建任务并启动执行（无交互多 agent 任务，AD-7）。与用户确认干什么之后再调用——" +
      "对话即确认，本工具调用即创建，无二次确认。参数：type 任务类型、params 按类型" +
      "参数表、projects 项目标签（缺省空）、confirmedStages 阶段确认名单（free 策略类型）。" +
      "返回任务回执（jobId/标题/阶段清单）；非法 type 或参数违规会被拒绝且不创建。",
    parameters: taskCreateParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const input = shapeInput(params);
      const { jobId } = await createOrThrow(deps, input);
      const detail = deps.query.getTaskDetail(jobId);
      return text(JSON.stringify({ ok: true, jobId, title: detail.title, stageNames: detail.stages.map((s) => s.name) }));
    },
  };
}

/** 参数整形：工具参数 → CreateTaskInput（createdBy 定死 "chat"——宿主不可伪造）。 */
function shapeInput(params: unknown): CreateTaskInput {
  const args = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  const type = typeof args["type"] === "string" ? args["type"].trim() : "";
  if (type === "") {
    throw new Error("缺少必填参数 type（任务类型 = 任务 skill 名，如 kg-bootstrap）");
  }
  const paramsValue = args["params"];
  if (typeof paramsValue !== "object" || paramsValue === null || Array.isArray(paramsValue)) {
    throw new Error("缺少必填参数 params（任务参数对象，按任务类型参数表给出）");
  }
  const projects = stringArrayOf(args["projects"]) ?? []; // 缺省 = []（brief 契约）
  const confirmedStages = stringArrayOf(args["confirmedStages"]);
  return {
    type,
    projects,
    params: paramsValue as Record<string, unknown>,
    ...(confirmedStages !== undefined ? { confirmedStages } : {}),
    createdBy: "chat",
  };
}

/** 字符串数组叶（undefined → undefined；非数组/空串项 → 整形错误）。 */
function stringArrayOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("参数须为字符串数组");
  }
  const items = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (items.some((item) => item === "")) {
    throw new Error("数组项须为非空字符串");
  }
  return items;
}

/**
 * 引擎调用 + 错误透传：TaskError 转携带 code 的 throw（executor 取 message
 * 转结构化 error——code 必须留在消息里，零吞改），非 TaskError 原样上抛。
 */
async function createOrThrow(deps: TaskCreateToolDeps, input: CreateTaskInput): Promise<{ jobId: string }> {
  try {
    return await deps.engine.createTask(input);
  } catch (error) {
    if (error instanceof TaskError) {
      throw new Error(`${error.code}：${error.message}`);
    }
    throw error;
  }
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}
