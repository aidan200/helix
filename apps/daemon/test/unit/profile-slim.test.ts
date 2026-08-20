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
  "agent_spawn",
  "agent_send",
  "agent_status",
] as const;

describe("profile 瘦身：手写工具枚举句删除（M6 T2）", () => {
  test("① MainSessionProfile 系统提示：8 工具名词边界零命中", () => {
    for (const name of TOOL_NAMES) {
      expect(
        MAIN_SESSION_SYSTEM_PROMPT.match(new RegExp(`\\b${name}\\b`)),
        `主 profile 提示仍含工具名 ${name}`,
      ).toBeNull();
    }
  });

  test("② SubAgentProfile 系统提示：8 工具名词边界零命中", () => {
    for (const name of TOOL_NAMES) {
      expect(
        SUBAGENT_SYSTEM_PROMPT.match(new RegExp(`\\b${name}\\b`)),
        `SubAgent profile 提示仍含工具名 ${name}`,
      ).toBeNull();
    }
  });

  test("③ 静态全集声明不动（resource toolsCatalog 事实源）：main 8 / subagent 5", () => {
    expect(MainSessionProfile.tools).toEqual([...TOOL_NAMES]);
    expect(SubAgentProfile.tools).toEqual(["bash", "read", "write", "edit", "grep"]);
  });

  test("④ base 只留角色+行为引导：「并行委派」行为策略措辞保留（不列工具名）；closure 协议保留", () => {
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("主会话助手");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("并行委派"); // 行为策略在、工具列举不在
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("steer");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("SubAgent worker");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("CLOSURE");
  });
});
