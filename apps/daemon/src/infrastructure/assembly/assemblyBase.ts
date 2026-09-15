import type { ProfileKind } from "../../application/ports/outbound/ResourceStatePort";
import { MainSessionProfile } from "../../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { OrchestratorProfile } from "../../adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { SubAgentKgWriterProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import { SubAgentCodeReviewerProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";

/**
 * 提示组装 base 段单源（code-review H6）：五 kind 全覆盖 Record——
 * kg-writer/code-reviewer 映射各自 profile 的 systemPrompt（SUBAGENT
 * base + 专属后缀，profile 声明面已拼好），与 buildDrivingAdapters 的
 * basePrompts 五 kind 口径同源。Record 形态消 else 兜底：新增 kind 漏配
 * 即编译期错误，不再有静默错配面。
 */
const ASSEMBLY_BASE_PROMPTS: Record<ProfileKind, string> = {
  "main-session": MainSessionProfile.systemPrompt,
  "subagent-worker": SubAgentProfile.systemPrompt,
  orchestrator: OrchestratorProfile.systemPrompt,
  "subagent-kg-writer": SubAgentKgWriterProfile.systemPrompt,
  "subagent-code-reviewer": SubAgentCodeReviewerProfile.systemPrompt,
};

/** 提示组装 base 段（SystemPromptAssembler 的 base 输入单源）。 */
export function assemblyBasePromptOf(kind: ProfileKind): string {
  return ASSEMBLY_BASE_PROMPTS[kind];
}
