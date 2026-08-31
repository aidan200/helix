import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  AgentConfigChangedEvent,
  AgentConfigListCommand,
  AgentConfigListResultEvent,
  AgentConfigSetEnabledCommand,
  AgentConfigSetEnabledResultEvent,
  CommandEnvelope,
  EventEnvelope,
} from "../../../src/index";

/**
 * v0.6 样例帧（agent.config 族：2 命令 / 1 广播 + 2 结果帧；M6 T3，智能体
 * 配置页契约）。构造即类型检查（payload 字面量对位窄化）。
 */
// ── 命令样例 ──

/** agent.config.list：全 kind（payload.profileKind 缺省 = 全部 kind 双块下发） */
export const agentConfigListAll: AgentConfigListCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.config.list",
  payload: {},
};

/** agent.config.list：单 kind（subagent-worker 单块下发） */
export const agentConfigListSingle: AgentConfigListCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.config.list",
  payload: { profileKind: "subagent-worker" },
};

/** agent.config.set_enabled：tool 禁用（全集内名 → applied + changed 广播） */
export const agentConfigDisableGrep: AgentConfigSetEnabledCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.config.set_enabled",
  payload: { profileKind: "main-session", resourceType: "tool", name: "grep", enabled: false },
};

/** agent.config.set_enabled：skill 启用 */
export const agentConfigEnableSkill: AgentConfigSetEnabledCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.config.set_enabled",
  payload: { profileKind: "main-session", resourceType: "skill", name: "hello-skill", enabled: true },
};

/** agent.config.set_enabled：model set 槽位（enabled=true 设 name 为槽位模型） */
export const agentConfigModelSet: AgentConfigSetEnabledCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.config.set_enabled",
  payload: {
    profileKind: "main-session",
    resourceType: "model",
    name: "anthropic/claude-sonnet-4-5",
    enabled: true,
  },
};

/** agent.config.set_enabled：model clear 槽位（enabled=false 清槽，name 忽略） */
export const agentConfigModelClear: AgentConfigSetEnabledCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.config.set_enabled",
  payload: { profileKind: "main-session", resourceType: "model", name: "-", enabled: false },
};

// ── 事件样例 ──

/** agent.config.list.result：点对点结果帧（全 kind 双块） */
export const agentConfigListResult: AgentConfigListResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.list.result",
  payload: {
    profiles: [
      {
        profileKind: "main-session",
        tools: [
          { name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" },
          { name: "grep", enabled: false, snippet: "跨文件正则检索并列出匹配行" },
        ],
        skills: [
          {
            name: "hello-skill",
            description: "问候技能",
            filePath: "/home/dev/.helix/skills/hello-skill/SKILL.md",
            source: "user",
            enabled: true,
          },
          {
            // v0.8：builtin 第三源（daemon 随仓内置技能；不可禁用——读面恒 enabled=true）
            name: "web-access",
            description: "联网操作指引",
            filePath: "/daemon/resources/skills/web-access/SKILL.md",
            source: "builtin",
            enabled: true,
          },
        ],
        diagnostics: [
          {
            code: "invalid_metadata",
            message: "SKILL.md 缺少 description",
            path: "/ws/.helix/skills/broken/SKILL.md",
            source: "project",
          },
        ],
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: null, // v0.11 批内补登（thinking 批 AD-6）：未配置 = null
      },
      {
        profileKind: "subagent-worker",
        tools: [{ name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" }],
        skills: [],
        diagnostics: [],
        model: null, // 槽位未设 = null（非 undefined——JSON 序列化面）
        thinkingLevel: "xhigh", // v0.11 批内补登：已配置 = 档位字符串透传（AD-2）
      },
    ],
  },
};

/** agent.config.changed：tool 禁用广播（信封 sessionId = SYSTEM_SESSION_ID） */
export const agentConfigChangedTool: AgentConfigChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.changed",
  payload: { profileKind: "main-session", resourceType: "tool", name: "grep", enabled: false },
};

/** agent.config.changed：model clear 广播（name = null = 槽位已清） */
export const agentConfigChangedModelClear: AgentConfigChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.changed",
  payload: { profileKind: "subagent-worker", resourceType: "model", name: null, enabled: false },
};

