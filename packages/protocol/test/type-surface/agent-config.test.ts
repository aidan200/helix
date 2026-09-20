/**
 * agent.config 族类型面单测（v0.6，M6 T3 智能体配置页契约）：
 * - 命令 payload 位置类型（list 可选 profileKind / set_enabled 四字段必填）；
 * - 事件 payload 判别（set_enabled.result 的 applied/skipped 联合；changed 的
 *   model clear name=null 形态；list.result 的 profiles 块形状含 diagnostics 与
 *   model: string | null）；
 * - 负向：缺必填字段 / 越界字面量 → @ts-expect-error 编译期拒绝。
 */
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "../../src/index";
import type {
  AgentConfigListCommand,
  AgentConfigListPayload,
  AgentConfigProfileBlock,
  AgentConfigSetEnabledCommand,
  AgentConfigSetEnabledPayload,
} from "../../src/index";
import {
  agentConfigChangedModelClear,
  agentConfigChangedThinkingSet,
  agentConfigChangedTool,
  agentConfigListResult,
  agentConfigListResultSystem,
  agentConfigListSingle,
  agentConfigModelClear,
  agentConfigModelSet,
  agentConfigSetResultApplied,
  agentConfigSetResultUnknownModel,
  agentConfigThinkingClear,
  agentConfigThinkingSet,
} from "./samples/v06";
import type { AgentConfigSystemBlock, ErrorCode } from "../../src/index";
import type {
  AgentStewardProfileGetCommand,
  AgentStewardProfileGetResultEvent,
  AgentStewardProfileGetResultPayload,
  AgentStewardProfileToolRow,
} from "../../src/index";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES } from "../../src/index";
import type { Equal, Expect } from "./samples/helpers";
import { dispatchCommand, familyOf, summarizeEvent } from "./samples/helpers";

// ── 命令 payload 类型级断言（编译期） ───────────────────────

// list：profileKind 可选（缺省 = 全部 kind）——两形态都合法
const _listAll: AgentConfigListPayload = {};
const _listSingle: AgentConfigListPayload = { profileKind: "main-session" };
// @ts-expect-error profileKind 只接受两 kind 字面量（未知 kind 编译期拒绝）
const _listBadKind: AgentConfigListPayload = { profileKind: "global" };

// set_enabled：四字段全必填
const _setEnabledFull: AgentConfigSetEnabledPayload = {
  profileKind: "subagent-worker",
  resourceType: "model",
  name: "anthropic/claude-sonnet-4-5",
  enabled: false,
};
// @ts-expect-error 缺 enabled → 编译期拒绝（enabled 是 set/clear 判别位）
const _setEnabledNoEnabled: AgentConfigSetEnabledPayload = { profileKind: "main-session", resourceType: "tool", name: "grep" };
// @ts-expect-error resourceType 只接受 tool/skill/model/thinking（越界字面量编译期拒绝）
const _setEnabledBadType: AgentConfigSetEnabledPayload = { profileKind: "main-session", resourceType: "hook", name: "steer", enabled: true };
// v0.11 批内补登：thinking 槽位型合法（set/clear 两形态）
const _setEnabledThinkingSet: AgentConfigSetEnabledPayload = { profileKind: "subagent-worker", resourceType: "thinking", name: "xhigh", enabled: true };
const _setEnabledThinkingClear: AgentConfigSetEnabledPayload = { profileKind: "subagent-worker", resourceType: "thinking", name: "-", enabled: false };

// v0.8：skills[].source 字面量联合扩 builtin（daemon 随仓内置第三源）
const _skillBuiltin: AgentConfigProfileBlock["skills"][number] = {
  name: "web-access",
  description: "联网操作指引",
  filePath: "/daemon/resources/skills/agent/web-access/SKILL.md",
  source: "builtin",
  audience: "agent",
  enabled: true,
};
// @ts-expect-error source 只接受 user/project/builtin（越界字面量编译期拒绝）
const _skillBadSource: AgentConfigProfileBlock["skills"][number] = { name: "x", description: "x", filePath: "/x/SKILL.md", source: "global", enabled: true };

