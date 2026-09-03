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
import type { AgentConfigProfileBlock, AgentConfigSystemBlock } from "@helix/protocol";
import {
  AGENT_KINDS,
  SYSTEM_AGENT_KINDS,
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
  thinkingLevel: null, // v0.11 批内补登编译跟随（T1.3；UI 消费面归 T2.2）
};

const SUB_BLOCK: AgentConfigProfileBlock = {
  profileKind: "subagent-worker",
  tools: [{ name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" }],
  skills: [],
  diagnostics: [],
  model: null,
  thinkingLevel: null, // v0.11 批内补登编译跟随（T1.3；UI 消费面归 T2.2）
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

// ── agent-roster 批：只读系统派生块 + 选中态（master-detail） ──

const ORCH_BLOCK: AgentConfigSystemBlock = {
  profileKind: "orchestrator",
  tools: [{ name: "agent_spawn", snippet: "指派 SubAgent 实例独立执行任务" }],
};
const KGW_BLOCK: AgentConfigSystemBlock = {
  profileKind: "subagent-kg-writer",
  tools: [
    { name: "bash", snippet: "在沙箱工作目录执行 shell 命令并返回输出" },
    { name: "kg-update", snippet: "知识图谱即时落账" },
  ],
  derivedFrom: "subagent-worker",
  pinnedTools: ["kg-update"],
};

describe("智能体页页面模型（agent-roster：system 块 + 选中态）", () => {
  it("⑤ system 块按 kind 归位；未携带（旧 daemon / 单 kind 响应）不覆盖既有值；常量序固定", () => {
    expect(AGENT_KINDS).toEqual(["main-session", "subagent-worker"]);
    expect(SYSTEM_AGENT_KINDS).toEqual(["orchestrator", "subagent-kg-writer", "subagent-code-reviewer"]);
    let s = createAgentPageState();
    expect(s.system["orchestrator"]).toBeNull();
    expect(s.system["subagent-kg-writer"]).toBeNull();
    expect(s.selected).toBe("main-session"); // 默认选中 main-session（brief ④；重挂复位同源）
    s = agentPageReducer(s, { type: "list-result", profiles: [MAIN_BLOCK, SUB_BLOCK], system: [ORCH_BLOCK, KGW_BLOCK] });
    expect(s.system["orchestrator"]).toBe(ORCH_BLOCK);
    expect(s.system["subagent-kg-writer"]).toBe(KGW_BLOCK);
    // system 未携带：既有块保持（additive 容忍——不闪空）
    s = agentPageReducer(s, { type: "list-result", profiles: [MAIN_BLOCK, SUB_BLOCK] });
    expect(s.system["orchestrator"]).toBe(ORCH_BLOCK);
  });

  it("⑥ select-agent：选中可切换（可编辑/只读两类 id 均可）；重拉不清选中", () => {
    let s = createAgentPageState();
    s = agentPageReducer(s, { type: "list-result", profiles: [MAIN_BLOCK, SUB_BLOCK], system: [ORCH_BLOCK, KGW_BLOCK] });
    s = agentPageReducer(s, { type: "select-agent", id: "subagent-kg-writer" });
    expect(s.selected).toBe("subagent-kg-writer");
    // 重拉（worker toggle → changed → 重拉）选中保持
    const next = agentPageReducer(s, { type: "list-result", profiles: [MAIN_BLOCK, SUB_BLOCK], system: [ORCH_BLOCK, KGW_BLOCK] });
    expect(next.selected).toBe("subagent-kg-writer");
    s = agentPageReducer(s, { type: "select-agent", id: "main-session" });
    expect(s.selected).toBe("main-session");
    s = agentPageReducer(s, { type: "select-agent", id: null });
    expect(s.selected).toBeNull();
  });
});

describe("base prompt 批：base 段系统提示词缓存与折叠态", () => {
  it("⑦ started → 在途 + 展开；result 定向归位缓存清在途；toggle 恰一展开/同卡收起；重拉不清缓存", () => {
    let s = createAgentPageState();
    expect(s.basePrompts["main-session"]).toBeNull();
    expect(s.basePromptOpen).toBeNull();
    // started：在途 + 展开该卡
    s = agentPageReducer(s, { type: "base-prompt-started", kind: "main-session" });
    expect(s.basePromptPending.has("main-session")).toBe(true);
    expect(s.basePromptOpen).toBe("main-session");
    // result：定向归位 + 清在途（缓存常驻）
    s = agentPageReducer(s, { type: "base-prompt-result", kind: "main-session", basePrompt: "BASE-MAIN" });
    expect(s.basePromptPending.has("main-session")).toBe(false);
    expect(s.basePrompts["main-session"]).toBe("BASE-MAIN");
    expect(s.basePromptOpen).toBe("main-session");
    // 他卡 result 不串位
    s = agentPageReducer(s, { type: "base-prompt-started", kind: "subagent-kg-writer" });
    expect(s.basePromptOpen).toBe("subagent-kg-writer"); // 恰一展开：新展开顶替
    s = agentPageReducer(s, { type: "base-prompt-result", kind: "subagent-kg-writer", basePrompt: "BASE-KGW" });
    expect(s.basePrompts["main-session"]).toBe("BASE-MAIN");
    expect(s.basePrompts["subagent-kg-writer"]).toBe("BASE-KGW");
    // toggle：切到他卡展开；同卡再点 = 收起
    s = agentPageReducer(s, { type: "base-prompt-toggle", kind: "main-session" });
    expect(s.basePromptOpen).toBe("main-session");
    s = agentPageReducer(s, { type: "base-prompt-toggle", kind: "main-session" });
    expect(s.basePromptOpen).toBeNull();
    // 重拉（changed 链）不清 base prompt 缓存（静态数据拉一次常驻）
    s = agentPageReducer(s, { type: "list-result", profiles: [MAIN_BLOCK, SUB_BLOCK], system: [ORCH_BLOCK, KGW_BLOCK] });
    expect(s.basePrompts["main-session"]).toBe("BASE-MAIN");
  });
});
