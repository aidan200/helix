/**
 * steward 族事件（V2.5 文本管家批，additive；新 Channel 值 "steward"——
 * 扩展纪律：新增族 = additive，不动分发器，"voice" 族先例同构口径）。
 *
 * 四帧（§5.3 ①②层口径：feed 文本行模板直出不进 LLM）：
 * - steward.ask.delta = steward.ask 流式增量帧（V2.5 体验批 additive：
 *   文本生成段逐 chunk 下发，前端聚合——终态以 steward.ask.result 为权威
 *   覆盖；工具执行段静默不发）；
 * - steward.ask.result = steward.ask 点对点回执（三判别：answer 直答 /
 *   confirm_required 确认闸请求 / error 业务失败）；
 * - steward.confirm.result = steward.confirm 点对点回执（ok/error）；
 * - steward.feed = 事件 feed 文本行广播（daemon→已订阅连接——agent 生命
 *   周期事件模板直出，复用事件流零新事件源）；
 * - steward.config.result = 设置读写回执（enabled + model 现态）。
 */
import type { EventFrame } from "../envelope";

/** steward.ask.result payload：四判别——answer = 直答文本；confirm_required =
 *  确认闸请求（写注入唯一原语 propose_send 的回执形态，未确认零执行）；
 *  queued = 忙碌态入队确认（L1 件二：本轮工具循环收口后自动作为下一轮
 *  输入，结果帧随后另发）；error = 业务失败（开关关/模型未配/key 缺失/
 *  循环超限等，reason 含引导）。 */
export type StewardAskResultPayload =
  | {
      status: "answer";
      /** 管家回答文本（快问快答直答产物）。 */
      text: string;
    }
  | {
      status: "confirm_required";
      /** 待确认动作 id（steward.confirm 消费；一次性）。 */
      actionId: string;
      /** 递话目标实例（agent-<串>）。 */
      agentId: string;
      /** 递话内容（注入前用户可全文过目——确认闸透明性）。 */
      message: string;
    }
  | {
      status: "queued";
      /** 排队标记（恒 true——帧面判别冗余锚，便于旧 UI 防守卫式过滤）。 */
      queued: true;
      /** 队内位置（1 起——首条即将被消费）。 */
      position: number;
    }
  | {
      status: "error";
      /** 失败原因（含引导，如开关关时指向设置页开启路径）。 */
      reason: string;
    };

/** steward.ask.result：管家对话回执（channel = "steward"）。 */
export interface StewardAskResultEvent extends EventFrame<StewardAskResultPayload> {
  channel?: "steward";
  type: "steward.ask.result";
}

/** steward.ask.delta payload：流式增量帧（V2.5 体验批 additive）。语义 =
 *  增量 delta + 前端聚合（与主聊天 chat.stream.delta 同构——非累计文本，
 *  帧序即到达序，WS 有序传输下前端直接拼接）；终态以 steward.ask.result
 *  为权威（answer.text 全量覆盖聚合缓冲，delta 不落盘不持久化）。 */
export interface StewardAskDeltaPayload {
  /** 本帧增量文本（非累计——前端聚合）。 */
  delta: string;
  /** 单次 ask 内单调顺序号（1 起；排序/丢帧检测面，不携带 messageId——
   *  管家面板单飞在途（askInFlight 互斥），无多轮并发歧义）。 */
  seq: number;
}

/** steward.ask.delta：管家回答流式增量帧（channel = "steward"；仅文本
 *  生成段逐 chunk 下发，工具执行段静默不发；点对点发发起 ask 的连接）。 */
export interface StewardAskDeltaEvent extends EventFrame<StewardAskDeltaPayload> {
  channel?: "steward";
  type: "steward.ask.delta";
}

/** steward.confirm.result payload：三判别——accepted = **已受理**（B1 两段式：
 *  消费 actionId 后立即回——执行体异步启动，完成另发
 *  steward.action.completed；idle 目标全轮不再阻塞确认链）；ok = 已执行
 *  （B1 前旧判别——类型保留 additive 兼容，新 daemon 不再产出）；error =
 *  业务失败（actionId 未知/已消费/已作废）。 */
export type StewardConfirmResultPayload =
  | {
      status: "accepted";
      /** 已受理动作 id 回显（卡片三态 awaiting→accepted 的判别锚）。 */
      actionId: string;
    }
  | {
      status: "ok";
      /** 递话目标实例回显。 */
      agentId: string;
      /** 注入通道回执说明（SendOutcome.detail——已投递/拒绝原因）。 */
      detail: string;
    }
  | {
      status: "error";
      /** 失败原因。 */
      reason: string;
    };

/** steward.confirm.result：确认闸执行回执（channel = "steward"）。 */
export interface StewardConfirmResultEvent extends EventFrame<StewardConfirmResultPayload> {
  channel?: "steward";
  type: "steward.confirm.result";
}