describe("agent.config 命令族 payload（v0.6）", () => {
  test("list：缺省全 kind / 单 kind 两形态可构造且 v 位为当前版本", () => {
    expect(agentConfigListSingle.payload).toEqual({ profileKind: "subagent-worker" });
    expect(agentConfigListSingle.v).toBe(PROTOCOL_VERSION);
    const all: AgentConfigListCommand = { v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} };
    expect(all.type).toBe("agent.config.list");
  });

  test("set_enabled：model set/clear 两形态可构造（clear 时 name 为忽略位占位）", () => {
    expect(agentConfigModelSet.payload).toEqual({
      profileKind: "main-session",
      resourceType: "model",
      name: "anthropic/claude-sonnet-4-5",
      enabled: true,
    });
    expect(agentConfigModelClear.payload.enabled).toBe(false);
    const cmd: AgentConfigSetEnabledCommand = {
      v: PROTOCOL_VERSION,
      type: "agent.config.set_enabled",
      payload: { profileKind: "main-session", resourceType: "skill", name: "hello-skill", enabled: false },
    };
    expect(cmd.type).toBe("agent.config.set_enabled");
  });
});

describe("agent.config 事件族 payload（v0.6）", () => {
  test("list.result：profiles 块形状（tools/skills/diagnostics/model null 形态；tools 行含 snippet）", () => {
    expect(agentConfigListResult.channel).toBe("agent");
    expect(agentConfigListResult.sessionId).toBe(SYSTEM_SESSION_ID);
    const [main, sub] = agentConfigListResult.payload.profiles;
    expect(main!.profileKind).toBe("main-session");
    expect(main!.model).toBe("anthropic/claude-sonnet-4-5");
    expect(main!.diagnostics[0]!.code).toBe("invalid_metadata");
    expect(main!.skills[0]!.source).toBe("user");
    // v0.8：builtin 第三源样例行（不可禁用——读面恒 enabled=true）
    expect(main!.skills[1]!.source).toBe("builtin");
    expect(main!.skills[1]!.enabled).toBe(true);
    // 槽位未设 = null（JSON 面：undefined 经序列化会丢字段，契约钉死 null）
    expect(sub!.model).toBeNull();    expect(sub!.tools[0]!.enabled).toBe(true);
    // v0.6 批内补登（M6 T4）：tools 行 snippet 一句话说明（daemon 注册表同源）
    expect(typeof main!.tools[0]!.snippet).toBe("string");
    expect(main!.tools[0]!.snippet.length).toBeGreaterThan(0);
  });

  test("changed：tools/skills 同构 + model clear 的 name=null 形态", () => {
    expect(agentConfigChangedTool.payload).toEqual({
      profileKind: "main-session",
      resourceType: "tool",
      name: "grep",
      enabled: false,
    });
    expect(agentConfigChangedModelClear.payload.name).toBeNull();
    expect(agentConfigChangedModelClear.payload.enabled).toBe(false);
    expect(agentConfigChangedModelClear.channel).toBe("agent");
  });

  test("changed：tools/skills 同构 + model clear 的 name=null 形态", () => {
    expect(agentConfigChangedTool.payload).toEqual({
      profileKind: "main-session",
      resourceType: "tool",
      name: "grep",
      enabled: false,
    });
    expect(agentConfigChangedModelClear.payload.name).toBeNull();
    expect(agentConfigChangedModelClear.payload.enabled).toBe(false);
    expect(agentConfigChangedModelClear.channel).toBe("agent");
  });

  // v0.11 批内补登（thinking 批 AD-6，iter-20260823-6ps5 T1.3）：thinking 槽位
  // 型 resourceType 扩值 + list.result 块 thinkingLevel 字段（null = 未配置）。
  test("thinking 槽位（v0.11 补登）：set/clear 命令 + changed 广播 + list.result 块 thinkingLevel", () => {
    expect(agentConfigThinkingSet.payload).toEqual({
      profileKind: "subagent-worker",
      resourceType: "thinking",
      name: "xhigh",
      enabled: true,
    });
    expect(agentConfigThinkingClear.payload.enabled).toBe(false); // clear：name 忽略位
    expect(agentConfigChangedThinkingSet.payload).toEqual({
      profileKind: "subagent-worker",
      resourceType: "thinking",
      name: "xhigh",
      enabled: true,
    });
    const [main, sub] = agentConfigListResult.payload.profiles;
    expect(main!.thinkingLevel).toBeNull(); // 未配置 = null（非 undefined）
    expect(sub!.thinkingLevel).toBe("xhigh"); // 已配置 = 档位字符串透传（AD-2）
  });

  test("set_enabled.result：applied / skipped(reason) 判别联合窄化", () => {
    if (agentConfigSetResultApplied.payload.status === "applied") {
      expect(agentConfigSetResultApplied.payload.status).toBe("applied");
    } else {
      throw new Error("applied 分支窄化失败");
    }
    if (agentConfigSetResultUnknownModel.payload.status === "skipped") {
      expect(agentConfigSetResultUnknownModel.payload.reason).toBe("unknown-model");
    } else {
      throw new Error("skipped 分支窄化失败");
    }
  });

  // ── additive 微批（agent-roster）：只读系统块 + 写面拒绝错误码 ──
  // 编译期：system 块三形态可构造；越界字面量拒绝。
  const _systemKgWriter: AgentConfigSystemBlock = {
    profileKind: "subagent-kg-writer",
    tools: [{ name: "bash", snippet: "在沙箱工作目录执行 shell 命令并返回输出", enabled: true }],
    pinnedTools: ["kg-update"],
  };
  // 编排归位批：orchestrator 归位系统只读块（声明全集 + 任务 SOP 注册表 + 只读 MCP 行）
  const _systemOrchestrator: AgentConfigSystemBlock = {
    profileKind: "orchestrator",
    tools: [{ name: "agent_spawn", snippet: "指派 SubAgent 实例独立执行任务", enabled: true }],
    mcpServers: [{ name: "shadcn", enabled: false, state: "running", toolCount: 3 }],
  };
  const _systemReviewer: AgentConfigSystemBlock = {
    profileKind: "subagent-code-reviewer",
    tools: [{ name: "bash", snippet: "在沙箱工作目录执行 shell 命令并返回输出", enabled: true }],
  };
  // @ts-expect-error 只读块 profileKind 只接受系统三 kind（可编辑 kind 编译期拒绝）
  const _systemBadKind: AgentConfigSystemBlock = { profileKind: "main-session", tools: [] };
  // 同轨批：派生块技能行带 enabled 只读启停位（默认 false）；orchestrator 任务 SOP 注册表行仍无启停位
  const _systemSkillRow: AgentConfigSystemBlock = {
    profileKind: "subagent-kg-writer",
    tools: [],
    skills: [{ name: "plan-workflow", description: "台账", filePath: "/agent/plan-workflow/SKILL.md", source: "builtin", audience: "agent", enabled: false }],
  };
  const _systemNoSkills: AgentConfigSystemBlock = { profileKind: "subagent-kg-writer", tools: [] };
  // @ts-expect-error enabled 只接受 boolean（非法值编译期拒绝）
  const _systemSkillBadRow: AgentConfigSystemBlock = { profileKind: "subagent-kg-writer", tools: [], skills: [{ name: "x", description: "x", filePath: "/x", source: "builtin", audience: "agent", enabled: "on" }] };
  // 错误码登记：只读 kind 写面拒绝码
  const _readOnlyCode: ErrorCode = "agent.config.read_only";

  test("system 只读块（编排归位批）：system 三块（orchestrator 归位 + 派生双块）+ profiles 双块（task-worker 已撤）", () => {
    // 旧形态零变化：system 未携带（additive——旧客户端不感知）
    expect(agentConfigListResult.payload.system).toBeUndefined();
    expect(agentConfigListResult.payload.profiles).toHaveLength(2);
    // 新形态：双可编辑块（main/sub）+ 系统三只读块（orchestrator 在前）
    const payload = agentConfigListResultSystem.payload;
    expect(payload.profiles).toHaveLength(2);
    const system = payload.system!;
    expect(system).toHaveLength(3);
    expect(system[0]!.profileKind).toBe("orchestrator");
    expect(system[1]!.profileKind).toBe("subagent-kg-writer");
    expect(system[1]!.pinnedTools).toEqual(["kg-update"]);
    // 终态：kg-writer 工具清单 = 自身 catalog 透传（行带 enabled 位）
    expect(system[1]!.tools.map((t) => t.name)).toEqual(["bash", "kg-update"]);
    expect(system[1]!.tools[1]!.snippet.length).toBeGreaterThan(0);
    // orchestrator 块：task SOP 行带 enabled 位（透传同构——恒 false，消费在 kickoff）
    const orchSopRow = system[0]!.skills!.find((s) => s.name === "code-review")!;
    expect(orchSopRow.audience).toBe("task");
    expect(orchSopRow.enabled).toBe(false); // task 层不播种不可开
    expect(system[0]!.mcpServers?.[0]).toMatchObject({ name: "shadcn", enabled: false });
    // 派生块技能行 = 自身清单透传（builtin 播种五 kind 全开）
    expect(system[1]!.skills?.[0]!.audience).toBe("agent");
    expect(system[1]!.skills![0]!.enabled).toBe(true); // 终态：播种位
    void _systemKgWriter;
    void _systemOrchestrator;
    void _systemReviewer;
    void _systemSkillRow;
    void _systemNoSkills;
    void _systemSkillBadRow;
    void _readOnlyCode;
  });
});

