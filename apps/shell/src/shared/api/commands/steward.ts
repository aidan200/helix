/**
 * shared/api/commands/steward —— steward 域（对话/确认闸/feed 订阅/设置面 + 长期记忆条目 + 活动账）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  StewardAskCommand,
  StewardAskSource,
  StewardCancelCommand,
  StewardConfirmCommand,
  StewardGetConfigCommand,
  StewardHistoryCommand,
  StewardInterruptCommand,
  StewardJudgeStopIntentCommand,
  StewardMemoryAppendCommand,
  StewardMemoryDeleteCommand,
  StewardMemoryDomain,
  StewardMemoryListCommand,
  StewardMemoryPinCommand,
  StewardMemoryRestoreCommand,
  StewardMemoryUpdateCommand,
  StewardSetConfigCommand,
  StewardSetConfigPayload,
  StewardSubscribeCommand,
  StewardUnsubscribeCommand,
  StewardActivityListCommand,
  StewardActivityClearCommand,
  StewardActivityRange,
} from "@helix/protocol";

// ── steward 族命令（V2.5 文本管家）：对话 + 确认闸 + feed 订阅 + 设置面 ──
// 回执 = steward.ask.result / confirm.result / config.result 点对点；
// feed 文本行经 steward.feed 广播（仅已订阅连接收）。

/** steward.ask：对话一轮（全局命令；五判别回执 answer/confirm_required/queued/dropped/error）。 */
export function stewardAskCommand(text: string, source?: StewardAskSource): StewardAskCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.ask",
    payload: { text, ...(source !== undefined ? { source } : {}) },
  };
}

/** steward.confirm：确认闸放行（actionId 单次消费；全局命令）。 */
export function stewardConfirmCommand(actionId: string): StewardConfirmCommand {
  return { v: PROTOCOL_VERSION, type: "steward.confirm", payload: { actionId } };
}

/** steward.cancel：确认卡作废（B1 两段式确认批；全局命令；无回执帧——
 *  放弃是本地即时收场，daemon 侧 pending 簿记同步，interrupt 同构先例）。 */
export function stewardCancelCommand(actionId: string): StewardCancelCommand {
  return { v: PROTOCOL_VERSION, type: "steward.cancel", payload: { actionId } };
}

/** steward.subscribe：事件 feed 连接级订阅登记（全局命令）。 */
export function stewardSubscribeCommand(): StewardSubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "steward.subscribe", payload: {} };
}

/** steward.unsubscribe：feed 退订（断连自动等效；全局命令）。 */
export function stewardUnsubscribeCommand(): StewardUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "steward.unsubscribe", payload: {} };
}

/** steward.get_config：设置读面（全局命令；回执 steward.config.result）。 */
export function stewardGetConfigCommand(): StewardGetConfigCommand {
  return { v: PROTOCOL_VERSION, type: "steward.get_config", payload: {} };
}

/** 槽位载荷 undefined 键剥离（缺省不携带键——帧噪音最小化）：手维护逐字段
 * 白名单的泛化替身。白名单坑型两复发（memory B2 批 / summary 语音播报摘要
 * 批）：新增槽位漏进白名单即出门被剥成 {}，daemon 收空补丁回执原样，UI
 * 受控勾选框点了弹回；透传变量逃过 TS 超属性检查编译零报错——TR-159
 * 命令路径实例。SoT 载荷类型直收 + 本替身后新增配置组自动透传零维护。 */
function stripUndefinedSlots<T extends object>(patch: T): T {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as T;
}

/** steward.set_config：设置写面（槽位均可选——只更新携带位；全局命令；
 * 管家记忆 B2 memory 组瘦身——{enabled?,endpointId?}（端点 CRUD 收编
 * embedding 配置域，endpointId 引用其条目）；B4a +judgeEndpointId
 * （classifier 端点引用——判官自动沉淀）；语音播报摘要批 +summary
 * {enabled?,model?}（独立槽位——无默认模型）。参数直收协议 SoT 载荷类型。 */
export function stewardSetConfigCommand(patch: StewardSetConfigPayload): StewardSetConfigCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.set_config",
    payload: stripUndefinedSlots(patch),
  };
}

