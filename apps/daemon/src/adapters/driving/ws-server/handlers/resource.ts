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
 *
 * agent-roster 批 additive：读面缺省全量附带只读系统派生双块
 * （system[]：orchestrator 声明全集 / subagent-kg-writer = worker 当前
 * 生效集 + kg-update 恒在，随 worker toggle 动态跟随）；写面对只读
 * kind 恒拒（agent.config.read_only，连接保持——前端只读只是表现，后端
 * 拒绝才是事实）。恒在工具名经 ctx.kgWriterPinnedTools 注入
 * （SUBAGENT_KG_WRITER_EXTRA_TOOLS 增量常量单源——driving 不得 import
 * driven，组合根经窄函数面传递，hasModel 先例）。
 */
import type {
  AgentConfigListResultEvent,
  AgentConfigProfileBlock,
  AgentConfigSetEnabledResultEvent,
  AgentConfigSystemBlock,
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
  if (profileKind === "orchestrator" || profileKind === "subagent-kg-writer") {
    if (resourceType !== "model" && resourceType !== "thinking") {
      // R7 系统槽位批：系统派生 kind 仅 model/thinking 槽位型可写（独立配置，
      // 未配跟随全局）；tool/skill 启停写面仍拒（硬层拒绝不依赖前端表现）。
      ctx.commandError(ctx.type, "agent.config.read_only", `payload.profileKind ${profileKind} 为系统派生 kind：仅 model/thinking 槽位可配，tool/skill 启停只读（写面拒绝）`);
      return undefined;
    }
    // 槽位型放行（校验后续通用段：resourceType/name/enabled 形状）
  } else if (profileKind !== "main-session" && profileKind !== "subagent-worker") {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.profileKind 应为 \"main-session\" | \"subagent-worker\"");
    return undefined;
  }
  if (resourceType !== "tool" && resourceType !== "skill" && resourceType !== "model" && resourceType !== "thinking") {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.resourceType 应为 \"tool\" | \"skill\" | \"model\" | \"thinking\"");
    return undefined;
  }
  if (typeof name !== "string" || name.trim() === "") {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.name 应为非空 string（model 型 = \"provider/model-id\"；thinking 型 = 档位字符串）");
    return undefined;
  }
  if (typeof enabled !== "boolean") {
    ctx.commandError(ctx.type, "command.invalid_payload", "payload.enabled 应为 boolean（model/thinking 型 = set/clear 槽位判别位）");
    return undefined;
  }
  return { profileKind, resourceType, name, enabled };
}

/** ResourceConfigBlock（domain 面）→ AgentConfigProfileBlock（协议 DTO）：model/thinkingLevel undefined → null。 */
function toProfileBlockDto(block: ResourceConfigBlock): AgentConfigProfileBlock {
  return {
    // R7：ProfileKind 扩四值后此处仅可编辑 kind 经过（kg-writer 走 system 块），
    // 调用面恒 [main, sub]——收窄断言安全
    profileKind: block.profileKind as AgentConfigProfileBlock["profileKind"],
    tools: block.tools.map((t) => ({ ...t })),
    skills: block.skills.map((s) => ({ ...s })),
    diagnostics: block.diagnostics.map((d) => ({ ...d })),
    model: block.model ?? null,
    thinkingLevel: block.thinkingLevel ?? null,
  };
}

/**
 * 只读系统派生双块派生（agent-roster 批；序固定 orchestrator 在前）：
 * - orchestrator = 声明全集（resource.list 同源读面——写面拒绝放无差异
 *   行，enabled 位恒 true，纯展示面不携带）；
 * - kg-writer = worker 当前生效集（enabled 过滤）+ 恒在工具（ctx.kgWriter
 *   PinnedTools 单源）；恒在行 snippet 从 main 目录面同名行取回（注册表
 *   单源，越权复制零容忍；worker 目录无此名）。
 */
