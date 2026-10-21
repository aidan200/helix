/**
 * 管家行为常量面（体量门 P4：自 StewardService.ts 原样迁出）。
 *
 * 值不双写：时间参数类常量是 StewardTuning 缺省值的 re-export（KV
 * steward.tuning.* 运行期即热，见 E-287/E-240）；其余为协议/文案/预算常量。
 * 门面 StewardService.ts 精确再导出——消费方 import 路径与符号零变化。
 */
import { STEWARD_TUNING_DEFAULTS } from "../../domain/steward/tuning/StewardTuning";

/** 工具轮上限（成本护栏：连环工具调用熔断——超限 error 判别，不无限循环）。 */
export const STEWARD_MAX_TOOL_ROUNDS = 6;

/** 会话内对话滚动窗口（旧制；A1 批被工作记忆 KV token 预算闸取代——
 *  常量保留供历史注释面参照，不再参与裁剪）。 */
export const HISTORY_WINDOW = 24;

/** 工具结果送 LLM 前的体量上限（A1-hotfix；生产实证单条 list_instances
 *  toolResult 可达 537,026 字符 ≈ 27 万 token = 16k 预算的 17 倍——病理体量
 *  直达上下文会挤掉全部对话并触发裁剪而毒孤儿）。 */
export const TOOL_RESULT_MAX_CHARS = 4000;

/** 截断标记（用户可见面：完整结果体积看过程帧摘要）。 */
export const TOOL_RESULT_TRUNCATION_MARK = "…（已截断，完整结果见过程帧）";

/** list_instances 紧凑投影：active 实例 task/summary 截断上限。 */
export const INSTANCE_TASK_MAX_CHARS = 120;

/** list_instances 紧凑投影：非 active 实例 summary 截断上限。 */
export const INSTANCE_SUMMARY_MAX_CHARS = 80;

/** 合成 toolResult 文本（A1-hotfix：assistant 含 toolCall 但结果缺席——
 *  窗口裁剪切掉结果/确认闸挂起无结果，OpenAI 兼容 API 同样 400 拒）。 */
export const STEWARD_MISSING_TOOL_RESULT_TEXT = "（工作记忆窗口裁剪致结果缺失）";

/** 管家开关 KV 键（RuntimeConfigPort；"1" = 开，其余 = 关——默认关）。 */
export const STEWARD_ENABLED_KEY = "steward.enabled";

/** 管家模型槽位 KV 键（"provider/model-id"；未设置 = adapter 默认）。 */
export const STEWARD_MODEL_KEY = "steward.model";

/** 总结配置域（summary.*——三产物开关/锚点节奏/总结模型 + 任务总结两键）
 *  已收编通用域：键位/解析/迁移单源 ../summary/summaryConfig.ts（管家配置
 *  零总结项——steward.set_config 摘除 summary/sessionMemory 组，写面在
 *  config.set_summary）。 */

/** L1 件一：压缩触发阈值（token 估算口径与 estimateLoopTokens 同族；
 *  任务书默认 12k——低于工作记忆 16k 预算闸，压缩先于粗裁剪接管）。 */
export const STEWARD_COMPACTION_THRESHOLD_TOKENS = 12_288;

/** L1 件一：压缩尾部滚动窗（条数——TR-47：压的是历史不是工作集）。 */
export const STEWARD_COMPACTION_KEEP_RECENT = 6;

/** L1 件二：输入缓冲 pending 队列上限（忙碌态入队不拒绝；超限提示）。
 *  批 0（DDD 重构）起：缺省单源 StewardTuning（KV steward.tuning.ask.queueMax
 *  可改）——此处 re-export 兼容既有引用，值不双写。 */
export const STEWARD_PENDING_ASKS_MAX = STEWARD_TUNING_DEFAULTS.ask.queueMax;

/** ── 管家可靠性批时间参数（批 0 起全部进 StewardTuning 配置域——KV
 *  steward.tuning.* 运行期可改、非法静默回退缺省；下列导出为缺省值 re-export
 *  （兼容既有引用，值不双写）。原「配置面不做——M4 统一做」裁决已被 DDD
 *  重构批 0 推翻（设计文档 §3.3：语音/文字双场景容忍度不同，阈值须可配）。 ──
 *  事故链：write 档挂闸无人确认 → runActive 永真 → finishRun 永不执行 →
 *  后续 ask 永远 queued → 管家对一切输入装死且零日志。三要素对三参数： */

/** run 看门狗阈值：run 内无事件推进持续此时长 → abort 在途轮 + 挂起通知
 *  （缺省 180s——事故中 20 分钟装死的兑底上限；活跃 run 每事件重置计时）。 */
export const STEWARD_RUN_WATCHDOG_MS = STEWARD_TUNING_DEFAULTS.run.watchdogMs;

/** run 看门狗巡检间隔（生产 interval；测试直接调 reliabilityTick 注入时钟）。 */
export const STEWARD_RUN_WATCHDOG_TICK_MS = STEWARD_TUNING_DEFAULTS.run.watchdogTickMs;

/** 看门狗 abort 宽限窗：abort 后仍 runActive 持续此时长 → 强制收口 + 引擎
 *  重建（pi EventStream 不竞速 abort signal——挂死的 provider 流 abort 后
 *  run promise 仍永悬，必须弃引擎重建；缺省 180+15=195s < 5 分钟自愈口径）。 */
export const STEWARD_RUN_WATCHDOG_ABORT_GRACE_MS = STEWARD_TUNING_DEFAULTS.run.watchdogAbortGraceMs;

/** 手动 abort 快进宽限（手动停止批）：abortInFlight 后此时长仍 runActive
 *  （挂死流 abort 打不醒——E-240 实测）→ 快进强制收口（弃引擎重建）。被动
 *  看门狗 195s 对语音交互太慢（2026-10-09 事故）；缺省 8s 恢复。 */
