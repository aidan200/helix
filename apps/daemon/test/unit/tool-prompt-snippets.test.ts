import { describe, expect, test } from "bun:test";
import { TOOL_PROMPT_SNIPPETS } from "../../src/adapters/driven/tools/ToolPromptSnippets";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";

/**
 * M6 T2：ToolPromptSnippets 注册表（adapters/driven/tools——与工具实现同目录，
 * pi 工具符号封装边界不变）。main 21 工具 + subagent 7 工具（共享 7 + 编排 3
 * + 动态族 11）全覆盖；中文一句话（单行——进 system prompt 的扁平清单行，多行破坏清单格式）。
 */

describe("ToolPromptSnippets 注册表（M6 T2）", () => {
  test("① 两 profile 全集全覆盖：main 21 名 + subagent 7 名均有非空 snippet", () => {
    for (const name of MainSessionProfile.tools) {
      expect(TOOL_PROMPT_SNIPPETS[name], `main 工具 ${name} 缺 snippet`).toBeTruthy();
    }
    for (const name of SubAgentProfile.tools) {
      expect(TOOL_PROMPT_SNIPPETS[name], `subagent 工具 ${name} 缺 snippet`).toBeTruthy();
    }
    // 全集形状锚定（ResourceService toolsCatalog 同源）：main 21 / subagent 7
    expect(MainSessionProfile.tools).toHaveLength(21);
    expect(SubAgentProfile.tools).toHaveLength(7);
  });

  test("② snippet 为中文一句话：非空、单行（无换行符）", () => {
    // 恰 21 条（main 全集；subagent 共享其中 7 条——单一注册表不分 kind）
    expect(Object.keys(TOOL_PROMPT_SNIPPETS).sort()).toEqual(
      [
        "agent_send",
        "agent_spawn",
        "agent_status",
        "bash",
        "browser_back",
        "browser_click",
        "browser_click_at",
        "browser_close",
        "browser_eval",
        "browser_navigate",
        "browser_open",
        "browser_screenshot",
        "browser_scroll",
        "browser_set_files",
        "browser_status",
        "edit",
        "grep",
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