/** steward.action.completed payload（B1 两段式第二段）：确认动作执行完成
 *  回执——confirm 受理（accepted）后异步执行体收口时点对点下发；成败两路
 *  均发（ok=false 时 detail 含失败原因——错误交代面从 confirm.result 的
 *  error 判别迁出，受理后不再复用 error 通道）。 */
export interface StewardActionCompletedPayload {
  /** 已完成动作 id（与 confirm_required/sediment_proposal 的 actionId 同源）。 */
  actionId: string;
  /** 执行成败（executePending outcome.ok）。 */
  ok: boolean;
  /** 结果说明（用户与 LLM 共同可见的回执文本——成功详情/失败原因）。 */
  detail: string;
}

/** steward.action.completed：确认动作执行完成帧（channel = "steward"；
 *  点对点——发回发起 steward.confirm 的连接）。 */
export interface StewardActionCompletedEvent extends EventFrame<StewardActionCompletedPayload> {
  channel?: "steward";
  type: "steward.action.completed";
}

/** 触发 feed 行的领域事件判别（agent 生命周期事件流子集）。 */
export type StewardFeedKind =
  | "agent.spawned"
  | "agent.completed"
  | "agent.failed"
  | "agent.killed"
  | "agent.parked"
  | "agent.resumed";

/** steward.feed payload：事件 feed 文本行（一帧一行；模板直出不进 LLM）。 */
export interface StewardFeedPayload {
  /** 触发事件类型（agent 生命周期子集）。 */
  kind: StewardFeedKind;
  /** 触发实例 id（agent-<串>）。 */
  agentId: string;
  /** feed 文本行（中文模板直出；closure 摘要已截断）。 */
  text: string;
  /** 连接内单调顺序号（1 起；shell 侧顺序保障/丢帧检测面）。 */
  seq: number;
}

/** steward.feed：feed 文本行广播帧（channel = "steward"；仅发已订阅连接）。 */
export interface StewardFeedEvent extends EventFrame<StewardFeedPayload> {
  channel?: "steward";
  type: "steward.feed";
}

/** steward.memory_written payload：记忆落盘通知（B5 静默化——remember
 *  工具与自动沉淀管线均直写入库，落盘后广播本通知；UI 通知卡展示，无确认
 *  语义、无操作面）。 */
export interface StewardMemoryWrittenPayload {
  /** 落盘记忆文本（LLM 重写后的记忆句——通知卡展示全文或截断由 UI 定）。 */
  text: string;
  /** 落盘形态：added = 新增条目 / updated = 覆盖更新既有条目（语义重复）。 */
  mode: "added" | "updated";
}

/** steward.memory_written：记忆落盘通知广播帧（channel = "steward"；
 *  仅发已订阅连接——与 feed 同订阅闸）。 */
export interface StewardMemoryWrittenEvent extends EventFrame<StewardMemoryWrittenPayload> {
  channel?: "steward";
  type: "steward.memory_written";
}

/** steward.config.result payload：设置现态（读/写共用回执形态）。 */
export interface StewardConfigResultPayload {
  /** 管家开关现态（默认 false）。 */
  enabled: boolean;
  /** 模型槽位现值（"provider/model-id"；未设置 = daemon 默认 flash 级模型）。 */
  model: string;
  /** 任务总结面现态（语音播报摘要子功能）：enabled 开关 + 专用模型槽位
   *  （未配置 = null——**无默认模型**，不配不摘要，播报走极简终态通知）。 */
  summary: {
    /** 任务总结开关现态（默认 false）。 */
    enabled: boolean;
    /** 总结模型槽位现值（"provider/model-id"；未配置 = null）。 */
    model: string | null;
  };
  /** 长期记忆面现态（管家记忆 B2 瘦身：endpoint 为引用态——只回 id/name/
   *  model/hasApiKey，baseUrl 不再回传；端点全集经 embedding.list 读）。 */
  memory: {
    /** 记忆开关现态（默认 false——可选项，零依赖开箱）。 */
    enabled: boolean;
    /** 综合可用性（开关开 ∧ endpointId 有效 ∧ 条目完整 ∧ 存储已装配——
     *  召回/写入真实门槛）。 */
    available: boolean;
    /** 当前引用端点（引用态：id/name/model/hasApiKey；未引用或条目已删 = null）。 */
    endpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
    /** 当前判官端点引用（B4a 自动沉淀；kind=classifier 引用态；未引用/条目已删/非 classifier = null）。 */
    judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
    /** 记忆条目总数。 */
    entryCount: number;
    /** 当前向量维度（未初始化 = null）。 */
    dim: number | null;
  };
  /** 会话进展记忆面现态（progress 批，additive——旧 shell 忽略无损）。 */
  sessionMemory?: {
    /** 会话进展记忆开关现态（默认 false）。 */
    enabled: boolean;
    /** 节流阈值现态（每 N 完成轮产一次；默认 3）。 */
    everyTurns: number;
    /** 总结模型槽位现值（"provider/model-id"；未配置 = null——无默认，
     *  不配不产 progress；联合调用槽位回落链 → topic_config.model）。 */
    model: string | null;
  };
}

