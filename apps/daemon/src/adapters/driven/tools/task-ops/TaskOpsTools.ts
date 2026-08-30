import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { TaskEnginePort } from "../../../../application/ports/inbound/TaskEnginePort";
import { TaskError } from "../../../../application/services/task/TaskError";
import type { WorkLedgerService } from "../../../../application/services/task/WorkLedgerService";

/**
 * 任务引擎回口工具族（T2.2，CL-2/F2.2，AD-3③）——编排主 agent 的 task 面
 * 薄壳：划批次落行 / 派发落章 / 阶段推进 / 阶段产物聚合 / 任务收口。
 *
 * 分工边界（决策消解）：
 * - **批次成败收口（completeBatch/failBatch）不在本工具族**——closure 缺失/
 *   失败与台账未全 resolve 两条硬约束由 TaskOrchestratorService 代码机械
 *   判读执行（不进 LLM 面，LLM 不可越过硬约束改判）；
 * - 阶段产物聚合的 nodeIds 由系统按阶段批次反查（kg 元数据
 *   origin_batchId；编排器不手填，防编造）——LLM 只给人类可读 summary；
 * - 完成判定 = LLM 申报（task_complete_job）+ 引擎机械复核全部阶段行。
 *
 * jobId 由装配面绑定（每任务一个编排会话）——工具参数零 jobId（防串任务）。
 * 薄壳先例（TaskCreateTool）：createXxxTool(deps) → AgentHarnessTool 字面量
 * + 模块级 as const schema + 失败 throw 由 executor 转结构化 error。
 */

/** 引擎回口 + 台账读面注入（组合根/测试装配；结构化注入——记录器同形）。 */
export interface TaskOpsToolDeps {
  /** 本编排会话绑定的任务 id（工具参数零 jobId，防串任务）。 */
  readonly jobId: string;
  /** 引擎回口面（批次成败两方法不在内——机械判读归编排服务；命名避让裸 engine）。 */
  readonly taskEngine: Pick<
    TaskEnginePort,
    "insertBatch" | "dispatchBatch" | "advanceStage" | "writeStageArtifact" | "completeJob" | "failJob"
  >;
  /** 阶段产物 nodeIds 反查面（阶段批次 → kg 元数据 origin_batchId 检出；缺省空集）。 */
  readonly stageNodeIds?: (stageSeq: number) => readonly string[];
  /** 批次实例台账读面（编排者 plan_read 变体：按实例 id 参数读）。 */
  readonly ledger?: Pick<WorkLedgerService, "getPlan">;
}

/** TaskError → 携带 code 的 throw（executor 取 message 转结构化 error，code 不吞改）。 */
function engineCall<T>(call: () => Promise<T>): Promise<T> {
  return call().catch((error) => {
    if (error instanceof TaskError) {
      throw new Error(`${error.code}：${error.message}`);
    }
    throw error;
  });
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}

// ── 参数 schema（模块级 as const） ──────────────────────────

const insertBatchParameters = {
  type: "object",
  properties: {
    stageSeq: { type: "number", description: "目标阶段序号（取自起跑信息的冻结阶段行）" },
    scope: { type: "string", description: "批次范围描述（人类可读：对象清单 + 目标层，如「L1 领域层：会话管理域」）" },
  },
  required: ["stageSeq", "scope"],
  additionalProperties: false,
} as const;

const dispatchBatchParameters = {
  type: "object",
  properties: {
    batchId: { type: "string", description: "批次号（插行工具返回的 batchId）" },
    instanceId: { type: "string", description: "执行实例 id（派发工具返回的 agentId）" },
  },
  required: ["batchId", "instanceId"],
  additionalProperties: false,
} as const;

const advanceStageParameters = {
  type: "object",
  properties: {
    stageSeq: { type: "number", description: "要推进到 running 的阶段序号（上一阶段产物落库后推进下一阶段）" },
  },
  required: ["stageSeq"],
  additionalProperties: false,
} as const;

const stageArtifactParameters = {
  type: "object",
  properties: {
    stageSeq: { type: "number", description: "要聚合收口的阶段序号（该阶段批次须已全部收口成功）" },
    summary: {
      type: "string",
      description:
        "阶段摘要（人类可读：本层建了什么、覆盖哪些域/模块、有什么已知缺口；任务页与审阅视图的数据源）",
    },
  },
  required: ["stageSeq", "summary"],
  additionalProperties: false,
} as const;

const completeJobParameters = { type: "object", properties: {}, additionalProperties: false } as const;

const failJobParameters = {
  type: "object",
  properties: {
    error: { type: "string", description: "失败理由（如实呈现给任务页）" },
  },
  required: ["error"],
  additionalProperties: false,
} as const;

const planReadParameters = {
  type: "object",
  properties: {
    instanceId: { type: "string", description: "批次执行实例 id（读该实例的工作台账；不传 = 提示需指定实例）" },
  },
  required: ["instanceId"],
  additionalProperties: false,
} as const;