/** steward.history：工作记忆读/清（A1 批；clear=true 新对话三处同清；
 *  回执 steward.history.result 携完整记录数组——回放同源）。 */
export function stewardHistoryCommand(clear?: boolean): StewardHistoryCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.history",
    payload: clear === true ? { clear: true } : {},
  };
}

/** steward.interrupt：在途轮打断（B2 barge-in 批；批 3b 增 scope——缺省
 *  current 轻停只停当前轮；all = 全停 abort 当前 + 清空 daemon ask 队列，
 *  语音停止判定通道；无回执帧，事件面 loop.run.interrupted + ask 终态已够）。 */
export function stewardInterruptCommand(reason?: string, scope?: "current" | "all"): StewardInterruptCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.interrupt",
    payload: {
      ...(reason === undefined ? {} : { reason }),
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

/** steward.judge_stop_intent：停止意图判定（Jev 单轨——停止词表退役批，
 *  回执 steward.judge_stop_intent.result 点对点）。判定语义归 daemon 判官
 *  （零生成 token 分类判定）；判不出（降级/超时/不可达）的 fail-stop 归
 *  消费面（shell 打断链判不出=真停）。 */
export function stewardJudgeStopIntentCommand(text: string): StewardJudgeStopIntentCommand {
  return { v: PROTOCOL_VERSION, type: "steward.judge_stop_intent", payload: { text } };
}

// ── 管家记忆 B2：长期记忆条目管理（读/人工新增/重嵌更新/行级删除；四命令
//    共用回执 steward.memory_list.result——写后即回新清单）────────────

/** steward.memory_list：条目读面（全局命令；回执 steward.memory_list.result）。 */
export function stewardMemoryListCommand(): StewardMemoryListCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_list", payload: {} };
}

/** steward.memory_append：人工新增（embed 入库；kind 缺省 fact；domain
 *  缺省按 kind 推导（preference→habit、fact→general），projectScope =
 *  项目名显式通道（与 domain=project 配对）——逐字段透传 TR-159）。 */
export function stewardMemoryAppendCommand(
  text: string,
  kind?: "fact" | "preference",
  domain?: StewardMemoryDomain,
  projectScope?: string,
): StewardMemoryAppendCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.memory_append",
    payload: {
      text,
      ...(kind !== undefined ? { kind } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(projectScope !== undefined && projectScope.trim() !== "" ? { projectScope } : {}),
    },
  };
}

/** steward.memory_update：条目文本更新（重嵌；回执新清单）。 */
export function stewardMemoryUpdateCommand(id: number, text: string): StewardMemoryUpdateCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_update", payload: { id, text } };
}

/** steward.memory_delete：行级删除（回执新清单）。 */
export function stewardMemoryDeleteCommand(id: number): StewardMemoryDeleteCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_delete", payload: { id } };
}

/** steward.memory_pin：置顶切换（遗忘机制批；置顶永不淡忘永不 GC；
 *  置顶隐含解除淡忘 + 刷 updatedAt 浮顶；回执新清单）。 */
export function stewardMemoryPinCommand(id: number, pinned: boolean): StewardMemoryPinCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_pin", payload: { id, pinned } };
}

/** steward.memory_restore：淡忘条目恢复（遗忘机制批；active 条目幂等
 *  no-op；回执新清单）。 */
export function stewardMemoryRestoreCommand(id: number): StewardMemoryRestoreCommand {
  return { v: PROTOCOL_VERSION, type: "steward.memory_restore", payload: { id } };
}

// ── 管家活动账（M3-d1 感知兑现批）：时间线页数据源 ──────────────────
// 回执 = steward.activity.result（list/clear 两命令共用）；实时帧
// steward.activity 经 subscribeStewardFrames 消费。

/** steward.activity.list：时间窗查询（range 缺省 today；limit 缺省 200）。 */
export function stewardActivityListCommand(range?: StewardActivityRange, limit?: number): StewardActivityListCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "steward.activity.list",
    payload: {
      ...(range !== undefined ? { range } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  };
}

/** steward.activity.clear：落盘条目全清（回执空窗新态；幂等）。 */
export function stewardActivityClearCommand(): StewardActivityClearCommand {
  return { v: PROTOCOL_VERSION, type: "steward.activity.clear", payload: {} };
}
