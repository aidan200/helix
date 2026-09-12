import { describe, expect, test } from "bun:test";
import {
  applyWriteModeToAssembly,
  SUBAGENT_READONLY_REMOVED_TOOLS,
} from "../../src/infrastructure/assembly/buildSessionStack";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";

/**
 * U3 readonly 档派生 parity（E-98 reviewer 减法 parity 测试同构）：
 * 派生单点 applyWriteModeToAssembly 的行为断言 + 摘除面与 reviewer 同值
 * 钉死（漂移即红）。worker 生效集断言 readonly 派生 ⊆ worker（无渗入）。
 */

const base = { tools: ["read", "write", "edit", "edit-lines", "bash", "grep"], systemPrompt: "SP" };

describe("U3 applyWriteModeToAssembly", () => {
  test("readonly：减三写工具 + 追加纪律后缀", () => {
    const r = applyWriteModeToAssembly(base, "readonly");
    expect([...r.tools]).toEqual(["read", "bash", "grep"]);
    expect(r.systemPrompt).toContain("SP");
    expect(r.systemPrompt).toContain("readonly");
  });

  test("shared/undefined/isolated：原样返回（同一引用——零派生开销）", () => {
    expect(applyWriteModeToAssembly(base, "shared")).toBe(base);
    expect(applyWriteModeToAssembly(base, undefined)).toBe(base);
    expect(applyWriteModeToAssembly(base, "isolated")).toBe(base); // worktree 物理隔离，工具面不动
  });

  test("减法幂等：已无写工具的集合再减无害（reviewer 场景）", () => {
    const reviewerBase = { tools: ["read", "bash"], systemPrompt: "RSP" };
    const r = applyWriteModeToAssembly(reviewerBase, "readonly");
    expect([...r.tools]).toEqual(["read", "bash"]);
  });

  test("parity：摘除面与 reviewer 同值（write/edit/edit-lines）——漂移即红", () => {
    expect([...SUBAGENT_READONLY_REMOVED_TOOLS]).toEqual([...SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS]);
  });

  test("worker 实集：SubAgentProfile.tools 含三写工具（readonly 派生面非空转）", () => {
    const workerTools = SubAgentProfile.tools as readonly string[];
    for (const t of SUBAGENT_READONLY_REMOVED_TOOLS) {
      expect(workerTools.includes(t)).toBe(true);
    }
  });
});
