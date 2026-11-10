/** en-US 词条分片：agents 域（barrel 见 ../en-US.ts）。
 *
 * 业务域分片重构（体量门）：词条自原 en-US.ts 原样迁移（零改写）；
 * 结构一致性由 `satisfies Pick<Translations, 域名>` 编译期兜底。
 */
import type { Translations } from "../zh-CN";

export const agents = {
  agents: {
    title: "Agents",
    mainTitle: "Main session assistant",
    subTitle: "SubAgent worker",
    // agent-roster batch: master-detail two groups + read-only system profiles
    groupEditable: "Configurable",
    groupSystem: "System derived",
    roBadge: "Read-only",
    roToolsBadge: "Tools read-only",
    modelNoteSystem: "Falls back to the global default model when unset (no subagent-worker coupling)",
    orchestratorTitle: "Task orchestrator",
    kgWriterTitle: "KG writer SubAgent",
    reviewerTitle: "Code reviewer SubAgent",
    noSelectTitle: "Select an agent",
    noSelectSub: "Configuration details appear here; system derived profiles are read-only",
    pinnedTag: "Pinned",
    modelLabel: "Model",
    modelFollowMain: "Follow global default",
    modelFollowSub: "Follow global default",
    modelNoteMain: "Factory default: new sessions assemble with this model; manually switched sessions are unaffected",
    modelNoteSub: "Factory default: frozen at spawn time; running instances are unaffected",
    toolsLabel: "Tools",
    mcpLabel: "MCP Servers",
    mcpEmpty: "No MCP server connected (add one in Settings)",
    mcpToolCount: "{count} tools",
    mcpOffChip: "Group off",
    mcpState: {
      idle: "Idle",
      connecting: "Connecting",
      running: "Running",
      error: "Error",
      stopped: "Stopped",
    },
    skillsLabel: "Skills",
    skillsEmpty: "No skills installed (user: ~/.helix/skills, project: workspace .helix/skills)",
    skillAudienceTask: "Task SOP",
    skillAudienceTaskHint: "Task-type SOP: injected in full via task kickoff; permanently disabled on agent faces (read-only)",
    skillSourceBuiltin: "Built-in",
    diagLabel: "Scan diagnostics",
    loading: "Loading agent configuration",
    errorTitle: "Failed to load agent configuration",
    retry: "Retry",
    skippedToast: "Not applied: {reason}",
    writeFailToast: "Write failed · {message}",
    notConnected: "Not connected to daemon",
    writePendingToast: "Previous change is still saving — try again shortly",
    switchOn: "On",
    switchOff: "Off",
    // base prompt batch: base-segment system prompt viewer (lazy query on expand)
    basePromptLabel: "System Prompt · Base Segment",
    basePromptView: "View",
    basePromptHide: "Collapse",
    basePromptLoading: "Loading base prompt",
    basePromptNote: "Static base segment (role and behavior guidance); tool/skill lists are assembled at runtime from enablement state. See the trace snapshot for the effective full prompt.",
    // skill-content batch: skill body (full SKILL.md) viewer (per-row lazy query)
    skillContentView: "View",
    skillContentHide: "Collapse",
    skillContentLoading: "Loading skill content",
    // Steward citizenship batch: resident-services group + steward read-only archive card
    groupResident: "Resident services",
    stewardTitle: "Steward",
    stewardBadge: "Resident",
    stewardResidency: "Embedded resident · WS direct · Not derivable",
    stewardNote: "An embedded resident member of the daemon (not a SubAgent profile); prompt and tools are read-only, on/off lives in Settings → General.",
    stewardModelUnset: "Not set (adapter default model)",
    stewardModelNote: "Model for steward replies and compaction summaries",
    stewardPromptLabel: "System prompt",
    stewardPromptView: "View",
    stewardPromptHide: "Collapse",
    stewardLoading: "Loading steward profile",
    stewardErrorTitle: "Failed to load steward profile",
    // 系统派生块技能读面批：系统块技能组（orchestrator = 任务 SOP 注册表；
    // 派生两块 = worker 生效技能集）
    // P-2 thinking level field (T3: on/off switch — off = empty slot by default, on writes the median level)
    thinking: {
      label: "Thinking Level · THINKING LEVEL",
      sliderLabel: "Thinking level",
      switchLabel: "Thinking level switch",
      disabledNote: "Current model does not support reasoning; thinking level is not configurable. Requests use provider defaults.",
      clampedHint: "{configured} → {effective} (capped by model capability; spawn resolution filters by capability, configured value kept)",
      capabilityLoading: "Loading model capability…",
    },
  },
} satisfies Pick<Translations, "agents">;
