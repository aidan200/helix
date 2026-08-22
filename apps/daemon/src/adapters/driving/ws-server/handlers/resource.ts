/**
 * agent.config 族命令处理（v0.6 智能体配置页）：handlers/ 落位
 * （接线落 handlers/ 非 events/；model.catalog 全局命令先例）。
 *
 * - agent.config.list → ResourceConfigPort.list 组装 DTO 块 →
 *   agent.config.list.result 点对点结果帧（sendNow 直发发起连接，
 *   TR-AD-21 模式：不经 EventStream 广播）；缺省 payload = 全部 kind
 *   （main-session + subagent-worker 双块，序固定）。
 * - agent.config.set_enabled → 前置校验（kind/resourceType/name/enabled
 *   形状）→ tool/skill 走 setEnabled（ResourceService 自带 unknown-name
 *   skipped 语义）；model 型先经合并目录校验函数 hasModel（ModelService
 *   .setModel 先例，目录外 → skipped/unknown-model 回执）→ setModelSlot /
 *   clearModelSlot（enabled=true 设槽 / false 清槽）→ agent.config.
 *   set_enabled.result 点对点回执；applied 时 agent.config.changed 广播
 *   （EventStream 章印路由，daemon 级全局全连接）。tool/skill 的 applied
 *   落库即发布 resources.changed 触发刷新链（活跃 runtime 直改，单点在
 *   装配侧订阅）。
 *
 * DTO 映射（ResourceConfigBlock → AgentConfigProfileBlock）落本模块
 * （既有拆分后结构裁量：量小内聚族处理，不入 DtoMapper 的领域事件面）。
 * 仍在 driving adapter 内（TR-AD-1 分层不变，零新 port 之外的决策）：
 * 依赖面经 ResourceCommandContext 由 WsServerAdapter 供出。
 */
import type {
  AgentConfigListResultEvent,
  AgentConfigProfileBlock,
  AgentConfigSetEnabledResultEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { ResourceConfigBlock } from "../../../../application/ports/inbound/ResourceConfigPort";
import type { ProfileKind, ResourceType } from "../../../../application/ports/outbound/ResourceStatePort";
import type { ResourceCommandContext } from "./context";

/** 命令 payload 校验通过的归一形态。 */
interface SetEnabledInput {
  profileKind: ProfileKind;
  resourceType: ResourceType;
  name: string;
  enabled: boolean;
}

/** set_enabled payload 形状校验（失败 → command.invalid_payload，连接保持）。 */
function normalizeSetEnabled(ctx: ResourceCommandContext, payload: Record<string, unknown>): SetEnabledInput | undefined {
  const { profileKind, resourceType, name, enabled } = payload;
  if (profileKind !== "main-session" && profileKind !== "subagent-worker") {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.profileKind 应为 \"main-session\" | \"subagent-worker\"");
    return undefined;
  }
  if (resourceType !== "tool" && resourceType !== "skill" && resourceType !== "model") {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.resourceType 应为 \"tool\" | \"skill\" | \"model\"");
    return undefined;
  }
  if (typeof name !== "string" || name.trim() === "") {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.name 应为非空 string（model 型 = \"provider/model-id\"）");
    return undefined;
  }
  if (typeof enabled !== "boolean") {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled 应为 boolean（model 型 = set/clear 槽位判别位）");
    return undefined;
  }
  return { profileKind, resourceType, name, enabled };
}

/** ResourceConfigBlock（domain 面）→ AgentConfigProfileBlock（协议 DTO）：model undefined → null。 */
function toProfileBlockDto(block: ResourceConfigBlock): AgentConfigProfileBlock {
  return {
    profileKind: block.profileKind,
    tools: block.tools.map((t) => ({ ...t })),
    skills: block.skills.map((s) => ({ ...s })),
    diagnostics: block.diagnostics.map((d) => ({ ...d })),
    model: block.model ?? null,
  };
}

/** agent.config.list（全局读面）：agent.config.list.result 点对点回执。 */
export function handleAgentConfigList(ctx: ResourceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const kind = ctx.payload.profileKind;
  if (kind !== undefined && kind !== "main-session" && kind !== "subagent-worker") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.profileKind 应为 \"main-session\" | \"subagent-worker\"");
  }
  // 缺省 = 全部 kind（序固定：main-session 在前；type 层 profileKind 可选）
  const kinds: readonly ProfileKind[] = kind !== undefined ? [kind] : ["main-session", "subagent-worker"];
  void Promise.all(kinds.map((k) => ctx.resource.list(k)))
    .then((blocks) => {
      const frame: AgentConfigListResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID, // 全局命令：会话无关（model.catalog.result 同构）
        channel: "agent",
        type: "agent.config.list.result",
        payload: { profiles: blocks.map(toProfileBlockDto) },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `配置读面组装失败：${(err as Error).message}`));
}

/** agent.config.set_enabled（全局写面）：四路径回执 + applied 广播。 */
export function handleAgentConfigSetEnabled(ctx: ResourceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const input = normalizeSetEnabled(ctx, ctx.payload);
  if (input === undefined) return;
  const { profileKind, resourceType, name, enabled } = input;

  const run = async (): Promise<void> => {
    let outcome: { status: "applied" } | { status: "skipped"; reason: string };
    /** 广播载荷 name：tools/skills = 资源名；model = id 或 null（clear）。 */
    let changedName: string | null = null;
    if (resourceType === "model") {
      if (enabled) {
        // set 槽位：先经合并目录校验（ModelService.setModel 先例；hasModel
        // 同步读面零网络）。目录外 → skipped/unknown-model，不落库不广播。
        if (!ctx.hasModel(name)) {
          outcome = { status: "skipped", reason: "unknown-model" };
        } else {
          await ctx.resource.setModelSlot(profileKind, name);
          outcome = { status: "applied" };
          changedName = name;
        }
      } else {
        await ctx.resource.clearModelSlot(profileKind);
        outcome = { status: "applied" };
        changedName = null; // clear：广播 name = null
      }
    } else {
      // tool/skill：ResourceService.setEnabled 自带全集校验（unknown-name skipped）
      outcome = await ctx.resource.setEnabled(profileKind, resourceType, name, enabled);
      if (outcome.status === "applied") changedName = name;
    }
    const frame: AgentConfigSetEnabledResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "agent",
      type: "agent.config.set_enabled.result",
      payload: outcome.status === "applied" ? { status: "applied" } : { status: "skipped", reason: outcome.reason },
    };
    ctx.sendNow(sender, frame);
    if (outcome.status === "applied") {
      // daemon 级全局广播（EventStream 章印路由：SYSTEM_SESSION_ID → 全连接）。
      // tool/skill 的活跃 runtime 刷新已由 resources.changed 链在落库点自动触发。
      ctx.events.broadcastAgentConfigChanged({ profileKind, resourceType, name: changedName, enabled });
    }
  };
  void run().catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `配置写面失败：${(err as Error).message}`));
}
