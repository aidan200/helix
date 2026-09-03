import { describe, expect, test } from "bun:test";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import {
  SubAgentCodeReviewerProfile,
  SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS,
  SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX,
} from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";
import { dispatchProfileKindOf } from "../../src/application/services/task/TaskOrchestratorService";

/**
 * code-review 任务设计 D5：专用 SubAgent profile「subagent-code-reviewer」
 * （机械解耦，非 SOP 软约束）——评审批次的代码写面（write/edit）机械摘除，
 * 保留 bash（报告/findings 旁路文件 + linter）与只读面（kg/codegraph/plan
 * 三件套）；prompt = 通用 worker 版 + 评审纪律后缀（只读评审/证据纪律/
 * findings kind=issue/报告经 bash 写 HELIX_REPORT_PATH）。
 *
 * 派生模板 = SubAgentKgWriterProfile（增量常量单源 + 派生不复制）。
 */

describe("D5 专用 profile：subagent-code-reviewer 工具面", () => {
  test("kind 声明 + 工具集 = 通用 worker − write/edit（代码写面机械关闭）", () => {
    expect(SubAgentCodeReviewerProfile.kind).toBe("subagent-code-reviewer");
    expect(SubAgentCodeReviewerProfile.tools).not.toContain("write");
    expect(SubAgentCodeReviewerProfile.tools).not.toContain("edit");
    expect(SubAgentCodeReviewerProfile.tools).toEqual(
      SubAgentProfile.tools.filter((t) => t !== "write" && t !== "edit"),
    );
  });

  test("保留面：bash/read/grep + web 三件套 + 只读 kg/codegraph + plan 三件套", () => {
    for (const name of [
      "bash", // 报告/findings 旁路文件 + linter 等评审辅助（逃生舱见 D5 诚实边界）
      "read",
      "grep",
      "web_search",
      "web_fetch",
      "browser",
      "kg", // 只读查询面（无 kg-update）
      "codegraph",
      "plan_create",
      "plan_update",
      "plan_read",
    ]) {
      expect(SubAgentCodeReviewerProfile.tools).toContain(name);
    }
    expect(SubAgentCodeReviewerProfile.tools).not.toContain("kg-update");
  });

  test("single-shot + hooks/model 与通用 worker 同声明（派生面零分叉）", () => {
    expect(SubAgentCodeReviewerProfile.lifecycle).toEqual({ mode: "single-shot" });
    expect(SubAgentCodeReviewerProfile.hooks).toBe(SubAgentProfile.hooks);
    expect(SubAgentCodeReviewerProfile.model).toBeUndefined();
  });
});

describe("D5 评审纪律后缀（增量常量单源）", () => {
  test("base prompt = 通用版完整前缀 + 评审纪律后缀（增量派生不复制）", () => {
    expect(SubAgentCodeReviewerProfile.systemPrompt.startsWith(SubAgentProfile.systemPrompt)).toBe(true);
    expect(SubAgentCodeReviewerProfile.systemPrompt).toContain(SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX);
  });

  test("后缀四要素：只读评审 / 报告经 bash 写 HELIX_REPORT_PATH / findings 经 bash 写 HELIX_FINDINGS_PATH / closure findings kind=issue", () => {
    expect(SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX).toContain("只读");
    expect(SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX).toContain("禁止修改项目代码");
    expect(SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX).toContain("HELIX_REPORT_PATH");
    expect(SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX).toContain("HELIX_FINDINGS_PATH");
    expect(SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX).toContain('"issue"');
  });

  test("摘除常量导出（组装快照派生面单源——buildSessionStack 按此拼 reviewer 生效集）", () => {
    expect(SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS).toEqual(["write", "edit"]);
  });
});

describe("D5 编排分流：任务类型 → 批次实例 profileKind（类型→kind 映射）", () => {
  test("code-review → subagent-code-reviewer", () => {
    expect(dispatchProfileKindOf("code-review")).toBe("subagent-code-reviewer");
  });

  test("图谱产出型（kg-bootstrap / kg-review）→ subagent-kg-writer（映射分支不回归）", () => {
    expect(dispatchProfileKindOf("kg-bootstrap")).toBe("subagent-kg-writer");
    expect(dispatchProfileKindOf("kg-review")).toBe("subagent-kg-writer");
  });

  test("其余任务类型 → subagent-worker（缺省形态不变）", () => {
    expect(dispatchProfileKindOf("fake-task")).toBe("subagent-worker");
    expect(dispatchProfileKindOf("feature-dev")).toBe("subagent-worker");
    expect(dispatchProfileKindOf("")).toBe("subagent-worker");
  });
});
