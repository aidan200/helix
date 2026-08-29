import { describe, expect, test } from "bun:test";
import { TOOL_PROMPT_SNIPPETS } from "../../src/adapters/driven/tools/ToolPromptSnippets";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";

/**
 * M6 T2：ToolPromptSnippets 注册表（adapters/driven/tools——与工具实现同目录，
 * pi 工具符号封装边界不变）。main 12 工具 + subagent 8 工具（共享 7 + browser
 * （H-3 转发接入）+ 编排 4 仅 main，T3-B +agent_inspect）全覆盖；中文一句话（单行——进 system prompt 的扁平清单行，多行破坏清单格式）。
 */

describe("ToolPromptSnippets 注册表（M6 T2）", () => {
  test("① 两 profile 全集全覆盖：main 14 名 + subagent 13 名均有非空 snippet", () => {
    for (const name of MainSessionProfile.tools) {
      expect(TOOL_PROMPT_SNIPPETS[name], `main 工具 ${name} 缺 snippet`).toBeTruthy();
    }
    for (const name of SubAgentProfile.tools) {
      expect(TOOL_PROMPT_SNIPPETS[name], `subagent 工具 ${name} 缺 snippet`).toBeTruthy();
    }
    // 全集形状锚定（ResourceService toolsCatalog 同源）：main 14 / subagent 13
    //（T3-B +agent_inspect；T3.3 +kg/kg-update 双工具；T1.4 +plan 三工具 AD-6①）
    expect(MainSessionProfile.tools).toHaveLength(14);
    expect(SubAgentProfile.tools).toHaveLength(13);
  });

  test("② snippet 为中文一句话：非空、单行（无换行符）", () => {
    // 恰 17 条（main 全集 14 + plan 三工具——subagent 独有，单一注册表不分 kind）
    expect(Object.keys(TOOL_PROMPT_SNIPPETS).sort()).toEqual(
      [
        "agent_inspect",
        "agent_send",
        "agent_spawn",
        "agent_status",
        "bash",
        "browser",
        "edit",
        "grep",
        "kg",
        "kg-update",
        "plan_create",
        "plan_read",
        "plan_update",
        "read",
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
});
