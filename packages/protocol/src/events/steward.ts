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
import type { SummaryConfigStatePayload } from "./config";

/** steward.ask.result payload：五判别——answer = 直答文本；confirm_required =
 *  确认闸请求（写注入唯一原语 propose_send 的回执形态，未确认零执行）；
 *  queued = 忙碌态入队确认（L1 件二：本轮工具循环收口后自动作为下一轮
 *  输入，结果帧随后另发）；dropped = 静默丢弃（addressee 判定判为旁人话语
 *  ——双工常开麦收音段非管家对话，零回答零播报零字幕，前端静默收口轮次）；
 *  error = 业务失败（开关关/模型未配/key 缺失/
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
      status: "dropped";
      /** 丢弃原因分类（additive 预留；当前恒 "ambient" = 判为旁人话语/自言自语）。 */
      reason?: "ambient";
    }
  | {
      /** 手动停止批：在途 run 被停止词全停（abort 当前 + 清空排队；收口由
       *  daemon 异步完成——回执即刻返回，收口后排队输入不再被消费）。 */
      status: "stopped";
      /** 停止说明。 */
      reason: string;
      /** 随停丢弃的排队输入条数。 */
      dropped: number;
    }
  | {
      status: "error";
      /** 失败原因（含引导，如开关关时指向设置页开启路径）。 */
      reason: string;
      /**
       * 错误分类（事故热修批⑦，additive 可选——旧壳忽略零破坏）：
       * aborted = run 被中止（挂闸 abort 唤醒/工具面 abort 链）；model-failure
       * = 模型调用失败（provider 流错误）；engine-exception = 引擎驱动异常
       * （如并发 start 撞门）；round-limit = 工具循环熔断；engine-error =
       * 引擎软错误（压缩失败等可观测事件）。分记目的：工具面 aborted 不再
       * 被误归为模型失败（2026-10-07 事故：act 挂闸 60s 后收口被记「模型调用失败」）。
       */
      errorKind?: StewardAskErrorKind;
    };

/** steward ask 错误分类词汇表（封闭集——收口日志与回执分记锚）。 */
export const STEWARD_ASK_ERROR_KINDS = [
  "aborted",
  "model-failure",
  "engine-exception",
  "round-limit",
  "engine-error",
] as const;

/** steward ask 错误分类（封闭词汇表成员）。 */
export type StewardAskErrorKind = (typeof STEWARD_ASK_ERROR_KINDS)[number];

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
 *  error 判别迁出，受理后不再复用 error 通道）。
 *  确认链路修复批 additive：outcome 判别——缺省 = executed（正常执行回执，
 *  成败两路均含）；superseded = 收敛/清场撤卡帧（同 key 卡随终局静默撤除
 *  / run 收口 destructive 卡撤除——shell 移卡零 toast 零留痕）；timeout =
 *  TTL 作废帧（可靠性批既有，补判别标注）。 */