// ── 管家公民权批：agent.steward_profile.get（管家只读档案——观测透明度对齐
//    其他 agent kind；不进 profile 注册表，走独立命令避免「可配置」误解）──

// 类型级断言：回执四字段形状（kindLabel 恒 "steward"；model 槽位 null 形态合法）
type _StewardProfileModel = Expect<Equal<AgentStewardProfileGetResultPayload["model"], string | null>>;
type _StewardProfileKind = Expect<Equal<AgentStewardProfileGetResultPayload["kindLabel"], "steward">>;
type _StewardProfilePrompt = Expect<Equal<AgentStewardProfileGetResultPayload["systemPrompt"], string>>;
type _StewardProfileTools = Expect<
  Equal<AgentStewardProfileGetResultPayload["tools"], ReadonlyArray<AgentStewardProfileToolRow>>
>;
type _StewardProfileToolRow = Expect<Equal<AgentStewardProfileToolRow, { name: string; description: string }>>;
const _stewardProfileBadKind: AgentStewardProfileGetResultPayload = {
  systemPrompt: "x",
  tools: [],
  model: null,
  // @ts-expect-error kindLabel 只接受 "steward"（档案标识非自由字符串）
  kindLabel: "main-session",
};

const stewardProfileCommand: AgentStewardProfileGetCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.steward_profile.get",
  payload: {},
};

