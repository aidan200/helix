/**
 * 智能体页页面模型单测（M6 T4；AG-15 页面私有 reducer，trace-model 先例）。
 *
 * 机械判据：
 * ① 读面状态机：idle → list-started → loading → list-result → ready；
 *    首拉失败 → error + 重试链（error → list-started → loading）；
 * ② list-result：双块按 profileKind 归位合并（单 kind 响应只覆写该块），
 *    pending 全清（新鲜数据 supersede 全部在途写）、error 清空；
 * ③ 有数据时的静默重拉：list-started 不降级回 loading（防闪烁，保 ready）；
 * ④ 写面在途：toggle-started 登记 key（kind:resourceType:name；model 槽位
 *    空名键 kind:model:）单飞；toggle-settled（skipped 回执）清在途；
 * ⑤ 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import { describe, expect, it } from "vitest";
import type { AgentConfigProfileBlock } from "@helix/protocol";
import {
  createAgentPageState,
  pendingKeyOf,
  selectAgentPageView,
  agentPageReducer,
  type AgentPageState,
} from "./agent-config-model";

const MAIN_BLOCK: AgentConfigProfileBlock = {
  profileKind: "main-session",
  tools: [
    { name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" },
    { name: "grep", enabled: true, snippet: "跨文件正则检索并列出匹配行" },
  ],
  skills: [
    {
      name: "hello-skill",
      description: "问候技能",
      filePath: "/home/dev/.helix/skills/hello-skill/SKILL.md",
      source: "user",
      enabled: true,
    },
  ],
  diagnostics: [
    { code: "invalid_metadata", message: "SKILL.md 缺少 description", path: "/ws/broken/SKILL.md", source: "project" },
  ],
  model: null,
};

const SUB_BLOCK: AgentConfigProfileBlock = {
  profileKind: "subagent-worker",
  tools: [{ name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" }],
  skills: [],
  diagnostics: [],
  model: null,
};

function withMain(state: AgentPageState, block: AgentConfigProfileBlock = MAIN_BLOCK): AgentPageState {
  return agentPageReducer(state, { type: "list-result", profiles: [block] });
}

describe("智能体页页面模型（M6 T4）", () => {
  it("① 读面状态机：idle → loading → ready；首拉失败 → error → 重试 → loading", () => {
    let s = createAgentPageState();
    expect(selectAgentPageView(s)).toBe("idle");
    s = agentPageReducer(s, { type: "list-started" });
    expect(selectAgentPageView(s)).toBe("loading");
    s = agentPageReducer(s, { type: "list-failed", reason: "未连接" });
    expect(selectAgentPageView(s)).toBe("error");
    expect(s.error).toBe("未连接");
    s = agentPageReducer(s, { type: "list-started" });
    expect(selectAgentPageView(s)).toBe("loading");
    s = agentPageReducer(s, { type: "list-result", profiles: [MAIN_BLOCK, SUB_BLOCK] });
    expect(selectAgentPageView(s)).toBe("ready");
    expect(s.error).toBeNull();
  });

  it("② list-result：双块按 kind 归位；单 kind 响应只覆写该块；pending 全清", () => {
    let s = createAgentPageState();
    s = agentPageReducer(s, { type: "list-started" });
    s = agentPageReducer(s, { type: "list-result", profiles: [MAIN_BLOCK, SUB_BLOCK] });
    expect(s.profiles["main-session"]).toEqual(MAIN_BLOCK);
    expect(s.profiles["subagent-worker"]).toEqual(SUB_BLOCK);
    // 单 kind 重拉：只覆写 subagent-worker，main 块原引用保持
    const newSub: AgentConfigProfileBlock = { ...SUB_BLOCK, model: "anthropic/claude-sonnet-4-5" };
    s = agentPageReducer(s, { type: "list-result", profiles: [newSub] });
    expect(s.profiles["main-session"]).toBe(MAIN_BLOCK);
    expect(s.profiles["subagent-worker"]!.model).toBe("anthropic/claude-sonnet-4-5");
    // pending 全清：在途写行被新鲜读面收口
    s = agentPageReducer(s, { type: "toggle-started", kind: "main-session", resourceType: "tool", name: "grep" });
    expect(s.pending.size).toBe(1);
    s = agentPageReducer(s, { type: "list-result", profiles: [MAIN_BLOCK] });
    expect(s.pending.size).toBe(0);
  });

  it("③ 有数据时静默重拉：list-started 不降级回 loading（防闪烁）", () => {
    let s = withMain(createAgentPageState());
    expect(selectAgentPageView(s)).toBe("ready");
    s = agentPageReducer(s, { type: "list-started" });
    expect(selectAgentPageView(s)).toBe("ready"); // 有数据：不闪骨架
    expect(s.profiles["main-session"]).toBe(MAIN_BLOCK); // 数据保留
    const empty = createAgentPageState();
    const fresh = agentPageReducer(empty, { type: "list-started" });
    expect(selectAgentPageView(fresh)).toBe("loading"); // 无数据：照常 loading
  });

  it("④ 写面在途：toggle-started/toggle-settled 登记/清 key（model 槽位空名键）", () => {
    let s = createAgentPageState();
    const key = pendingKeyOf("main-session", "tool", "grep");
    expect(key).toBe("main-session:tool:grep");
    s = agentPageReducer(s, { type: "toggle-started", kind: "main-session", resourceType: "tool", name: "grep" });
    expect(s.pending.has(key)).toBe(true);
    s = agentPageReducer(s, { type: "toggle-settled", kind: "main-session", resourceType: "tool", name: "grep" });
    expect(s.pending.has(key)).toBe(false);
    // model 槽位：set/clear 共用空名键（单槽单飞）
    s = agentPageReducer(s, { type: "toggle-started", kind: "subagent-worker", resourceType: "model", name: "anthropic/claude-sonnet-4-5" });
    expect(s.pending.has("subagent-worker:model:")).toBe(true);
    s = agentPageReducer(s, { type: "toggle-started", kind: "subagent-worker", resourceType: "model", name: "" });
    expect(s.pending.size).toBe(1); // 同键覆盖，不叠加
    s = agentPageReducer(s, { type: "toggle-settled", kind: "subagent-worker", resourceType: "model", name: "" });
    expect(s.pending.size).toBe(0);
  });
});