// ── 工具族装配 ─────────────────────────────────────────────

/**
 * 任务引擎回口工具族（六工具）+ 编排者台账读工具（编排者 plan_read 变体：
 * 按实例 id 参数读批次台账——与 SubAgent 本实例变体同名不同形，装配面
 * 互斥：本族只进编排会话 executor）。
 */
export function createTaskOpsTools(deps: TaskOpsToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined>[] {
  const tools: AgentHarnessTool<ExecutionToolContext, any, undefined>[] = [
    {
      name: "task_insert_batch",
      label: "task_insert_batch",
      description:
        "在指定阶段插入批次行（划批次落库；返回批次号）。批次行落库成功后才可派发——顺序硬约束。" +
        "任务暂停/终态期间会被拒绝（派发闸）。",
      parameters: insertBatchParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { batchId } = await engineCall(() =>
          deps.taskEngine.insertBatch({
            jobId: deps.jobId,
            stageSeq: (params as { stageSeq: number }).stageSeq,
            scope: (params as { scope: string }).scope,
          }),
        );
        // jobId 回显（T4.1）：批次 brief 需把任务元数据（taskId/originBatchId）交给
        // 批次 SubAgent 落账——编排者从回执取 jobId 组入 brief（SKILL ③产出要求段）。
        return text(JSON.stringify({ batchId, jobId: deps.jobId }));
      },
    },
    {
      name: "task_dispatch_batch",
      label: "task_dispatch_batch",
      description:
        "批次派发落章（批次号 + 实例 id；仅 pending/failed 批次可派发——failed→running 为自动重派路径）。" +
        "在插行与派发之后调用，完成派发三步。",
      parameters: dispatchBatchParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { batchId, instanceId } = params as { batchId: string; instanceId: string };
        await engineCall(() => deps.taskEngine.dispatchBatch(batchId, instanceId));
        return text(JSON.stringify({ ok: true, batchId, instanceId }));
      },
    },
    {
      name: "task_advance_stage",
      label: "task_advance_stage",
      description: "推进阶段行到 running（上一阶段产物落库后推进下一阶段；阶段行已冻结不增删）。",
      parameters: advanceStageParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { stageSeq } = params as { stageSeq: number };
        await engineCall(() => deps.taskEngine.advanceStage(deps.jobId, stageSeq));
        return text(JSON.stringify({ ok: true, stageSeq }));
      },
    },
    {
      name: "task_stage_artifact",
      label: "task_stage_artifact",
      description:
        "聚合阶段产物并收口阶段（stage → done）：产出节点 id 集由系统按该阶段批次反查（kg 元数据，" +
        "编排器不手填），你只提供人类可读的阶段摘要。",
      parameters: stageArtifactParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { stageSeq, summary } = params as { stageSeq: number; summary: string };
        const nodeIds = deps.stageNodeIds?.(stageSeq) ?? [];
        await engineCall(() => deps.taskEngine.writeStageArtifact(deps.jobId, stageSeq, { summary, nodeIds }));
        return text(JSON.stringify({ ok: true, stageSeq, nodeCount: nodeIds.length }));
      },
    },
    {
      name: "task_complete_job",
      label: "task_complete_job",
      description:
        "申报任务完成（完成判定按 skill SOP）。系统机械复核全部阶段行 done 后收口——存在未完成阶段会被拒绝并回执原因。",
      parameters: completeJobParameters as any,
      async execute(toolCallId): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        await engineCall(() => deps.taskEngine.completeJob(deps.jobId));
        return text(JSON.stringify({ ok: true, jobId: deps.jobId, status: "done" }));
      },
    },
    {
      name: "task_fail_job",
      label: "task_fail_job",
      description: "申报任务失败（附失败理由，如实呈现；job → failed 终态，不可恢复）。",
      parameters: failJobParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { error } = params as { error: string };
        await engineCall(() => deps.taskEngine.failJob(deps.jobId, error));
        return text(JSON.stringify({ ok: true, jobId: deps.jobId, status: "failed" }));
      },
    },
  ];
  if (deps.ledger !== undefined) {
    tools.push({
      name: "plan_read",
      label: "plan_read",
      description:
        "读批次执行实例的工作台账（序号/状态/note；按实例 id 参数读——编排者视角，判进度与接力恢复用）。" +
        "批次成败硬约束判定（台账须全部 resolve）由系统机械执行，本工具只供你了解现场。",
      parameters: planReadParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { instanceId } = params as { instanceId: string };
        const items = deps.ledger!.getPlan(instanceId);
        if (items.length === 0) {
          return text(`实例 ${instanceId} 无工作台账行（未开工或未使用台账）。`);
        }
        const lines = items.map(
          (item) => `#${item.seq} [${item.status}] ${item.content}${item.note !== null ? `——note：${item.note}` : ""}`,
        );
        return text(lines.join("\n"));
      },
    });
  }
  return tools;
}