const stewardProfileResult: AgentStewardProfileGetResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: SYSTEM_SESSION_ID,
  channel: "agent",
  type: "agent.steward_profile.get.result",
  payload: {
    systemPrompt: "你是 helix 的文本管家（Steward）——常驻的全局监控与对话助手。",
    tools: [
      { name: "list_instances", description: "查询全部 agent 实例的状态清单。" },
      { name: "steward_confirm", description: "确认闸放行（面板确认按钮原语——非 LLM 工具）。" },
    ],
    model: "deepseek/deepseek-v4-flash",
    kindLabel: "steward",
  },
};

describe("管家公民权批：agent.steward_profile.get 管家只读档案（additive）", () => {
  test("目录登记：命令 +1（agent 族）/ 事件 +1（挂 agent 通道）", () => {
    expect(COMMAND_TYPES).toContain("agent.steward_profile.get");
    expect(EVENT_TYPES).toContain("agent.steward_profile.get.result");
    expect(EVENT_CHANNELS["agent.steward_profile.get.result"]).toBe("agent");
  });

  test("命令可构造且 dispatch 窄化（零载荷全局读面）", () => {
    expect(dispatchCommand(stewardProfileCommand)).toBe("agent-steward-profile-get");
  });

  test("回执四字段窄化：prompt 全文 / 工具行 name+description / model 槽位（null 形态合法）/ kindLabel", () => {
    expect(summarizeEvent(stewardProfileResult)).toBe("steward-profile:2:deepseek/deepseek-v4-flash:steward");
    expect(familyOf(stewardProfileResult)).toBe("agent/agent.steward_profile.get.result");
    const unset: AgentStewardProfileGetResultPayload = { ...stewardProfileResult.payload, model: null };
    expect(unset.model).toBeNull();
    void _stewardProfileBadKind;
  });
});