/** agent.config.set_enabled：thinking set 槽位（v0.11 批内补登，AD-6；档位字符串透传不校验）。
 *  注：不入 v06Commands/v06Events 目录数组——样例为既有命令/事件 type 的新形态
 * （type 计数不变），目录完备性断言（catalog.test.ts）枚举面不扩。 */
export const agentConfigThinkingSet: AgentConfigSetEnabledCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.config.set_enabled",
  payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "xhigh", enabled: true },
};

/** agent.config.set_enabled：thinking clear 槽位（enabled=false 清槽，name 忽略） */
export const agentConfigThinkingClear: AgentConfigSetEnabledCommand = {
  v: PROTOCOL_VERSION,
  type: "agent.config.set_enabled",
  payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "-", enabled: false },
};

/** agent.config.changed：thinking set 广播（name = 档位字符串） */
export const agentConfigChangedThinkingSet: AgentConfigChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.changed",
  payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "xhigh", enabled: true },
};

/** agent.config.set_enabled.result：applied（点对点） */
export const agentConfigSetResultApplied: AgentConfigSetEnabledResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.set_enabled.result",
  payload: { status: "applied" },
};

/** agent.config.set_enabled.result：skipped unknown-name（全集外名不落库） */
export const agentConfigSetResultUnknownName: AgentConfigSetEnabledResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.set_enabled.result",
  payload: { status: "skipped", reason: "unknown-name" },
};

/** agent.config.list.result：skipped unknown-model（不在合并目录） */
export const agentConfigSetResultUnknownModel: AgentConfigSetEnabledResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.set_enabled.result",
  payload: { status: "skipped", reason: "unknown-model" },
};

/** agent.config.list.result：只读系统派生双块（additive 微批：system 可选块——
 *  orchestrator 声明全集 / kg-writer = worker 生效集 + kg-update 恒在）。
 *  注：不入 v06Events 目录数组——既有事件 type 的新形态（type 计数不变）。 */
export const agentConfigListResultSystem: AgentConfigListResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "agent",
  type: "agent.config.list.result",
  payload: {
    profiles: [
      {
        profileKind: "main-session",
        tools: [{ name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" }],
        skills: [],
        diagnostics: [],
        model: null,
        thinkingLevel: null,
      },
      {
        profileKind: "subagent-worker",
        tools: [{ name: "bash", enabled: true, snippet: "在沙箱工作目录执行 shell 命令并返回输出" }],
        skills: [],
        diagnostics: [],
        model: null,
        thinkingLevel: null,
      },
    ],
    system: [
      {
        profileKind: "orchestrator",
        tools: [{ name: "agent_spawn", snippet: "指派 SubAgent 实例独立执行任务（并行委派，立即返回不等完成）" }],
      },
      {
        profileKind: "subagent-kg-writer",
        tools: [
          { name: "bash", snippet: "在沙箱工作目录执行 shell 命令并返回输出" },
          { name: "kg-update", snippet: "知识图谱即时落账（supersede 推翻节点 / createNode 沉淀新知识）" },
        ],
        derivedFrom: "subagent-worker",
        pinnedTools: ["kg-update"],
      },
    ],
  },
};

export const v06Commands: CommandEnvelope[] = [
  agentConfigListAll,
  agentConfigListSingle,
  agentConfigDisableGrep,
  agentConfigEnableSkill,
  agentConfigModelSet,
  agentConfigModelClear,
];
export const v06Events: EventEnvelope[] = [
  agentConfigListResult,
  agentConfigChangedTool,
  agentConfigChangedModelClear,
  agentConfigSetResultApplied,
  agentConfigSetResultUnknownName,
  agentConfigSetResultUnknownModel,
];