export const STEWARD_MANUAL_ABORT_GRACE_MS = STEWARD_TUNING_DEFAULTS.run.manualAbortGraceMs;

/** 确认卡 TTL：pending 挂闸无人 confirm/cancel 持续此时长 → 自动作废（复用
 *  cancel 内部语义——删除即作废；缺省 300s）。 */
export const STEWARD_CONFIRM_TTL_MS = STEWARD_TUNING_DEFAULTS.confirm.ttlMs;

/** 确认卡可达性提醒：confirm_required 发出后无人消费持续此时长 → 提醒帧
 *  （缺省 30s——事故中确认卡入口不可见，提醒是第二入口）。 */
export const STEWARD_CONFIRM_REMIND_AFTER_MS = STEWARD_TUNING_DEFAULTS.confirm.remindAfterMs;

/** 确认超时作废的 action.completed detail 文案（用户与 LLM 共同可见）。 */
export const STEWARD_CONFIRM_TIMEOUT_DETAIL = "确认超时（超时无人确认，已自动作废——如仍需要请重新提出）";

/** ── 确认链路修复批（2026-10-06 12:13-12:28 事故）：口令路由词表 + 登记簿 ──
 * 事故定性：用户每次重述 → 管家新提案 → 新卡（六卡并存）；「确认了很多遍」
 * 被当新指令又弹卡；已送达后又陆续弹失效通知。三件根治：在途提案登记簿
 * （弹卡出口唯一）、确认口令路由（词表绑定最近 pending 卡）、终局收敛
 * （同 key 其余卡静默撤除）。 */

// ── 确认类/取消类口令词表已单源化至 @helix/protocol stewardPhrases（闸门
// 对应修复批：双端词族同源——STEWARD_CONFIRM_PHRASES 8 词 / STEWARD_CANCEL_
// PHRASES 3 词，历史文案见 git；扩改词表双端同改不再手工同步）。在途 run
// 判官判停 → 全停（abort 当前 + 清空排队，回执携丢弃条数；停止判定单源
// = Jev 停止意图判官——停止词表已退役）；无在途原样走 LLM（停止判定仅
// 在场触发——TR-240 同款纪律）；与确认口令词表互斥：「取消」是卡作废口令，
// 判官判停是 run 全停，语义分层不互吞。

// 登记簿 key 计算（pendingKeyOf）与终局登记簿上限（STEWARD_PROPOSAL_REGISTRY_MAX）
// 已迁确认闸聚合域（domain/steward/confirmation/ProposalLedger.ts——批 1）。

/** ── A2 批：动态情景快照段 ───────────────────────────────
 *  内容预算（字符级硬顶；中文 ~600 字符 ≈ 400-600 token，满足 brief
 *  ≤600 token 口径）：当前时间一行 + 活跃 agent/会话计数两行 + 最近
 *  1-2 个会话主题一行。 */
export const CONTEXT_SNAPSHOT_MAX_CHARS = 600;

/** 快照段内会话主题标题截断上限（标题级——不进正文）。 */
export const SNAPSHOT_TITLE_MAX_CHARS = 16;

/** 快照段「最近会话」行数上限。 */
export const SNAPSHOT_RECENT_SESSIONS = 2;

/** ── M3-d1：ask 对话投影（活动段常量）──────────────────────────
 *  ring 最近活动条目（账本白话行）→ context_snapshot 活动段；行数在
 *  brief 建议 8~12 区间取中，字符预算独立于基础段（双预算防截断互他）。 */

/** 活动段条数上限（8~12 建议区间取中——感知现场够用且不挤占上下文）。 */
export const SNAPSHOT_ACTIVITY_MAX_ENTRIES = 10;

/** 活动段单行截断上限（白话句一行密度面）。 */
export const SNAPSHOT_ACTIVITY_LINE_MAX_CHARS = 46;

/** 活动段整体字符预算（防御性硬顶——与基础段 600 双预算分轨）。 */
export const SNAPSHOT_ACTIVITY_MAX_CHARS = 480;

/** 活动域标签（域枚举 → 中文短词——投影行文与时间线同源）。 */
export const SNAPSHOT_ACTIVITY_DOMAIN_LABELS: Record<string, string> = {
  task: "任务",
  session: "会话",
  agent: "帮手",
  surface: "界面",
  cli: "终端",
  notify: "通知",
};

/** query_recent_work 单类行数上限（体量自律：A1-hotfix 4000 护栏之外再
 *  自律——多行时尾部「另有 N 个未列出」收口）。 */
export const RECENT_WORK_LINES_MAX = 8;

/** query_recent_work 会话主题/任务标题截断上限（每条一行紧凑口径）。 */
export const RECENT_WORK_TITLE_MAX_CHARS = 20;

/** 投递回执短标题截断上限（码点）。 */
export const DELIVER_TITLE_MAX_CHARS = 24;

/** 在途提案段行数上限（体量自律——多卡时尾部「另有 N 个」收口）。 */
export const PENDING_PROPOSALS_MAX_ITEMS = 4;

/** 确认闸挂闸工具集（write 类——提案制：LLM 只能提案，人工确认后才执行；
 *  act 为 risk 动态档——read 直行/write·destructive 挂闸，判定在
 *  gateSurfaceAct）。 */
export const GATED_TOOLS: ReadonlySet<string> = new Set([
  "propose_send",
  "deliver_to_session",
  "create_session",
  "start_session",
  "spawn_review_task",
  "act",
  // remember 已摘闸（B5：记忆写入静默化——工具调用即入库 + memory_written
  // 通知，不再挂确认卡；防误吞闸仍由 directRemember 内校验承担）。
]);