function toSystemBlocksDto(
  main: ResourceConfigBlock,
  worker: ResourceConfigBlock,
  orch: ResourceConfigBlock,
  pinnedTools: readonly string[],
  kgwModel: string | undefined,
  kgwThinking: string | undefined,
): readonly AgentConfigSystemBlock[] {
  return [
    {
      profileKind: "orchestrator",
      tools: orch.tools.map((t) => ({ name: t.name, snippet: t.snippet })),
      // R7 系统槽位：独立配置，未配跟随全局（不联动 worker）
      model: orch.model ?? null,
      thinkingLevel: orch.thinkingLevel ?? null,
    },
    {
      profileKind: "subagent-kg-writer",
      tools: [
        ...worker.tools.filter((t) => t.enabled).map((t) => ({ name: t.name, snippet: t.snippet })),
        ...pinnedTools.map((name) => ({
          name,
          snippet: main.tools.find((t) => t.name === name)?.snippet ?? "",
        })),
      ],
      derivedFrom: "subagent-worker",
      pinnedTools: [...pinnedTools],
      // R7：kg-writer 独立槽位（工具集仍派生 worker——职责语义；
      // 模型/推理不联动）
      model: kgwModel ?? null,
      thinkingLevel: kgwThinking ?? null,
    },
  ];
}

/** agent.config.list（全局读面）：agent.config.list.result 点对点回执。 */
export function handleAgentConfigList(ctx: ResourceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const kind = ctx.payload.profileKind;
  if (kind !== undefined && kind !== "main-session" && kind !== "subagent-worker") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.profileKind 应为 \"main-session\" | \"subagent-worker\"（只读系统派生 kind 随缺省全量下发）");
  }
  // 单 kind：单块回执（过滤请求面向可编辑 kind——system 只读块不携带）
  if (kind !== undefined) {
    void ctx.resource.list(kind)
      .then((block) => {
        const frame: AgentConfigListResultEvent = {
          v: PROTOCOL_VERSION,
          sessionId: SYSTEM_SESSION_ID,
          channel: "agent",
          type: "agent.config.list.result",
          payload: { profiles: [toProfileBlockDto(block)] },
        };
        ctx.sendNow(sender, frame);
      })
      .catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `配置读面组装失败：${(err as Error).message}`));
    return;
  }
  // 缺省 = 全部可编辑 kind（main-session 在前，序固定）+ 只读系统派生双块
  // （agent-roster 批 additive：orchestrator 块复用同源读面；kg-writer 块
  // 由 worker 生效集 + 恒在工具派生——与 buildSessionStack 装配快照同法）
  const kinds: readonly ProfileKind[] = ["main-session", "subagent-worker", "orchestrator"];
  void Promise.all(kinds.map((k) => ctx.resource.list(k)))
    .then((blocks) => {
      const [main, sub, orch] = [blocks[0]!, blocks[1]!, blocks[2]!];
      const frame: AgentConfigListResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID, // 全局命令：会话无关（model.catalog.result 同构）
        channel: "agent",
        type: "agent.config.list.result",
        payload: {
          profiles: [main, sub].map(toProfileBlockDto),
          system: toSystemBlocksDto(main, sub, orch, ctx.kgWriterPinnedTools, ctx.resource.modelSlot("subagent-kg-writer"), ctx.resource.thinkingSlot("subagent-kg-writer")),
        },
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
    /** 广播载荷 name：tools/skills = 资源名；model/thinking = 槽位值或 null（clear）。 */
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
    } else if (resourceType === "thinking") {
      // thinking 槽位（v0.11 补登，AD-6）：同 model 槽位语义（set/clear），
      // 但零前置校验——helix 不做档位校验（字符串透传，SoT 在 pi-ai，AD-2）
      if (enabled) {
        await ctx.resource.setThinkingSlot(profileKind, name);
        outcome = { status: "applied" };
        changedName = name;
      } else {
        await ctx.resource.clearThinkingSlot(profileKind);
        outcome = { status: "applied" };
        changedName = null;
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
