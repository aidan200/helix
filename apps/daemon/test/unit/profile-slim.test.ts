import { describe, expect, test } from "bun:test";
import {
  MAIN_SESSION_SYSTEM_PROMPT,
  MainSessionProfile,
} from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import {
  SUBAGENT_SYSTEM_PROMPT,
  SubAgentProfile,
} from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";

/**
 * M6 T2 profile 瘦身消双源（验收：两 profile 源码 grep 工具名清单零命中——
 * 组装产物才有清单）。工具名按词边界匹配（提示为中文，词边界命中 = 工具名
 * 实际出现；防子串误伤如 "已写入"）。
 *
 * 双源问题（M6 §二 事实 8）：MainSessionProfile systemPrompt 手写工具清单
 * （漏 grep、编排三件套挤「并行委派」段）与 tools 数组两份事实源漂移——
 * 瘦身后 base 只留角色+行为引导，清单唯一来源 = SystemPromptAssembler。
 */

const TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "web_search",
  "web_fetch",
  "agent_spawn",
  "agent_send",
  "agent_status",
  "agent_inspect", // T3-B：编排四工具
  "browser",
  "kg", // T3.3：kg 双工具（查询面+落账面）
  "kg-update",
] as const;

/** SubAgent 独有名（T1.4，AD-6①：plan 三工具全量配给 SubAgent、不进 MainAgent——提示词零命中检查覆盖同款）。 */
const SUBAGENT_ONLY_TOOL_NAMES = ["plan_create", "plan_update", "plan_read"] as const;

/** 静态工具名（T3-C 后提示词仍零命中——委派契约句引用的编排工具名是行为指引非清单枚举）。 */
const STATIC_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "web_search",
  "web_fetch",
  "browser",
] as const;

describe("profile 瘦身：手写工具枚举句删除（M6 T2）", () => {
  test("① MainSessionProfile 系统提示：静态工具名词边界零命中（编排工具名仅存于 T3-C 委派契约句）", () => {
    for (const name of STATIC_TOOL_NAMES) {
      expect(
        MAIN_SESSION_SYSTEM_PROMPT.match(new RegExp(`\\b${name}\\b`)),
        `主 profile 提示仍含静态工具名 ${name}`,
      ).toBeNull();
    }
  });

  test("② SubAgentProfile 系统提示：17 工具名词边界零命中", () => {
    for (const name of [...TOOL_NAMES, ...SUBAGENT_ONLY_TOOL_NAMES]) {
      // T3.3 例外："kg" 在 T4.2 段库指引中以概念词出现（"kg 约束切片"/"kg
      // 落账输入"/"kg-change-report" 场景名）——非工具清单枚举（清单唯一源
      // 仍是组装器），词边界检查对该名单项放行
      if (name === "kg") continue;
      expect(
        SUBAGENT_SYSTEM_PROMPT.match(new RegExp(`\\b${name}\\b`)),
        `SubAgent profile 提示仍含工具名 ${name}`,
      ).toBeNull();
    }
  });

  test("③ 静态全集声明不动（resource toolsCatalog 事实源）：main 14 / subagent 13（T3-B +agent_inspect；T3.3 +kg 双工具；T1.4 +plan 三工具 AD-6①）", () => {
    expect(MainSessionProfile.tools).toEqual([...TOOL_NAMES]);
    expect(SubAgentProfile.tools).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "web_search",
      "web_fetch",
      "browser",
      "kg",
      "kg-update",
      "plan_create",
      "plan_update",
      "plan_read",
    ]);
  });

  test("④ base 只留角色+行为引导：「并行委派」行为策略措辞保留（不列工具名）；closure 协议保留", () => {
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("主会话助手");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("并行委派"); // 行为策略在、工具列举不在
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("steer");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("SubAgent worker");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("CLOSURE");
  });
});
