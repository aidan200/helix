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
import type { StewardMemoryDomain } from "../events/steward";

/** steward.ask 输入来源（additive——addressee 判定触发面的判据）。
 *  "voice-duplex" = 双工常开麦收音段的语音 final：语义有歧义（是叫管家还是
 *  旁人说话），触发 addressee 判定，旁人话语回 dropped 判别静默丢弃；
 *  "voice-manual" = 单轮手动语音（用户显式发起，addressee 无歧义零判定）；
 *  "text" = 文本输入（缺省；显式面向会话零判定）。 */
export type StewardAskSource = "voice-duplex" | "voice-manual" | "text";

/** steward.ask 载荷。 */
export interface StewardAskPayload {
  /** 用户输入文本（空串/超长由 daemon 校验回 error 判别）。 */
  text: string;
  /** 输入来源（additive 可选，缺省 "text"——旧壳零适配）。 */
  source?: StewardAskSource;
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

/** steward.cancel 载荷（B1 两段式确认批，additive）。 */
export interface StewardCancelPayload {
  /** 待作废动作 id（卡片「放弃」时同步 daemon 侧 pending 作废——消灭孤儿
   *  actionId；不存在/已消费 = 幂等静默）。 */
  actionId: string;
}

/** steward.cancel：确认卡作废（全局命令；**无回执帧**——放弃是本地即时
 *  收场，daemon 侧作废是尽力而为的簿记同步，steward.interrupt 同构先例）。
 *  作废后同 actionId 再 confirm 报「已消费」（单次消费语义不变）。 */
export interface StewardCancelCommand extends CommandFrame<StewardCancelPayload> {
  type: "steward.cancel";
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
 *  此处只留开关 + 端点引用（endpointId——指向 embedding.* 域条目）。
 *  **总结配置组已摘除**（会话总结器独立化批①）：summary/sessionMemory 两组
 *  迁 config.set_summary（summary.* 通用域）——携带这两组的载荷回
 *  invalid_payload（协议契约变更，版本严格握手下无版本偏斜窗口）。 */
export interface StewardSetConfigPayload {
  /** 管家开关（默认关；true = 开）。 */
  enabled?: boolean;
  /** 模型槽位（"provider/model-id" 形态，flash 级建议；格式非法回执 error 判别）。 */
  model?: string;
  /** 长期记忆组（管家记忆 B2 瘦身形态；全部位可选。批B 起整体转发通用
   *  记忆配置域 memory.* KV——配置不挂管家名下，本组是写面路由）。 */
  memory?: {
    /** 记忆开关（默认关——记忆是可选项，零依赖开箱）。 */
    enabled?: boolean;
    /** 嵌入端点引用（embedding.* 域端点 id；指向向量 tab 配置的条目）。 */
    endpointId?: string;
    /** 判官端点引用（B4a 自动沉淀：embedding.* 域 kind=classifier 端点 id；
     *  未配置 = 自动沉淀静默不挂——对话主链路零影响）。 */
    judgeEndpointId?: string;
    /** 召回注入条数上限（批B 配置驱动；缺省 5）。类型闸在 daemon（非
     *  number → invalid_payload）；值语义（正整数/topK≤pool）非法由读面
     *  静默回退缺省 + warn——回执现值所见即所得）。 */
    recallTopK?: number;
    /** 召回候选池（批B；缺省 24，上界 200）。同上两段校验分层。 */
    recallPool?: number;
    /** 召回资格闸阈值（additive；缺省 0.3）。值域 [0,1]，非法由读面
     *  静默回退缺省 + warn——回执生效值所见即所得。 */
    recallMinScore?: number;
  };
  /** 分诊判官组（分诊判官接入批，additive；全部位可选）：判定面接
   *  JudgePort（noul 校准概率判定 + 高危判别），生成面纯文本两段制；
   *  开关关/端点未配/判官抛错 → daemon 回退现行 LLM JSON 路径。 */
  triage?: {
    /** 判官判定开关（默认 false = 现行 LLM JSON 判定路径）。 */
    judgeEnabled?: boolean;
    /** 判官端点引用（embedding.* 域 kind=classifier 端点 id；空串 = 清除
     *  引用；悬空/非 classifier 由读面视为未配）。 */
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
  /** 项目作用域（项目隔离批，additive："global" 或项目目录名；缺省按
   *  domain 一致性约束裁定——habit/general → global，domain=project 必绑
   *  具体项目名（显式 projectScope 为项目名唯一显式通道，缺省回落
   *  general+global）。 */
  projectScope?: string;
  /** 业务领域维度（domain 维度批，additive）：habit/general/project；缺省
   *  按 kind 推导（preference→habit、fact→general）或由显式 projectScope
   *  反向隐含 project 域（↔ 约束）。 */
  domain?: StewardMemoryDomain;
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

/** steward.memory_pin 载荷（遗忘机制批：置顶/取消置顶——置顶永不淡忘
 *  永不 GC；置顶隐含解除淡忘并刷新 updatedAt 浮顶）。 */
export interface StewardMemoryPinPayload {
  /** 目标条目 id。 */
  id: number;
  /** true = 置顶（解除淡忘 + 刷新 updatedAt）；false = 取消置顶（不动其他字段）。 */
  pinned: boolean;
}

/** steward.memory_pin：条目置顶切换（回执 steward.memory_list.result）。 */
export interface StewardMemoryPinCommand extends CommandFrame<StewardMemoryPinPayload> {
  type: "steward.memory_pin";
}

/** steward.memory_restore 载荷（遗忘机制批：救回淡忘条目——faded_at
 *  归零 + 刷新 updatedAt 满血复活；active 条目上调用 = 幂等 no-op）。 */
export interface StewardMemoryRestorePayload {
  /** 目标条目 id。 */
  id: number;
}

/** steward.memory_restore：淡忘条目恢复（回执 steward.memory_list.result）。 */
export interface StewardMemoryRestoreCommand extends CommandFrame<StewardMemoryRestorePayload> {
  type: "steward.memory_restore";
}

/** steward.interrupt 载荷（B2 barge-in 批，additive）。 */
export interface StewardInterruptPayload {
  /** 中断原因（可选；缺省 daemon 归一 "barge-in"——审计/trace 语义）。 */
  reason?: string;
}

/** steward.interrupt：在途 steward 轮打断（barge-in 触发面，shell→daemon）——
 *  daemon 侧 StewardService.abortInFlight(reason ?? "barge-in")（幂等 +
 *  abort-and-drain + settleAbortedTurn 截断记账——E-198 语义零改动）。
 *  **无回执帧**（事件面 loop.run.interrupted + steward.ask.result 终态已够
 *  ——设计 docs/temp/helix-duplex-v3-design.md §3.2）。 */
export interface StewardInterruptCommand extends CommandFrame<StewardInterruptPayload> {
  type: "steward.interrupt";
}

// ── 管家活动账（M3-d1 感知兑现批，additive）────────────────────

/** steward.activity.list 时间窗档位（与 query_recent_work 四档同词表 +
 *  all 全量档；缺省 today）。 */
export type StewardActivityRange = "today" | "yesterday" | "this_week" | "all";

/** steward.activity.list 载荷。 */
export interface StewardActivityListPayload {
  /** 时间窗档位（缺省 today——本地时区零点窗口）。 */
  range?: StewardActivityRange;
  /** 条数上限（缺省 200；防御上限 1000）。 */
  limit?: number;
}

/** steward.activity.list：活动账时间窗查询（回执 steward.activity.result
 *  点对点——管家域「活动」时间线页数据源；零记忆降级 = 空清单）。 */
export interface StewardActivityListCommand extends CommandFrame<StewardActivityListPayload> {
  type: "steward.activity.list";
}

/** steward.activity.clear：活动账清理（回执 steward.activity.result——
 *  落盘条目全清后回空窗新态；幂等）。 */
export interface StewardActivityClearCommand extends CommandFrame<Record<string, never>> {
  type: "steward.activity.clear";
}
