import type { ProfileKind, ResourceType } from "../outbound/ResourceStatePort";
import type { SkillScanDiagnostic, SkillDescriptor, SkillSource } from "../outbound/SkillSourcePort";

/**
 * 资源配置命令面（inbound，M6 T3 契约 v0.6 agent.config 族）：profile kind
 * 维三类资源配置的读写回口。WS 驱动侧只转发不决策（AG-12）；实现体 =
 * application/services/ResourceService.ts（结构满足，无第二实现）。
 *
 * 语义边界：
 * - 读面 list：合并视图（tools/skills 全集 + 启停态 + 扫描诊断 + model 槽位
 *   现值）——缺省无记录 = 启用；
 * - 写面 setEnabled（tool/skill）：全集内名 → 落库差异行并发布 resources.changed
 *   （T2 刷新链，T2.2 事件化）；全集外名 → 显式跳过（skipped/unknown-name，不落库）；
 * - model 槽位写：setModelSlot / clearModelSlot（本面不校验模型 id——契约
 *   入口 driving 层先经合并目录校验，ModelService.setModel 先例）。
 */
export interface ResourceConfigBlock {
  readonly profileKind: ProfileKind;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly enabled: boolean; readonly snippet: string }>;
  readonly skills: ReadonlyArray<SkillDescriptor & { readonly enabled: boolean }>;
  readonly diagnostics: readonly SkillScanDiagnostic[];
  /** model 槽位现值（未设 = undefined；协议 DTO 映射层转 null）。 */
  readonly model: string | undefined;
}

/** 启停写面结果（协议 AgentConfigSetEnabledResultPayload 的 domain 侧镜像）。 */
export type ResourceToggleOutcome =
  | { readonly status: "applied" }
  | { readonly status: "skipped"; readonly reason: string };

export interface ResourceConfigPort {
  /** 单 kind 配置读面（driving 层按请求 kind 集拼块）。 */
  list(profileKind: ProfileKind): Promise<ResourceConfigBlock>;
  /** tool/skill 启停写面（model 型走槽位 API，调用方分流）。 */
  setEnabled(
    profileKind: ProfileKind,
    resourceType: ResourceType,
    name: string,
    enabled: boolean,
  ): Promise<ResourceToggleOutcome>;
  /** model 槽位写（不校验 id——前置校验在 driving 层）。 */
  setModelSlot(profileKind: ProfileKind, model: string): Promise<void>;
  /** model 槽位清除。 */
  clearModelSlot(profileKind: ProfileKind): Promise<void>;
}
