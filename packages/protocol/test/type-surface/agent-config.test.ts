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
  filePath: "/daemon/resources/skills/web-access/SKILL.md",
  source: "builtin",
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

  // ── additive 微批（agent-roster）：只读系统派生块 + 写面拒绝错误码 ──
  // 编译期：system 块两形态可构造；越界字面量拒绝。
  const _systemKgWriter: AgentConfigSystemBlock = {
    profileKind: "subagent-kg-writer",
    tools: [{ name: "bash", snippet: "在沙箱工作目录执行 shell 命令并返回输出" }],
    derivedFrom: "subagent-worker",
    pinnedTools: ["kg-update"],
  };
  const _systemOrchestrator: AgentConfigSystemBlock = {
    profileKind: "orchestrator",
    tools: [{ name: "agent_spawn", snippet: "指派 SubAgent 实例独立执行任务" }],
  };
  // @ts-expect-error 只读块 profileKind 只接受 orchestrator/subagent-kg-writer（可编辑 kind 编译期拒绝）
  const _systemBadKind: AgentConfigSystemBlock = { profileKind: "main-session", tools: [] };
  // @ts-expect-error derivedFrom 只接受 subagent-worker（派生说明位单一事实源）
  const _systemBadDerived: AgentConfigSystemBlock = { profileKind: "orchestrator", tools: [], derivedFrom: "orchestrator" };
  // 错误码登记：只读 kind 写面拒绝码
  const _readOnlyCode: ErrorCode = "agent.config.read_only";

  test("system 只读块（additive）：list.result.system 双块形态 + profiles 两形态不变（缺省不携带 system）", () => {
    // 旧形态零变化：system 未携带（additive——旧客户端不感知）
    expect(agentConfigListResult.payload.system).toBeUndefined();
    expect(agentConfigListResult.payload.profiles).toHaveLength(2);
    // 新形态：双可编辑块 + 双只读块（orchestrator 在前）；kg-writer 携带派生说明位与恒在工具
    const system = agentConfigListResultSystem.payload.system!;
    expect(system).toHaveLength(2);
    expect(system[0]!.profileKind).toBe("orchestrator");
    expect(system[0]!.derivedFrom).toBeUndefined();
    expect(system[0]!.pinnedTools).toBeUndefined();
    expect(system[1]!.profileKind).toBe("subagent-kg-writer");
    expect(system[1]!.derivedFrom).toBe("subagent-worker");
    expect(system[1]!.pinnedTools).toEqual(["kg-update"]);
    // kg-writer 工具清单 = worker 生效集 + kg-update（行形状 name+snippet，无启停位）
    expect(system[1]!.tools.map((t) => t.name)).toEqual(["bash", "kg-update"]);
    expect(system[1]!.tools[1]!.snippet.length).toBeGreaterThan(0);
    void _systemKgWriter;
    void _systemOrchestrator;
    void _readOnlyCode;
  });
});
