import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { AgentOrchestrationPort } from "../../../../application/ports/inbound/AgentOrchestrationPort";

/**
 * 编排三工具：agent_spawn / agent_send / agent_status。
 *
 * 落位 adapters/driven/tools/agent/（TR-AD-1/2 说明：driven 工具域）。
 * 三个工具都是「薄转投」——业务判定全部经 AgentOrchestrationPort 回
 * SchedulerService（TR-AD-9 编排收敛），本文件不含调度逻辑；port 引用由
 * 组合根注入（CoreToolExecutor 注册时传入），不 import 任何其他 adapter。
 *
 * - agent_spawn：秒回 {agentId, spawned, queued?}（不等收口，AD-8）；
 * - 队列满 → isError 错误字符串回 LLM（reject 通路汇流）；
 * - agent_send：port.send → runner → transport → 子进程 stdin → Agent.steer()；
 * - agent_status：无参全量（状态/位次/摘要）/有参单实例。
 */

/** 三工具共用的参数 schema 风格（手写 JSON Schema，与 GrepTool 同构）。 */
const spawnParameters = {
  type: "object",
  properties: {
    task: { type: "string", description: "指派给 SubAgent 的任务描述（一句话可执行）" },
    profileKind: { type: "string", description: "实例 profile（缺省 subagent-worker）" },
    reportIntervalMs: {
      type: "number",
      description:
        "周期进展报告间隔毫秒（可选，缺省 0 = 不报告）。任务预估执行超过 10 分钟再设置，" +
        "建议 600000 起步；由你按任务规模自估。设置后系统按间隔把一行机械进展" +
        "（Δ工具调用/Δ输出字符/Δ轮次/静默时长）注入主线。",
    },
  },
  required: ["task"],
  additionalProperties: false,
} as const;

const sendParameters = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "目标实例 id（agent-N）" },
    message: { type: "string", description: "注入消息（运行中实例的补充指示）" },
  },
  required: ["agentId", "message"],
  additionalProperties: false,
} as const;

const statusParameters = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "单实例查询 id（缺省=全量）" },
  },
  additionalProperties: false,
} as const;

const inspectParameters = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "目标实例 id（agent-N）" },
  },
  required: ["agentId"],
  additionalProperties: false,
} as const;

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

/** agent_spawn：秒回（不挂起 turn——closure 经 SteerQueue 注入回主线，AD-8）。 */
export function createAgentSpawnTool(
  orchestration: AgentOrchestrationPort,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "agent_spawn",
    label: "agent_spawn",
    description:
      "指派一个 SubAgent 实例独立执行任务并立即返回（{agentId, spawned}，不等完成）。" +
      "任务完成后其 closure 结论会以 \"agent-N closure: …\" 注入主线驱动下一轮；" +
      "长任务（预估执行超过 10 分钟）设 reportIntervalMs 开启周期进展报告（建议 600000 起步，自估），" +
      "报告连续零增量时用 agent_inspect 核实执行轨迹；agent_status 仅在用户主动询问进度时使用。" +
      "调度预算耗尽时返回错误说明。",
    parameters: spawnParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { task, profileKind, reportIntervalMs } = params as {
        task: string;
        profileKind?: string;
        reportIntervalMs?: number;
      };
      const outcome = orchestration.spawn(task, profileKind, reportIntervalMs);
      if (outcome.status === "rejected") {
        // 队列满报错回 LLM（reject 通路汇流）：以异常表达失败（pi 工具
        // 惯例），CoreToolExecutor 转结构化 error 结果，文案即调度器中文说明
        throw new Error(outcome.error);
      }
      return textResult(
        outcome.status === "queued"
          ? JSON.stringify({ agentId: outcome.agentId, spawned: true, queued: true, position: outcome.position })
          : JSON.stringify({ agentId: outcome.agentId, spawned: true, queued: false }),
      );
    },
  };
}

/** agent_send：向运行中实例注入消息（turn 边界生效，AD-7⑤）。 */
export function createAgentSendTool(
  orchestration: AgentOrchestrationPort,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "agent_send",
    label: "agent_send",
    description:
      "向运行中的 SubAgent 实例注入一条消息（补充指示/追问）。消息进入该实例的" +
      "steer 队列，在其当前生成轮结束后的 turn 边界生效。排队中/已终态实例不可注入。",
    parameters: sendParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { agentId, message } = params as { agentId: string; message: string };
      return textResult(JSON.stringify(orchestration.send(agentId, message)));
    },
  };
}

/** agent_status：实例状态查询（无参全量 / 有参单实例）。 */
export function createAgentStatusTool(
  orchestration: AgentOrchestrationPort,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "agent_status",
    label: "agent_status",
    description:
      "查询 SubAgent 实例状态：无参返回全部实例（agentId/状态/FIFO 位次/任务/终态摘要），" +
      "带 agentId 返回单实例。实例不存在时返回空数组。仅在用户主动询问进度时使用——" +
      "收口结论与周期进展报告会自动注入，不要轮询本工具等待结果。",
    parameters: statusParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { agentId } = params as { agentId?: string };
      return textResult(JSON.stringify(orchestration.status(agentId)));
    },
  };
}

/** agent_inspect：实例执行核实（T3-B——进展报告连续零增量时核实是否死循环）。 */
export function createAgentInspectTool(
  orchestration: AgentOrchestrationPort,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "agent_inspect",
    label: "agent_inspect",
    description:
      "核实 SubAgent 实例的真实执行轨迹：返回状态/静默时长/累计工具调用数/最近 20 条轨迹" +
      "（工具名、assistant 文本尾部）。用于周期进展报告连续零增量时判断实例是否死循环；" +
      "确无进展可终止该实例（kill）后重派。实例不存在时返回 null。",
    parameters: inspectParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { agentId } = params as { agentId: string };
      return textResult(JSON.stringify(orchestration.inspect(agentId)));
    },
  };
}