/** steward.config.result：设置读写回执（channel = "steward"；点对点）。 */
export interface StewardConfigResultEvent extends EventFrame<StewardConfigResultPayload> {
  channel?: "steward";
  type: "steward.config.result";
}

/**
 * 管家工作记忆记录（A1 工作记忆批，additive）——完整记录形态：
 * thinking / toolCall / toolResult / user / assistant 全形态（用户裁决：
 * 全精度进 LLM 上下文与工作记忆；屏幕完整显示，耳朵只听 assistant 结论）。
 *
 * 同源链路：KV steward_dialog（daemon）↔ steward.history.result 回执 ↔
 * 面板 UI 渲染 ↔ LLM 窗口重建——UI 显示的 = LLM 记得的（消灭撒谎错位）。
 * - assistant.thinking 携 signature（provider 不透明回传凭据——Anthropic 式
 *   最严约束：多轮 thinking 块须携签名回传）；
 * - toolCall/toolResult 按 id 配对（UI 工具行 pending → ✓ 两态）。
 */
export type StewardHistoryRecord =
  | {
      kind: "user";
      /** 用户输入全文。 */
      text: string;
      /** 落笔时间戳（ms；TTL/排序面）。 */
      at: number;
      /** L1 件一：压缩摘要合成记录标记（synthesized——非用户真实输入；
       *  UI 可据此渲染压缩行，LLM 窗口重建与普通 user 同构）。 */
      compaction?: true;
    }
  | {
      kind: "assistant";
      /** 回答文本（可缺席——纯工具轮/纯思考轮）。 */
      text?: string;
      /** 本轮 thinking 块（全精度；signature = provider 回传凭据）。 */
      thinking?: { text: string; signature?: string };
      /** 本轮工具调用（可缺席——纯文本轮）。 */
      toolCall?: { id: string; name: string; args: Record<string, unknown> };
      at: number;
    }
  | {
      kind: "toolResult";
      /** 配对工具调用 id。 */
      toolCallId: string;
      /** 工具名（回显面）。 */
      name: string;
      /** 工具结果文本（LLM 回灌原文）。 */
      text: string;
      at: number;
    };

/** steward.history.result payload：工作记忆回放（records 全形态数组；
 *  clear 后回空数组）。 */
export interface StewardHistoryResultPayload {
  /** 完整记录（时序；daemon KV 同源镜像）。 */
  records: readonly StewardHistoryRecord[];
}

/** steward.history.result：工作记忆读/清回执（channel = "steward"；点对点）。 */
export interface StewardHistoryResultEvent extends EventFrame<StewardHistoryResultPayload> {
  channel?: "steward";
  type: "steward.history.result";
}

/** steward.tool payload（A1 过程可见批，additive）：工具执行两相帧——
 *  start（name + 参数摘要）/ end（结果摘要）；单次 ask 内 seq 单调（1 起）
 *  与 ask.delta 同口径，仅发发起 ask 的连接（点对点）。 */
export type StewardToolPayload =
  | {
      phase: "start";
      /** 工具名（如 list_tasks）。 */
      name: string;
      /** 参数摘要（JSON 短串；防御性截断）。 */
      argsSummary: string;
      seq: number;
    }
  | {
      phase: "end";
      /** 工具名（与 start 帧配对）。 */
      name: string;
      /** 结果摘要（截断短串——展开详情的摘要面）。 */
      resultSummary: string;
      seq: number;
    };

/** steward.tool：工具过程帧（channel = "steward"；点对点——屏幕通道）。 */
export interface StewardToolEvent extends EventFrame<StewardToolPayload> {
  channel?: "steward";
  type: "steward.tool";
}

/** steward.thinking payload（A1 过程可见批，additive）：thinking 段级帧——
 *  一个完成态 thinking 块一帧（探明定案：折叠显示用段级粒度，token 级
 *  delta 高频帧无增益）；仅发发起 ask 的连接（点对点）。 */
export interface StewardThinkingPayload {
  /** 完整 thinking 块文本（段级全量——非增量）。 */
  text: string;
  seq: number;
}

/** steward.thinking：thinking 过程帧（channel = "steward"；点对点——屏幕通道）。 */
export interface StewardThinkingEvent extends EventFrame<StewardThinkingPayload> {
  channel?: "steward";
  type: "steward.thinking";
}

/** steward.navigate payload（管家驾驶舱批，additive）：页面切换指令——
 *  daemon 在 deliver_to_session 确认投递成功 / create_session 建成后广播，
 *  shell 收到后切到目标会话页（与侧栏点击同一路径）。 */
