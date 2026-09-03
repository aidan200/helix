import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { StageArtifact } from "../../src/application/ports/outbound/TaskStorePort";
import { createTaskOpsTools, type TaskOpsToolDeps } from "../../src/adapters/driven/tools/task-ops/TaskOpsTools";

/**
 * task 引擎回口工具族参数面（T2.2 薄壳；D2 artifact body additive）：
 * task_stage_artifact 的 body 可选参数透传引擎——携带时 { summary, body }，
 * 未携带时 { summary }（无 body 键，「不动既有值」语义不变）。
 */

interface RecordedArtifact {
  readonly jobId: string;
  readonly stageSeq: number;
  readonly artifact: StageArtifact;
}

function rig(): { deps: TaskOpsToolDeps; artifacts: RecordedArtifact[] } {
  const artifacts: RecordedArtifact[] = [];
  const deps: TaskOpsToolDeps = {
    jobId: "job-1",
    taskEngine: {
      insertBatch: async () => ({ batchId: "batch-1" }),
      dispatchBatch: async () => {},
      advanceStage: async () => {},
      writeStageArtifact: async (jobId: string, stageSeq: number, artifact: StageArtifact) => {
        artifacts.push({ jobId, stageSeq, artifact });
      },
      completeJob: async () => {},
      failJob: async () => {},
    },
  };
  return { deps, artifacts };
}

function stageArtifactTool(deps: TaskOpsToolDeps) {
  const tool = createTaskOpsTools(deps).find((t) => t.name === "task_stage_artifact");
  if (tool === undefined) throw new Error("task_stage_artifact 未注册");
  return tool;
}

describe("task_stage_artifact 工具（D2：body additive）", () => {
  test("参数 schema：body 可选（在 properties、不在 required，additionalProperties 不拒）", () => {
    const { deps } = rig();
    const params = stageArtifactTool(deps).parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties).toHaveProperty("body");
    expect(params.required).toEqual(["stageSeq", "summary"]);
  });

  test("携带 body → 引擎收到 { summary, body } 原样透传", async () => {
    const { deps, artifacts } = rig();
    await stageArtifactTool(deps).execute("call-1", {
      stageSeq: 1,
      summary: "审 3 模块：阻断 1 / 高 2",
      body: "## 发现\n\n- [阻断] x.ts:1 空指针\n- [高] y.ts:2 竞态",
    }, undefined, undefined, { env: new NodeExecutionEnv({ cwd: tmpdir() }) });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({
      jobId: "job-1",
      stageSeq: 1,
      artifact: { summary: "审 3 模块：阻断 1 / 高 2", body: "## 发现\n\n- [阻断] x.ts:1 空指针\n- [高] y.ts:2 竞态" },
    });
  });

  test("未携带 body → 引擎收到 { summary }（无 body 键，语义不变）", async () => {
    const { deps, artifacts } = rig();
    await stageArtifactTool(deps).execute(
      "call-1",
      { stageSeq: 2, summary: "仅摘要" },
      undefined,
      undefined,
      { env: new NodeExecutionEnv({ cwd: tmpdir() }) },
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.artifact).toEqual({ summary: "仅摘要" });
    expect(artifacts[0]!.artifact).not.toHaveProperty("body");
  });
});
