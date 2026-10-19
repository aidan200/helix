/**
 * 评审 F2 #16/#17：编排工具面「描述契约」一致性（LLM 读的就是这些文本）。
 *
 * - #17 agent_spawn：参数 description 曾写「超过 10 分钟…600000 起步」，与工具
 *   description「仅超长任务（超过 30 分钟）…1800000 起步」直接矛盾——同一契约
 *   两个门槛，LLM 无所适从。
 * - #16 task_dispatch_batch：描述仍是旧「派发落章/完成派发三步」定位，与
 *   CAND-781 后的「批次补接线（spawn 自动接线，同实例幂等）」语义脱节。
 *
 * 断言面是工具暴露给 LLM 的真实文本（构造工具实例后取 description），不抄源码。
 */
import { describe, expect, test } from "bun:test";

import { createAgentSpawnTool } from "../../src/adapters/driven/tools/agent/AgentOrchestrationTools";
import { createTaskOpsTools } from "../../src/adapters/driven/tools/task-ops/TaskOpsTools";

type ParamSchema = {
  properties: Record<string, { description?: string }>;
};

describe("编排工具描述契约（评审 F2 #16/#17）", () => {
  test("agent_spawn：reportIntervalMs 参数描述与工具描述同门槛（30 分钟 / 1800000）", () => {
    const tool = createAgentSpawnTool({} as never);
    const paramDesc = (tool.parameters as ParamSchema).properties["reportIntervalMs"]?.description ?? "";
    expect(tool.description).toContain("30 分钟");
    expect(paramDesc).toContain("30 分钟");
    expect(paramDesc).toContain("1800000");
    expect(paramDesc).not.toContain("10 分钟");
    expect(paramDesc).not.toContain("600000");
  });

  test("task_dispatch_batch：描述为「补接线」定位且声明同实例幂等（不再是旧派发三步）", () => {
    const tools = createTaskOpsTools({ jobId: "job-1", taskEngine: {} as never });
    const dispatch = tools.find((t) => t.name === "task_dispatch_batch");
    expect(dispatch).toBeDefined();
    expect(dispatch!.description).toContain("补接线");
    expect(dispatch!.description).toContain("幂等");
    expect(dispatch!.description).toContain("pending/failed");
    expect(dispatch!.description).not.toContain("完成派发三步");
  });
});