export interface StewardNavigatePayload {
  /** 切换目标会话 id。 */
  sessionId: string;
}

/** steward.navigate：页面切换指令帧（channel = "steward"；广播——仅发
 *  已订阅 steward 的连接，与 steward.feed 同闸门）。 */
export interface StewardNavigateEvent extends EventFrame<StewardNavigatePayload> {
  channel?: "steward";
  type: "steward.navigate";
}

/** 长期记忆条目行（管家记忆 B2：memory_list 回执形态；kind 枚举对齐
 *  存储面既有值 fact/preference，progress 批扩 progress = 会话进展状态
 *  （同 session 覆盖更新；additive——旧 shell 忽略无损）；遗忘机制批 additive
 *  生命周期字段——旧 shell 忽略无损）。 */
export interface StewardMemoryEntryView {
  /** 条目 id（存储 rowid）。 */
  id: number;
  /** 记忆文本。 */
  text: string;
  /** 条目类别。 */
  kind: "fact" | "preference" | "progress";
  /** 创建时间（epoch ms）。 */
  createdAt: number;
  /** 来源标注（如 "steward-turn"（remember 工具）/ "manual"（人工新增））。 */
  sourceTurn: string;
  /** 最后更新时刻（epoch ms；覆盖更新/复活/置顶时刷新——additive，旧 daemon 不携带）。 */
  updatedAt?: number;
  /** 最近一次被召回时刻（epoch ms；0 = 从未被想起——additive）。 */
  lastRecalledAt?: number;
  /** 累计被召回次数（additive）。 */
  recallCount?: number;
  /** 淡忘中（退出召回池，观察窗后物理删除；编辑/恢复/置顶即救活——additive）。 */
  faded?: boolean;
  /** 已置顶（永不淡忘、永不 GC，强度恒满——additive）。 */
  pinned?: boolean;
  /** 关联会话 id（progress 批：kind=progress 专属锚——记忆页筛选/详情/跳转
   *  read_session 用；其他 kind 不携带；additive）。 */
  sessionId?: string;
}

/** steward.memory_list.result payload：条目清单（memory_list/append/
 *  update/delete/pin/restore 六命令共用回执——写后即回新清单）。 */
export interface StewardMemoryListResultPayload {
  /** 条目全集（updatedAt 降序——最近变动浮顶：覆盖更新/复活/置顶可见；
   *  遗忘机制批前的 createdAt 升序已退役）。 */
  entries: readonly StewardMemoryEntryView[];
}

/** steward.memory_list.result：长期记忆条目清单回执（channel = "steward"；
 *  点对点）。 */
export interface StewardMemoryListResultEvent extends EventFrame<StewardMemoryListResultPayload> {
  channel?: "steward";
  type: "steward.memory_list.result";
}

/** steward.notify 建议（接续提案）：label = 按钮文案；verb = 动词指针
 *  （建议动作的动词标识——点按才动、动作落地仍过确认闸，v1 词表 open_tasks；
 *  M2 surface.action 协议后扩全动词清单）；sessionId 可选跳转锚。 */
export interface StewardNotifySuggestion {
  /** 按钮文案（人读，如「去任务页看看」）。 */
  label: string;
  /** 动词指针（可选——缺席 = 无动作面，纯展示建议）。 */
  verb?: string;
  /** 跳转锚（可选——verb 涉及具体会话/任务时携带）。 */
  sessionId?: string;
}

/** steward.notify payload（管家感知批 M0.5，additive）：主动通知帧——
 *  分诊器（激活态一次 LLM 双轨产物）的呈现轨载体；**事件帧非指令帧**
 *  （D8 通道治理：告知发生了什么，建议按钮点按才动、写类动作仍过
 *  确认闸），与 feed 同订阅闸广播。 */
export interface StewardNotifyPayload {
  /** 紧急度：normal = 常规通知（限流 ≤4 条/小时）；high = 门控高危（豁免限流）。 */
  urgency: "normal" | "high";
  /** 通知标题（短词，如「任务完成」）。 */
  title: string;
  /** 呈现轨正文（≤60 字口语——语音与 toast 同源同判断）。 */
  body: string;
  /** 接续提案（可选；点按才动）。 */
  suggestions?: readonly StewardNotifySuggestion[];
  /** 连接内单调顺序号（1 起；shell 侧顺序保障/丢帧检测面）。 */
  seq: number;
}

/** steward.notify：管家主动通知广播帧（channel = "steward"；仅发已订阅
 *  连接——与 steward.feed 同闸门同构；呈现即焚，不进对话上下文）。 */
export interface StewardNotifyEvent extends EventFrame<StewardNotifyPayload> {
  channel?: "steward";
  type: "steward.notify";
}
