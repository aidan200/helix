import { MODES, DEFAULT_MODE_ID, type ModeId } from "@helix/protocol";

/**
 * daemon 模式注册表消费单点（P1 会话模式框架 T3，mode-framework-p1）。
 *
 * 唯一注册表 = @helix/protocol modes.ts（T2 约定：daemon 不另建平行
 * 注册表）；本模块是 daemon 侧的**消费**单点——mode wire 面一律 string
 * 透传（AD-2），协议层不校验注册表成员资格，未知/缺省 mode 在此 fallback
 * DEFAULT_MODE_ID。
 *
 * 分层落位裁决：domain 禁 import @helix/protocol（AG-02 白名单仅
 * @helix/common——kg 架构规则），故本模块落 application/services
 * （@helix/protocol 在 application 白名单三项内）；domain Session 聚合只
 * 携带 mode 原始 string（快照往返），语义解析统一走本单点。
 */

/** 注册表条目的 profileKind 联合（类型级：注册表扩条目自动跟随；P1 = "main-session"）。 */
export type ModeProfileKind = (typeof MODES)[number]["profileKind"];

/**
 * mode 解析为注册表成员 id：缺省/空串/未知 → DEFAULT_MODE_ID（语义单点
 * fallback；建会话定格落库前调用——session.mode 恒为注册表成员 id）。
 */
export function resolveModeId(mode: string | undefined): ModeId {
  if (mode === undefined || mode === "") return DEFAULT_MODE_ID;
  return (MODES.find((m) => m.id === mode)?.id ?? DEFAULT_MODE_ID) as ModeId;
}

/**
 * mode → 建会话链消费的 profileKind（agent 槽位绑定）：经 resolveModeId
 * 归一后查注册表——未知/缺省 → default 条目的 profileKind（P1 恒
 * "main-session"）。engineFor 槽位 kind（modelSlot/thinkingSlot）与快照
 * 主实例 profileKind 的取值单点。
 */
export function profileKindOf(mode: string | undefined): ModeProfileKind {
  const id = resolveModeId(mode);
  return MODES.find((m) => m.id === id)!.profileKind;
}
