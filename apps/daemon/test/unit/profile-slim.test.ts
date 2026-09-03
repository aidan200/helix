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
  "agent_park", // ⑤ 链 C：挂起/恢复（P1 裁决仅 Main——编排工具族主会话专属）
  "agent_resume",
  "browser",
  "kg", // T3.3：kg 双工具（查询面+落账面）
  "kg-update",
  "codegraph", // W1-B（R5/R7）：codegraph 只读查询（status/search/node/callers/callees/impact）
  "task_create", // T2.4（AD-7）：chat 第二创建入口（仅 MainAgent 生效集）
  "task_report", // D3：chat 回流通用报告查询面（仅 MainAgent 生效集）
  "plan_create", // main-session plan 批：主会话同含 plan 三名（两域同构——SubAgent 与 Main 共享）
  "plan_update",
  "plan_read",
] as const;

/** MainAgent 独有名（T2.4，AD-7/AD-2：chat 第二创建入口不进 SubAgent 生效集——批次 SubAgent 不能建任务；D3 task_report 同理——批次/编排面无查询任务报告职责）。 */
const MAIN_ONLY_TOOL_NAMES = ["task_create", "task_report"] as const;

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

  test("② SubAgentProfile 系统提示：工具名词边界零命中（kg/codegraph 两名单项放行；kg-update 零出现，W-R6）", () => {
    for (const name of TOOL_NAMES) {
      // T3.3 例外："kg" 在 T4.2 段库指引中以概念词出现（"kg 约束切片"/"kg
      // 落账输入"/"kg-change-report" 场景名）——非工具清单枚举（清单唯一源
      // 仍是组装器），词边界检查对该名单项放行。
      // W3-G 例外："codegraph" 在「知识纪律」块以行为指引出现（开工链路
      // codegraph→kg affected→kg get——R11 软层 SOP 本体），与 T3-C 委派契约
      // 句引用编排工具名同性质（行为指引非清单枚举）。
      // D8 W-R6："kg-update" 不再放行——收权后 worker 提示词零出现（写通道
      // 改走 closure findings，工具面也注册不到），词边界检查升格为硬断言。
      if (name === "kg" || name === "codegraph") continue;
      expect(
        SUBAGENT_SYSTEM_PROMPT.match(new RegExp(`\\b${name}\\b`)),
        `SubAgent profile 提示仍含工具名 ${name}`,
      ).toBeNull();
    }
  });

  test("③ 静态全集声明不动（resource toolsCatalog 事实源）：main 22 / subagent 13（D8 W-R6 摘 kg-update；⑤ 链 C +agent_park/agent_resume 仅 main；main-session plan 批 Main 同含 plan 三名两域同构；D3 +task_report 仅 main）", () => {
    expect(MainSessionProfile.tools).toEqual([...TOOL_NAMES]);
    expect(SubAgentProfile.tools).toEqual(
      TOOL_NAMES.filter((t) => !t.startsWith("agent_"))
        .filter((t) => !(MAIN_ONLY_TOOL_NAMES as readonly string[]).includes(t))
        .filter((t) => t !== "kg-update"), // D8 W-R6 写面收权
    );
  });

  test("④ base 只留角色+行为引导：「并行委派」行为策略措辞保留（不列工具名）；closure 协议保留", () => {
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("主会话助手");
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("并行委派"); // 行为策略在、工具列举不在
    expect(MAIN_SESSION_SYSTEM_PROMPT).toContain("steer");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("SubAgent worker");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("CLOSURE");
  });
});
