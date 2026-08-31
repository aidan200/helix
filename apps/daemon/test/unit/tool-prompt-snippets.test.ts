import { describe, expect, test } from "bun:test";
import { TOOL_PROMPT_SNIPPETS } from "../../src/adapters/driven/tools/ToolPromptSnippets";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SubAgentKgWriterProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";

/**
 * M6 T2：ToolPromptSnippets 注册表（adapters/driven/tools——与工具实现同目录，
 * pi 工具符号封装边界不变）。main 12 工具 + subagent 8 工具（共享 7 + browser
 * （H-3 转发接入）+ 编排 4 仅 main，T3-B +agent_inspect）全覆盖；中文一句话（单行——进 system prompt 的扁平清单行，多行破坏清单格式）。
 */

describe("ToolPromptSnippets 注册表（M6 T2）", () => {
  test("① 三 profile 全集全覆盖：main 16 名 + subagent 13 名 + kg-writer 14 名均有非空 snippet", () => {
    for (const name of MainSessionProfile.tools) {
      expect(TOOL_PROMPT_SNIPPETS[name], `main 工具 ${name} 缺 snippet`).toBeTruthy();
    }
    for (const name of SubAgentProfile.tools) {
      expect(TOOL_PROMPT_SNIPPETS[name], `subagent 工具 ${name} 缺 snippet`).toBeTruthy();
    }
    for (const name of SubAgentKgWriterProfile.tools) {
      expect(TOOL_PROMPT_SNIPPETS[name], `kg-writer 工具 ${name} 缺 snippet`).toBeTruthy();
    }
    // 全集形状锚定（ResourceService toolsCatalog 同源）：main 16 / subagent 13
    //（T3-B +agent_inspect；T3.3 +kg；T1.4 +plan 三工具 AD-6①；
    // T2.4 +task_create 仅 main，AD-7；W1-B +codegraph R5；D8 W-R6 -kg-update
    // 收权）；kg-writer = subagent + kg-update（14，豁免面）
    expect(MainSessionProfile.tools).toHaveLength(16);
    expect(SubAgentProfile.tools).toHaveLength(13);
    expect(SubAgentKgWriterProfile.tools).toHaveLength(14);
  });

  test("② snippet 为中文一句话：非空、单行（无换行符）", () => {
    // 恰 25 条（main 全集 16 + plan 三工具 + 编排 task 回口六工具——T2.2；
    // 单一注册表不分 kind；W1-B +codegraph）
    expect(Object.keys(TOOL_PROMPT_SNIPPETS).sort()).toEqual(
      [
        "agent_inspect",
        "agent_send",
        "agent_spawn",
        "agent_status",
        "bash",
        "browser",
        "codegraph",
        "edit",
        "grep",
        "kg",
        "kg-update",
        "plan_create",
        "plan_read",
        "plan_update",
        "read",
        "task_advance_stage",
        "task_complete_job",
        "task_create",
        "task_dispatch_batch",
        "task_fail_job",
        "task_insert_batch",
        "task_stage_artifact",
        "web_fetch",
        "web_search",
        "write",
      ].sort(),
    );
    for (const [name, snippet] of Object.entries(TOOL_PROMPT_SNIPPETS)) {
      expect(snippet.length, `${name} snippet 非空`).toBeGreaterThan(0);
      expect(snippet, `${name} snippet 单行`).not.toMatch(/[\r\n]/);
      expect(/[\u4e00-\u9fff]/.test(snippet), `${name} snippet 应含中文`).toBe(true);
    }
  });

  test("③ kg-update snippet 词表同步：updateNode op 入列（D8 遗留①——服务层写面早有，工具描述句补齐）", () => {
    expect(TOOL_PROMPT_SNIPPETS["kg-update"]).toContain("updateNode");
  });
});
