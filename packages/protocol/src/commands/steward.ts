/**
 * 文本管家域命令族（V2.5 文本管家批，additive；设计：workspace docs/temp/
 * helix-voice-agent-design.md §2/§5.2/§6 V2.5 行）。
 *
 * 链路：侧栏管家面板 → steward.ask {text} → daemon StewardService LLM 循环
 * （flash 级；只读工具直取 + 写注入唯一原语 propose_send 过确认闸）→
 * steward.ask.result 点对点回执（answer / confirm_required / error 三判别）。
 * 写注入确认闸（§5.2 权限分级）：confirm_required 携带 actionId + 递话内容
 * 摘要，面板渲染确认按钮 → steward.confirm {actionId} → 单次执行
 * （AgentOrchestrationPort.send——agent_send 等价 steer 注入通道）→
 * steward.confirm.result 点对点回执。未确认 = 零执行（actionId 一次性）。
 *
 * - steward.subscribe / steward.unsubscribe：事件 feed 连接级订阅闸门
 *   （voice.subscribe 同构）——feed 文本行仅发已订阅连接（零订阅 = 零推送）；
 * - steward.get_config / steward.set_config：管家设置面（开关默认关 +
 *   模型槽位独立配置；daemon 侧 RuntimeConfig KV 持久化——money gate
 *   服务端权威：开关关 = steward.ask 直接拒答，零 LLM 调用）。
 */
import type { CommandFrame } from "../envelope";

/** steward.ask 载荷。 */
export interface StewardAskPayload {
  /** 用户输入文本（空串/超长由 daemon 校验回 error 判别）。 */
  text: string;
}

/** steward.ask：管家对话一轮（点对点回执 steward.ask.result）。 */
export interface StewardAskCommand extends CommandFrame<StewardAskPayload> {
  type: "steward.ask";
}

/** steward.confirm 载荷。 */
export interface StewardConfirmPayload {
  /** 待确认写动作 id（steward.ask.result confirm_required 分支携带）。 */
  actionId: string;
}

/** steward.confirm：确认闸放行（单次执行对应写注入；点对点回执 steward.confirm.result）。 */
export interface StewardConfirmCommand extends CommandFrame<StewardConfirmPayload> {
  type: "steward.confirm";
}

/** steward.subscribe：事件 feed 连接级订阅登记（断连自动等效）。 */
export interface StewardSubscribeCommand extends CommandFrame<Record<string, never>> {
  type: "steward.subscribe";
}

/** steward.unsubscribe：事件 feed 退订（对称语义）。 */
export interface StewardUnsubscribeCommand extends CommandFrame<Record<string, never>> {
  type: "steward.unsubscribe";
}

/** steward.set_config 载荷（槽位均可选——只更新携带位；管家记忆 B2
 *  memory 组瘦身：端点 CRUD 收编 embedding 配置域（模型页向量 tab），
 *  此处只留开关 + 端点引用（endpointId——指向 embedding.* 域条目）。 */
export interface StewardSetConfigPayload {
  /** 管家开关（默认关；true = 开）。 */
  enabled?: boolean;
  /** 模型槽位（"provider/model-id" 形态，flash 级建议；格式非法回执 error 判别）。 */
  model?: string;
  /** 长期记忆组（管家记忆 B2 瘦身形态；全部位可选）。 */
  memory?: {
    /** 记忆开关（默认关——记忆是可选项，零依赖开箱）。 */
    enabled?: boolean;
    /** 嵌入端点引用（embedding.* 域端点 id；指向向量 tab 配置的条目）。 */
    endpointId?: string;
    /** 判官端点引用（B4a 自动沉淀：embedding.* 域 kind=classifier 端点 id；
     *  未配置 = 自动沉淀静默不挂——对话主链路零影响）。 */
    judgeEndpointId?: string;
  };
}

/** steward.set_config：写管家设置（点对点回执 steward.config.result 新态）。 */
export interface StewardSetConfigCommand extends CommandFrame<StewardSetConfigPayload> {
  type: "steward.set_config";
}

/** steward.get_config：读管家设置（点对点回执 steward.config.result）。 */
export interface StewardGetConfigCommand extends CommandFrame<Record<string, never>> {
  type: "steward.get_config";
}

/** steward.history 载荷（A1 工作记忆批，additive）。 */
export interface StewardHistoryPayload {
  /** true = 清空工作记忆（「新对话」：KV + daemon LLM 窗口 + 前端三处同清；
   *  缺省 false = 只读回放）。 */
  clear?: boolean;
}

/** steward.history：工作记忆读/清（点对点回执 steward.history.result——
 *  回放链路：面板打开 → 读 KV → UI 渲染与 LLM 窗口同源重建）。 */
export interface StewardHistoryCommand extends CommandFrame<StewardHistoryPayload> {
  type: "steward.history";
}

/** steward.memory_list：长期记忆条目读面（管家记忆 B2；回执
 *  steward.memory_list.result——四命令共用：append/update/delete 写后
 *  即回新清单，与 embedding 族回执同构）。 */
export interface StewardMemoryListCommand extends CommandFrame<Record<string, never>> {
  type: "steward.memory_list";
}

/** steward.memory_append 载荷（管家记忆 B2：人工新增条目——走 embed 入库）。 */
export interface StewardMemoryAppendPayload {
  /** 记忆文本（非空；daemon 校验）。 */
  text: string;
  /** 条目类别（缺省 "fact"；枚举对齐存储面既有 kind 值）。 */
  kind?: "fact" | "preference";
}

/** steward.memory_append：人工新增记忆（回执 steward.memory_list.result）。 */
export interface StewardMemoryAppendCommand extends CommandFrame<StewardMemoryAppendPayload> {
  type: "steward.memory_append";
}

/** steward.memory_update 载荷（管家记忆 B2：重嵌更新——文本改写后重新
 *  向量化）。 */
export interface StewardMemoryUpdatePayload {
  /** 目标条目 id。 */
  id: number;
  /** 新文本。 */
  text: string;
}

/** steward.memory_update：条目文本更新（回执 steward.memory_list.result）。 */
export interface StewardMemoryUpdateCommand extends CommandFrame<StewardMemoryUpdatePayload> {
  type: "steward.memory_update";
}

/** steward.memory_delete 载荷（管家记忆 B2：行级删除）。 */
export interface StewardMemoryDeletePayload {
  /** 目标条目 id。 */
  id: number;
}

/** steward.memory_delete：条目删除（回执 steward.memory_list.result）。 */
export interface StewardMemoryDeleteCommand extends CommandFrame<StewardMemoryDeletePayload> {
  type: "steward.memory_delete";
}