export interface StewardActionCompletedPayload {
  /** 已完成动作 id（与 confirm_required/sediment_proposal 的 actionId 同源）。 */
  actionId: string;
  /** 执行成败（executePending outcome.ok）。 */
  ok: boolean;
  /** 结果说明（用户与 LLM 共同可见的回执文本——成功详情/失败原因）。 */
  detail: string;
  /** 终局判别（additive；缺省 = executed）。superseded 帧 = 静默撤卡指令。 */
  outcome?: "executed" | "superseded" | "timeout";
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
  /** 总结配置组回显（会话总结器独立化批①：summary.* 通用域只读观测面——
   *  写面在 config.set_summary，管家配置零总结项；形状与
   *  SummaryConfigStatePayload 同源）。 */
  summary: SummaryConfigStatePayload;
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
    /** 召回注入条数上限生效值（批B 配置驱动；缺省 5；非法 KV 回显缺省
     *  ——所见即所得。additive 可选：旧壳/未装配缺席忽略）。 */
    recallTopK?: number;
    /** 召回候选池生效值（批B；缺省 24。additive 可选）。 */
    recallPool?: number;
    /** 召回资格闸阈值生效值（additive；缺省 0.3；非法 KV 回显缺省）。 */
    recallMinScore?: number;
  };
  /** 分诊判官配置现态（分诊判官接入批，additive 可选：旧壳/未装配缺席
   *  忽略；judgeEndpoint 引用态——端点被删回 null（读面视为未配，UI 显示
   *  「未选择」））。 */
  triage?: {
    /** 判官判定开关现态（默认 false = 现行 LLM JSON 判定路径）。 */
    judgeEnabled: boolean;
    /** 当前判官端点引用（引用态：id/name/model/hasApiKey；未引用/悬空/非
     *  classifier = null）。 */
    judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
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
      /**
       * @deprecated 旧形态标记（事故热修批⑤起废弃——压缩摘要已改落
       * kind="compaction" 分支，不再作为 user 轮写入。历史存量行可能仍携
       * 此标记，消费面兼容读；新写入恒 kind="compaction"）。
       */
      compaction?: true;
    }
  | {
      /**
       * 压缩摘要记录（事故热修批⑤，additive）：压缩器输出是内部上下文
       * 状态而非用户话轮——2026-10-07 事故中空对话压缩器输出（「## Goal
       * （无。待压缩的对话为空…）」）落成 kind=user 轮，UI 把压缩器格式
       * 文本渲染成用户发言。LLM 窗口重建（buildLlmWindow）仍转换为摘要
       * 消息注入上下文（压缩机制语义不变）——只有落库形态与 UI 回放
       * 退出 user 轮域。
       */
      kind: "compaction";
      /** 压缩摘要全文。 */
      text: string;
      /** 落笔时间戳（ms）。 */
      at: number;
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

/** steward.navigate payload（管家驾驶舱批；**已退役 deprecated**——M0 表面
 *  协议地基批 D8 存量收编：单需求专用指令帧迁 surface.action
 *  {verb:"navigate", args:{sessionId}}；兼容期 daemon 双发（DEPRECATED_EVENT_TYPES
 *  在册），新消费面禁用本帧，删除点 = M1 前检查点）：页面切换指令——
 *  daemon 在 deliver_to_session 确认投递成功 / create_session 建成后广播，
 *  shell 收到后切到目标会话页（与侧栏点击同一路径）。 */
export interface StewardNavigatePayload {
  /** 切换目标会话 id。 */
  sessionId: string;
}

/** steward.navigate：页面切换指令帧（channel = "steward"；广播——仅发
 *  已订阅 steward 的连接，与 steward.feed 同闸门）。已退役 deprecated——
 *  见 StewardNavigatePayload 头注（D8 收编 + 兼容期双发）。 */
export interface StewardNavigateEvent extends EventFrame<StewardNavigatePayload> {
  channel?: "steward";
  type: "steward.navigate";
}

/** 长期记忆业务领域维度（domain 维度批；kind × domain 正交——preference/
 *  fact 都可能落任意域，progress 固定 domain=project（无项目会话回落
 *  general））：habit = 关于用户怎么干活（换个团队也成立）/ general = 环境与
 *  通用工作方式事实（跟项目无关）/ project = 绑定具体项目才有意义（换个项目
 *  不成立）。一致性约束（daemon 写入单点强制）：domain="project" ↔
 *  projectScope=具体项目名；domain="habit"|"general" ↔ projectScope="global"。 */
export type StewardMemoryDomain = "habit" | "general" | "project";

/** 长期记忆条目行（管家记忆 B2：memory_list 回执形态；kind 枚举对齐
 *  存储面既有值 fact/preference，progress 批扩 progress = 会话进展状态
 *  （同 session 覆盖更新；additive——旧 shell 忽略无损）；遗忘机制批 additive
 *  生命周期字段——旧 shell 忽略无损；domain 维度批 additive 业务领域字段）。 */
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
  /** 项目作用域（项目隔离批，additive——旧 shell 忽略无损）："global" =
   *  跨项目可见 / 项目目录名 = 仅该项目 + global 消费面可召回；旧 daemon
   *  不携带（存量行迁移默认 global）。 */
  projectScope?: string;
  /** 业务领域维度（domain 维度批，additive——旧 shell 忽略无损）：habit/
   *  general/project（与 projectScope 一致性约束在 daemon 写入单点强制）；
   *  旧 daemon 不携带（存量行迁移缺省：progress→project、其余→habit）。 */
  domain?: StewardMemoryDomain;
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

/** steward.health payload（健康状态帧，additive）：子系统降级/恢复广播——
 *  光球健康角标呈现面的信号源。**事件帧非指令帧**（与 notify 同通道治理）；
 *  语义 = 状态变化才发（同状态去重/恢复上行由 daemon 侧把门）。 */
export interface StewardHealthPayload {
  /** 故障组件：judge = 意图/称呼判官；tts = 语音合成；stt = 语音转写；
   *  llm = 管家模型（run 级失败）。 */
  component: "judge" | "tts" | "stt" | "llm";
  /** 状态：degraded = 降级（旁路回退可用）；ok = 已恢复。 */
  status: "degraded" | "ok";
  /** 故障简因（≤60 字白话——与 notify body 同口径；status=ok 可省）。 */
  reason?: string;
  /** 连接内单调顺序号（1 起；shell 侧顺序保障面）。 */
  seq: number;
}

/** steward.health：子系统健康广播帧（channel = "steward"；仅发已订阅连接
 *  ——与 steward.feed 同闸门同构）。 */
export interface StewardHealthEvent extends EventFrame<StewardHealthPayload> {
  channel?: "steward";
  type: "steward.health";
}

/**
 * steward.proactive payload（M3-a 批，additive——CAND-601 闭环）：对话内
 * 主动汇报实时帧——reportProactive 写工作记忆的同时广播本帧，开着的管
 * 家面板实时冒出汇报条目（不重开面板；重开由 history 回放同源再现）。
 * **事件帧非指令帧**（与 notify 同通道治理：告知 + 建议点按才动）；
 * suggestions 与 notify 建议形态同源（无 urgency——对话内汇报不进通知预算）。
 */
export interface StewardProactivePayload {
  /** 汇报标题（任务标题机械字段 / 终态词——与 notify.title 同源）。 */
  title: string;
  /** 汇报正文（与工作记忆 assistant 记录同文本）。 */
  text: string;
  /** 接续提案（可选；点按才动——与 notify.suggestions 同形态）。 */
  suggestions?: readonly StewardNotifySuggestion[];
  /** 连接内单调顺序号（1 起；shell 侧顺序保障/丢帧检测面）。 */
  seq: number;
}

/** steward.proactive：对话内主动汇报实时广播帧（channel = "steward"；仅发
 *  已订阅连接——与 feed/notify 同闸门；旧壳缺帧型忽略零破坏）。 */
export interface StewardProactiveEvent extends EventFrame<StewardProactivePayload> {
  channel?: "steward";
  type: "steward.proactive";
}

/** steward.pending.snapshot payload（确认链路修复批；E-206 预留帧位落地）：
 *  daemon 当前在途确认卡集快照——订阅对账载体。空集即清场指令（daemon
 *  重启后内存 pending 不持久化，shell 收空集即撤全部旧卡——跨重启残卡
 *  的唯一正确交代面；非空集 = 增量对账：不在册的卡已失效应撤）。 */
export interface StewardPendingSnapshotPayload {
  /** daemon 侧在途待确认 actionId 全集（插入序；shell 以此为权威对账）。 */
  actionIds: readonly string[];
}

/** steward.pending.snapshot：在途确认卡快照帧（channel = "steward"；广播
 * 仅发已订阅连接 + steward.subscribe 受理时点对点回发一次——对账双路）。 */
export interface StewardPendingSnapshotEvent extends EventFrame<StewardPendingSnapshotPayload> {
  channel?: "steward";
  type: "steward.pending.snapshot";
}

// ── 管家活动账（M3-d1 感知兑现批，additive）────────────────────

/** 活动域标签（域归组——时间线呈现/归组用；cli = 终端会话专属归组）。 */
export type StewardActivityDomain = "task" | "session" | "agent" | "surface" | "cli" | "notify";

/** 活动归因三值：user = 用户动作 / steward = 管家自产动作（CAND-607
 *  selfRef 并入解决）/ system = 系统机械动作（后台代理/回合收口）。 */
export type StewardActivityAttribution = "user" | "steward" | "system";

/** 活动账统一条目（{at, domain, attribution, text}——text 恒白话一句，
 *  TR-249 铁律延伸到呈现/投影面：禁术语/UUID/英文报错原文）。 */
export interface StewardActivityEntryView {
  /** 记录时刻（epoch ms）。 */
  at: number;
  /** 域标签。 */
  domain: StewardActivityDomain;
  /** 归因。 */
  attribution: StewardActivityAttribution;
  /** 白话一句话。 */
  text: string;
}

/** steward.activity.result payload（M3-d1，additive）：活动账时间窗查询
 *  回执（steward.activity.list / clear 两命令共用——clear 后即回空窗新态）。 */
export interface StewardActivityResultPayload {
  /** 条目清单（at 降序——最新在前；时间窗过滤后取最近 limit 条）。 */
  entries: readonly StewardActivityEntryView[];
}

/** steward.activity.result：活动账查询/清理回执（channel = "steward"；
 *  点对点——发回发起命令的连接）。 */
export interface StewardActivityResultEvent extends EventFrame<StewardActivityResultPayload> {
  channel?: "steward";
  type: "steward.activity.result";
}

/** steward.activity payload（M3-d1，additive）：实时活动条目广播帧——
 *  活动账落账即广播（ring 六类条目沉淀 + notify 记账同源），时间线呈现面
 *  实时冒条目；**事件帧非指令帧**（与 notify 同通道治理）。 */
export interface StewardActivityPayload extends StewardActivityEntryView {
  /** 连接内单调顺序号（1 起；shell 侧顺序保障/丢帧检测面）。 */
  seq: number;
}

/** steward.activity：实时活动条目广播帧（channel = "steward"；仅发已订阅
 *  连接——与 feed/notify 同闸门；旧壳缺帧型忽略零破坏）。 */
export interface StewardActivityEvent extends EventFrame<StewardActivityPayload> {
  channel?: "steward";
  type: "steward.activity";
}

/** steward.judge_stop_intent.result payload（Jev 停止判定单轨批，additive）。 */
export interface StewardJudgeStopIntentResultPayload {
  /** 判定结论：true = 停止意图确认（shell 走真停三步序）。 */
  stop: boolean;
  /** 判官校准概率（degraded 时缺席）。 */
  score?: number;
  /** 降级标记（off = 开关关/判官缺席；unready = 端点未配；error = 判定抛错）。
   *  **原始判定语义**：降级一律 stop=false + degraded 标记（判不出）——
   *  fail-stop 归消费面（shell 打断链判不出=真停宁误停不漏停；daemon ask
   *  漏斗判不出=照常走队列）。 */
  degraded?: "off" | "unready" | "error";
}

/** steward.judge_stop_intent.result：停止意图判定回执（channel = "steward"；
 *  点对点——发回发起命令的连接；Jev 停止判定单轨，停止词表退役后停止判定
 *  唯一回执面——shell 打断链消费，迟到回执幂等吞）。 */
export interface StewardJudgeStopIntentResultEvent extends EventFrame<StewardJudgeStopIntentResultPayload> {
  channel?: "steward";
  type: "steward.judge_stop_intent.result";
}
