/**
 * 智能体页页面模型（M6 T4；AG-15 页面私有 reducer，trace-model 先例——
 * 不进 session store / dispatcher 注册表）。
 *
 * 状态模型：
 * - 读面四态互斥：idle（未拉）→ loading → ready / error；有数据时的静默
 *   重拉不降级回 loading（防闪烁，保 ready）；
 * - profiles：双 kind 块按 profileKind 归位（单 kind 响应只覆写该块）；
 * - pending：写面在途行（key = kind:resourceType:name；model/thinking 槽位
 *   统一空名键——set/clear 同键单飞）。结果帧无请求回显（契约 §16.4），
 *   单飞纪律在页面侧（pending 非空不再发新写命令）；新鲜 list.result 到达
 *   全清（changed 广播 → 重拉收口），skipped 回执定向清。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { AgentConfigProfileBlock } from "@helix/protocol";

/** profile kind 维（与协议 profileKind 字面量同源）。 */
export type AgentKind = "main-session" | "subagent-worker";

/** 双 kind 固定卡序（协议 list.result 缺省块序同构）。 */
export const AGENT_KINDS: readonly AgentKind[] = ["main-session", "subagent-worker"];

export interface AgentPageState {
  /** 读面状态（idle → loading → ready / error 互斥；静默重拉保 ready） */
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  profiles: Readonly<Record<AgentKind, AgentConfigProfileBlock | null>>;
  /** 写面在途行 key 集（单飞：结果帧无回显，页面侧保证同刻至多一条） */
  pending: ReadonlySet<string>;
}

/** 写面资源维（协议收窄值：tool/skill 启停 + model/thinking 槽位）。 */
export type AgentWriteResource = "tool" | "skill" | "model" | "thinking";

/** 写面在途 key（model/thinking 槽位统一空名——set/clear 同键单飞）。 */
export function pendingKeyOf(
  kind: AgentKind,
  resourceType: AgentWriteResource,
  name: string,
): string {
  return `${kind}:${resourceType}:${resourceType === "model" || resourceType === "thinking" ? "" : name}`;
}

export function createAgentPageState(): AgentPageState {
  return {
    status: "idle",
    error: null,
    profiles: { "main-session": null, "subagent-worker": null },
    pending: new Set<string>(),
  };
}

export type AgentPageAction =
  | { type: "list-started" }
  | { type: "list-result"; profiles: readonly AgentConfigProfileBlock[] }
  | { type: "list-failed"; reason: string }
  | { type: "toggle-started"; kind: AgentKind; resourceType: AgentWriteResource; name: string }
  | { type: "toggle-settled"; kind: AgentKind; resourceType: AgentWriteResource; name: string };

function hasData(s: AgentPageState): boolean {
  return s.profiles["main-session"] !== null || s.profiles["subagent-worker"] !== null;
}

export function agentPageReducer(s: AgentPageState, action: AgentPageAction): AgentPageState {
  switch (action.type) {
    case "list-started":
      // 有数据 = 静默重拉（防闪烁）；无数据 = 首拉 loading
      return hasData(s) ? s : { ...s, status: "loading" };
    case "list-result": {
      const profiles: Record<AgentKind, AgentConfigProfileBlock | null> = { ...s.profiles };
      for (const block of action.profiles) {
        if (block.profileKind === "main-session" || block.profileKind === "subagent-worker") {
          profiles[block.profileKind] = block;
        }
      }
      return { ...s, status: "ready", error: null, profiles, pending: new Set<string>() };
    }
    case "list-failed":
      return { ...s, status: hasData(s) ? s.status : "error", error: action.reason };
    case "toggle-started": {
      const pending = new Set(s.pending);
      pending.add(pendingKeyOf(action.kind, action.resourceType, action.name));
      return { ...s, pending };
    }
    case "toggle-settled": {
      const pending = new Set(s.pending);
      pending.delete(pendingKeyOf(action.kind, action.resourceType, action.name));
      return { ...s, pending };
    }
  }
}

/** 读面视图（error 仅在无数据时可见——有数据保渲染不闪错误页）。 */
export function selectAgentPageView(s: AgentPageState): "idle" | "loading" | "error" | "ready" {
  if (s.status === "error" && hasData(s)) return "ready";
  return s.status;
}
