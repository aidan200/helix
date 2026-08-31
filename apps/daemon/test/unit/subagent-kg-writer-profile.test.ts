import { describe, expect, test } from "bun:test";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import {
  SubAgentKgWriterProfile,
  SUBAGENT_KG_WRITER_EXTRA_TOOLS,
  SUBAGENT_KG_WRITER_PROMPT_SUFFIX,
} from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import { dispatchProfileKindOf } from "../../src/application/services/task/TaskOrchestratorService";

/**
 * D8 W-R6 kg 写面收权（kg-driven-dev-loop 设计 2026-08-30 裁决）：
 * SubAgentProfile（subagent-worker）摘除 kg-update；图谱产出型任务经
 * subagent-kg-writer profile（= 通用 worker + kg-update）豁免；编排层
 * （TaskOrchestratorService）按任务类型分流 profileKind。
 *
 * - W-R6 硬层①：subagent-worker 工具面无 kg-update（只读 kg/codegraph 保留）。
 * - W-R6 硬层②：subagent-kg-writer = 通用 worker 工具集 + kg-update，
 *   base prompt 在通用版上加一句图谱产出型纪律（派生不复制）。
 * - W-R6 编排分流：kg-bootstrap / kg-review → subagent-kg-writer，
 *   其余 → subagent-worker。
 */

describe("W-R6 kg 写面收权：subagent-worker 工具面", () => {
  test("subagent-worker 不含 kg-update（写面收权）；只读 kg / codegraph 保留", () => {
    expect(SubAgentProfile.kind).toBe("subagent-worker");
    expect(SubAgentProfile.tools).not.toContain("kg-update");
    expect(SubAgentProfile.tools).toContain("kg"); // 只读查询面保留
    expect(SubAgentProfile.tools).toContain("codegraph");
    expect(SubAgentProfile.tools).toContain("plan_create"); // plan 三工具不受影响
  });

  test("subagent-worker 提示词不引导调用 kg-update（收权后写通道改走 closure findings）", () => {
    expect(SubAgentProfile.systemPrompt).not.toContain("kg-update");
  });
});

describe("W-R6 豁免面：subagent-kg-writer profile", () => {
  test("kind 声明 + 工具集 = 通用 worker + kg-update（恰好多一项）", () => {
    expect(SubAgentKgWriterProfile.kind).toBe("subagent-kg-writer");
    expect(SubAgentKgWriterProfile.tools).toEqual([...SubAgentProfile.tools, "kg-update"]);
  });

  test("base prompt = 通用版完整前缀 + 图谱产出型一句（增量派生不复制）", () => {
    expect(SubAgentKgWriterProfile.systemPrompt.startsWith(SubAgentProfile.systemPrompt)).toBe(true);
    expect(SubAgentKgWriterProfile.systemPrompt).toContain("本任务为图谱产出型：kg 变更直接经 kg-update 落库");
  });

  test("single-shot + hooks/model 与通用 worker 同声明（派生面零分叉）", () => {
    expect(SubAgentKgWriterProfile.lifecycle).toEqual({ mode: "single-shot" });
    expect(SubAgentKgWriterProfile.hooks).toBe(SubAgentProfile.hooks);
    expect(SubAgentKgWriterProfile.model).toBeUndefined();
  });

  test("增量常量导出（组装快照派生面单源——container 按此拼 kg-writer 生效集）", () => {
    expect(SUBAGENT_KG_WRITER_EXTRA_TOOLS).toEqual(["kg-update"]);
    expect(SUBAGENT_KG_WRITER_PROMPT_SUFFIX).toContain("本任务为图谱产出型");
    expect(SUBAGENT_KG_WRITER_PROMPT_SUFFIX).toContain("kg-update");
  });
});

describe("W-R6 编排分流：任务类型 → 批次实例 profileKind", () => {
  test("图谱产出型（kg-bootstrap / kg-review）→ subagent-kg-writer", () => {
    expect(dispatchProfileKindOf("kg-bootstrap")).toBe("subagent-kg-writer");
    expect(dispatchProfileKindOf("kg-review")).toBe("subagent-kg-writer");
  });

  test("其余任务类型 → subagent-worker（缺省形态不变）", () => {
    expect(dispatchProfileKindOf("fake-task")).toBe("subagent-worker");
    expect(dispatchProfileKindOf("feature-dev")).toBe("subagent-worker");
    expect(dispatchProfileKindOf("")).toBe("subagent-worker");
  });
});
