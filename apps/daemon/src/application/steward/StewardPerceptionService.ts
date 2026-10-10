/**
 * StewardPerceptionService —— 管家系统感知 application service（M0.5 批，
 * 设计 D10/D11/D12：感知地基 + 激活判定 + 分诊编排 + notify 限流；
 * M0.5-R 修正 D12-⑫：LLM 门槛=启用，激活降为投递面判据）。
 *
 * 感知源（D10）：订阅既有域事件总线（fanout steward-perception-bridge
 * ——agent.* 终态 + steer.queued(source=progress) 周期 ping）+ 任务级完成锚
 * （组合根接 TaskOrchestratorService.onJobTerminal）+ **表面族第三源**（M1
 * browser adapter：组合根经 SurfaceRegistry 观察者订阅 → onSurfaceEvent
 * 入 ring，零分诊零 LLM）。全部只读订阅，零新事件源零新表——「生产者不直
 * 喂管家」禁令由 fanout 桥/Registry 订阅形态保持（组合根接线，
 * SessionSummaryService 直写教训的反面）。
 *
 * 存储分层（D11）：ring buffer（daemon 内存滚动上限，不落盘）——原始事件
 * 流沉淀 + 分诊摄入轨工作记录；ask 时投影当轮（消费面后续批次接）。
 *
 * 分诊门槛（D12-⑫，用户裁决——推翻 v2.8 的「零激活=零 LLM」）：LLM 分诊
 * **启用态恒做**（不看激活）——启用 = money gate（管家开∧总结开）∧ 模型配
 * （StewardDiagnosisPort.isAvailable 三条件收口）；未启用（money gate 关）
 * 零 LLM 机械保底（极简语音 + closure 行，E-204 语义）。成本闸归位：
 * 信号级门控（任务终态粗筛）+ 通知限流，激活不是 LLM 门槛。
 *
 * 激活判定（D12-⑪ 两环二分——**投递面判据**）：steward.feed 订阅在场
 * （面板/驾驶舱连接级信号）∧ 近期 ask（衰减窗 STEWARD_ACTIVE_WINDOW_MS）。
 * 激活只决定主动环投递面：激活 = 对话内主动汇报 + notify；未激活 =
 * notify + 语音异步（零对话插话）。响应环（用户 ask → 回答）无激活前置，
 * 一问即激活。光球在屏/管家面板精确挂载信号留 M0 surface 协议后升级
 * （接点：feedGate.hasStewardSubscribers 读面替换为 SurfaceRegistry 激活态）。
 *
 * 播报重构（2026-10-08 用户裁决，白话硬约束）：
 * - 任务终态锚**机械化**——任务状态是机械事实，零 LLM 零判官零分诊：
 *   notify（title=任务名 + 白话短讯「任务完成了/失败了/被停掉了」）+
 *   语音同句；failed=high 豁免限流（失败早知道）；启用态与否不影响
 *   （机械事实不依赖 LLM 配置）。
 * - 任务内 agent 终态（completed/failed/killed）**零播报零通知零分诊**
 *   ——用户只关心任务整体（原 agent 级即报与 BroadcastService agent 播报
 *   集/内容源回调链整体退役，fanout voice-broadcast-bridge 已拆除）；
 *   事件仍入 ring（感知记录在）。
 * - 会话回复锚（投递关注命中 turn.completed）：**notify 机械短讯**
 *   （「对话回复了 / 回完了，具体我语音里说」——通知生命周期短，写多也
 *   看不完）；**详文归宿是管家语音**——正文全给管家，判官 noul 单判
 *   详略（verbose ≥0.5 = detail 逐项上嘴，否则 present 一句话）；判官
 *   关闭/未配/抛错 → detail 在场决定（回退语义）。分诊一次 LLM 调用产
 *   两段白话文案（生成面禁 JSON——烂文本截断兑底无解析失败类别）。
 * - **白话硬约束**：凡是播报出来的（notify 正文/语音/保底句/机械短讯）
 *   全部大白话——禁技术术语、英文报错、变量名、UUID。
 *
 * 通知预算（D12-⑦）：normal 档滑动窗 ≤4 条/小时（daemon 侧机械计数）；
 * high 档豁免（仅门控高危——分诊产物 urgency 裁定）。超限丢弃 notify 帧
 * **与对话内汇报**（同属主动投递面，共用预算防轰炸）并 warn 观测；语音不
 * 受此限（播报队列自有上限 5 溢出合并语义）。限流对未激活 notify 同样生效。
 *
 * 防自激（TR-169/TR-173 族纪律）：本服务订阅事件流只产出协议帧（notify）
 * 与内存 ring 记录，零领域事件发布——事件订阅面与写面无反馈边。
 */
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type {
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentKilledPayload,
} from "../../domain/events/DomainEvent";
import type {
  StewardDiagnosisPort,
  StewardDiagnosisResult,
} from "../ports/outbound/StewardDiagnosisPort";
import type { TriageJudgeFace } from "./StewardTriageJudge";
import { STEWARD_TUNING_DEFAULTS, type StewardTuning } from "../../domain/steward/tuning/StewardTuning";
import type { StewardNotifyPayload, StewardNotifySuggestion, SurfaceEvent, VoiceBroadcastKind } from "@helix/protocol";

/** 任务会话 id 前缀（完成类聚合判别——task:* 会话的 agent.completed 不在
 *  agent 级播报，聚任务级锚；与 TaskOrchestratorService.TASK_SESSION_PREFIX
 *  同值，application 层不 import 编排服务（域间窄面纪律），字面量单源注释互指）。 */
const TASK_SESSION_PREFIX = "task:";

/** ring buffer 滚动上限（内存有界——D11 ①层：原始事件流滚动淘汰，不落盘）。 */
export const PERCEPTION_RING_LIMIT = 200;

/** 激活信号②近期 ask 衰减窗（毫秒）。批 0 起：缺省单源 StewardTuning
 *  （KV steward.tuning.activation.windowMs 可改，原「未上配置面」范围钳制
 *  由 DDD 重构批 0 解除）——此处 re-export 兼容既有引用，值不双写。 */
export const STEWARD_ACTIVE_WINDOW_MS = STEWARD_TUNING_DEFAULTS.activation.windowMs;

/** notify 呈现轨字数上限（设计⑩：≤60 字口语；超长截断加省略号——LLM
 *  产物防御，与语音播报 80 字符兜底同族）。 */
export const NOTIFY_PRESENT_MAX_CHARS = 60;

/** notify 正文轨字数上限（双预算分轨：语音短句 ≤60，视觉正文可到 600——
 *  用户反馈批「总结要详：白话逐项讲清每轮完成的任务，无严格长度限制但忌长篇」；
 *  detail 缺席回退 present 单轨）。 */
export const NOTIFY_BODY_MAX_CHARS = 600;

/** 语音详报轨字数上限（语音/视觉分轨：600 是 notify 视觉预算，听 600 字
 *  只要两分钟——长报告被视觉预算误伤「播到一半戛然而止」；语音轨独立
 *  放宽到 2000（约 6 分钟白话，超长兑底防御保留）。 */
export const VOICE_DETAIL_MAX_CHARS = 2000;

/** 投递关注持久化单键（runtime_config kv——无枚举面，单键整图快照形态；
 *  空 Map 写 "{}"，无 delete 面不生残留）。 */
export const STEWARD_WATCH_KV_KEY = "steward_watch_reply";

/** 投递关注 TTL（24h——重启恢复时过滤陈旧关注，防僵尸关注永久滞留；
 *  运行期消费不检 TTL：跨天回复仍值得告知）。 */
export const STEWARD_WATCH_TTL_MS = 24 * 60 * 60_000;

/** 通知预算：normal 档滑动窗口时长（D12-⑦「如 ≤4 条/小时」）。 */
export const NOTIFY_BUDGET_WINDOW_MS = 60 * 60_000;

/** 通知预算：normal 档窗口内上限（high 档豁免）。 */
export const NOTIFY_NORMAL_HOURLY_LIMIT = 4;

/** ring buffer 条目（D11 ①层原始事件流 + ⑩ 摄入轨工作记录）。 */
export interface PerceptionRingEntry {
  /** 记录时刻（epoch ms）。 */
  readonly at: number;
  /** 记录类别：agent 终态三值 / 周期进展 ping / 任务终态事实 / 分诊摄入轨 / 表面事件 / 会话回合终态。 */
  readonly kind:
    | "agent.completed"
    | "agent.failed"
    | "agent.killed"
    | "progress.ping"
    | "task.terminal"
    | "task.diagnosed"
    | "surface.event"
    | "turn.completed";
  /** 归属会话（agent 事件携带 sessionId；任务锚 = task:<jobId>；表面事件 = surfaceId）。 */
  readonly sessionId: string;
  /** 触发实例 id（agent 事件；缺席 = 任务级记录）。 */
  readonly agentId?: string;
  /** 任务 id（任务级记录）。 */
  readonly jobId?: string;
  /** 任务标题（任务终态机械字段——M3-d1 additive：活动账白话行文用，
   *  白话铁律禁 id 入句）。 */
  readonly title?: string;
  /** 表面事件来源（E-251 三原语 origin 三值——M3-d1 additive：活动账
   *  attribution 归一用；缺席 = user（M0 shell 页面事件恒 user））。 */
  readonly origin?: "user" | "steward" | "system";
  /** 表面事件 kind 原词（activated/navigated/…——M3-d1 additive：活动账
   *  白话映射用，避免解析 text 拼接串）。 */
  readonly surfaceKind?: string;
  /** 一行摘要（agent closure 摘要截断 / 周期 ping 原文 / 终态事实）。 */
  readonly text: string;
  /** 分诊摄入轨全文（仅 task.diagnosed——只活 ring buffer，不进长期记忆）。 */
  readonly ingest?: string;
}

/** 分诊输入素材（一次门控事件的现场投影）。 */
interface DiagnosisInput {
  /** 去重键（事件键：`<type>:<agentId>` 或 `task.done:<jobId>`）。 */
  readonly key: string;
  /** 播报判别（语音帧 kind）。 */
  readonly voiceKind: VoiceBroadcastKind;
  /** 语音帧 agentId 位（任务锚 = task:<jobId> 会话 id）。 */
  readonly voiceAgentId: string;
  /** 通知标题（机械字段——「对话回复了」；任务终态锚不经此结构）。 */
  readonly taskTitle?: string;
  /** notify 机械短讯（白话——「回完了，具体我语音里说」；缺席 = 用
   *  fallbackText 保底句）。 */
  readonly notifyBody?: string;
  /** 回复正文读面锚（修复①：回合终态分诊取「那边回了什么」——runDiagnosis
   *  异步读后拼入 userPrompt；缺席 = 不补正文段）。 */
  readonly replyContextSessionId?: string;
  /** 保底白话句（未启用/分诊失败/空文本三路共用——语音+notify 同句）。 */
  readonly fallbackText?: string;
  /** 分诊 userPrompt 素材（终态事实 + ring 现场投影 + 可选回复正文）。 */
  readonly userPrompt: string;
}

/** 分诊器系统提示词（JSON 回退路径——仅会话回复锚使用）。 */
export const DIAGNOSIS_SYSTEM_PROMPT = [
  "你是 helix 管家的播报撰稿人：用户之前给一个对话发了消息，那边刚干完一轮活回过来了。请产出播报稿。",
  "输出必须是单个 JSON 对象（无围栏无解释），字段：",
  '- notify: 布尔（保留字段，恒 true）',
  '- urgency: "normal"',
  "- present: 一句话总结，大白话，不超过 60 字",
  "- detail: 逐项讲清这轮干了什么、结果如何、有什么要注意的，大白话，不超过 600 字",
  "- ingest: 给管家自己记的全面记录（可含技术细节），不超过 2000 字",
  "- suggestions: 空数组",
  "硬约束：present/detail 全部大白话——像当面口头汇报，禁止技术术语、英文报错原文、变量名、UUID；present 的内容必须出自 ingest 已写明的事实。",
].join("\n");

// ── 分诊判官判定面常量（管家分诊判官接入批）────────────────────

/** 判官详略阈值（noul 校准概率 ≥ 此值 = 详细播报——E-214 记忆查重 0.5 同款）。 */
export const TRIAGE_JUDGE_VERBOSE_THRESHOLD = 0.5;

/** 判官问句（2026-10-08 裁决后单判）：详略——这个回复要不要详细播报
 *  （问题文本单源常量——测试直引，防措辞漂移导致判定语义漂移）。 */
export const TRIAGE_JUDGE_VERBOSE_QUESTION =
  "这个回复需要详细播报吗？（工作量大、有具体结果或结论、用户在等详细汇报 = 详细；简单确认、例行处理、没什么可说 = 简短）";

/** 判官路径生成段系统提示词：纯文本两段制白话——禁 JSON/围栏/前缀
 *  （聊天模型填表形态错配是解析失败的根因；本路径零格式风险）。 */
export const TRIAGE_GENERATION_SYSTEM_PROMPT = [
  "你是 helix 管家的播报撰稿人：用户之前给一个对话发了消息，那边刚干完一轮活回过来了。",
  "直接输出两个自然段，禁止 JSON、代码围栏、标题或编号前缀及任何格式包装，两段都必须是大白话，像当面口头汇报，禁止技术术语、英文、代码、变量名、UUID：",
  "第一段：一句话总结，口语化中文，不超过 60 字。",
  "第二段：逐项讲清这轮干了什么、结果如何、有什么要注意的，大白话，不超过 600 字，忌长篇大论。",
].join("\n");

/** 对话内主动汇报载荷（激活态主动环投递面——D12-⑪「对话内主动汇报/
 *  接续提案」；呈现轨与 notify 同源，接续提案点按才动）。 */
export interface ProactiveDialogReport {
  /** 汇报标题（任务标题机械字段 / 终态词）。 */
  readonly title: string;
  /** 呈现轨正文（与 notify body 同源）。 */
  readonly text: string;
  /** 接续提案（LLM 产物 + 机械 [看看报告]；点按才动）。 */
  readonly suggestions: readonly StewardNotifySuggestion[];
}

export interface StewardPerceptionDeps {
  /** 分诊 LLM 面（缺席 = 分诊整体不可用——零 LLM 降级形态）。 */
  readonly diagnose?: StewardDiagnosisPort;
  /** 分诊判官判定面（管家分诊判官接入批，可选——缺席/开关关/端点未配/
   *  抛错均回退现行 LLM JSON 路径，d7449d79 基线零变化。窄面：只消费判定
   *  三法，配置读写归组合根同源真体的完整 face）。 */
  readonly triageJudge?: Pick<TriageJudgeFace, "enabled" | "ready" | "noul">;
  /** 激活信号①：steward.feed 订阅在场读面（EventStream 连接级窄接口；
   *  M0 surface 协议后升级为光球/面板精确挂载信号——接点注释见类头）。 */
  readonly feedGate: { hasStewardSubscribers(): boolean };
  /** progress 薄条目写面（StewardMemoryService.recordSessionProgress 窄接口——
   *  E-247 机制零改动只调用；缺席 = 零 progress 写入）。 */
  readonly memory?: { recordSessionProgress(sessionId: string, text: string): Promise<boolean> };
  /** notify 帧出口（组合根接 EventStream.broadcastStewardNotify——与 feed
   *  同订阅闸；缺席 = 零广播（测试形态））。 */
  readonly emitNotify?: (payload: StewardNotifyPayload) => void;
  /** 对话内主动汇报面（激活态主动环投递——窄接口，组合根接
   *  StewardService.reportProactive（工作记忆 assistant 记录，对话回放与
   *  LLM 记忆同源）；缺席 = 只走 toast/语音）。 */
  readonly reportDialog?: (report: ProactiveDialogReport) => void;
  /** 语音播报直供面（BroadcastService.enqueueDiagnosed 窄接口——分诊呈现轨
   *  同源直供；组合根晚绑回填（构造环：BroadcastService content 源又指向本
   *  队列面）；缺席 = 零语音。 */
  readonly voice?: { enqueueDiagnosed(item: { kind: VoiceBroadcastKind; agentId: string; text: string }): void };
  /** 回复正文读面（修复①：回合终态分诊输入补「那边回了什么」——组合根接
   *  SessionRepository.readSessionTail 尾投影取末条 assistant；缺席 = prompt
   *  标注无正文，读面失败不阻塞诊断）。 */
  readonly readReply?: (sessionId: string) => Promise<string | undefined>;
  /** 投递关注持久化 kv（修复②：RuntimeConfigPort 窄面——单键整图快照，跨
   *  重启恢复 + TTL 过滤；缺席 = 纯内存形态（回归兼容）。 */
  readonly kv?: { get(key: string): string | undefined; set(key: string, value: string): Promise<void> };
  /** 活动账沉淀回调（M3-d1 感知兑现批：ring 六类条目入账——组合根接
   *  StewardActivityService.recordRingEntry；**隔离面**：回调抛错被吞
   *  不炸感知主链路；缺席 = 零落账（ring 语义不变）。管道冻结语义保持：
   *  这是既有 ring 索引的落盘投影，不是新采集面。） */
  readonly onRingEntry?: (entry: PerceptionRingEntry) => void;
  /** 时钟（缺省 Date.now——测试注入衰减窗/限流窗步进）。 */
  readonly clock?: () => number;
  /** 行为阈值现拍面（批 0 配置域：仅消费 activation.windowMs；缺省 =
   *  STEWARD_TUNING_DEFAULTS 即原硬编码常量——零注入零行为变化）。 */
  readonly tuningOf?: () => StewardTuning;
  readonly logger?: { warn(message: string): void };
}

/** 分诊一次调用的完整上下文（in-flight 去重 + 产物消费）。 */
interface DiagnosisFlight {
  readonly promise: Promise<StewardDiagnosisResult | undefined>;
}

export class StewardPerceptionService {
  private readonly deps: StewardPerceptionDeps;
  private readonly now: () => number;
  /** 行为阈值现拍面（批 0：仅 activation.windowMs）。 */
  private readonly tuningOf: () => StewardTuning;
  /** ring buffer（原始事件流 + 摄入轨工作记录；内存滚动，不落盘）。 */
  private ring: PerceptionRingEntry[] = [];
  /** 激活信号②：最近一次 ask 时刻（-1 = 从未）。 */
  private lastAskAt = -1;
  /** in-flight 分诊去重表（事件键 → 调用 promise——BroadcastService content
   *  源与本服务事件入口双触发共用一次调用：归一断言 calls=1 的落点）。 */
  private readonly inflight = new Map<string, DiagnosisFlight>();
  /** 串行链（分诊调用/产物消费按到达序——与 BroadcastService drained 链同构）。 */
  private chain: Promise<void> = Promise.resolve();
  /** notify 帧连接内单调序号。 */
  private notifySeq = 0;
  /** normal 档限流窗：已发时刻数组（滑动窗淘汰）。 */
  private normalSentAt: number[] = [];
  /** 投递关注表（sessionId → 投递现场）：deliver_to_session 投递成功后注册
   * ——该会话回合结束（turn.completed）即命中分诊锚（用户在等回复的会话
   * 才主动通知；无关注会话回合终态只入 ring 零 LLM——回合高频事件不全量
   * 分诊的成本闸）。一次性消费：一次投递等一次回复。 */
  private readonly awaitingReply = new Map<string, { at: number; text: string }>();

  constructor(deps: StewardPerceptionDeps) {
    this.deps = deps;
    this.now = deps.clock ?? (() => Date.now());
    this.tuningOf = deps.tuningOf ?? (() => STEWARD_TUNING_DEFAULTS);
    this.hydrateWatchFromKv();
  }

  /** 投递关注恢复（修复②：构造时从 kv 单键快照回填——TTL 过滤陈旧关注；
 *  解析失败/缺键 = 零恢复静默（坏数据不阻断启动）。 */
  private hydrateWatchFromKv(): void {
    const raw = this.deps.kv?.get(STEWARD_WATCH_KV_KEY);
    if (raw === undefined || raw === "") return;
    try {
      const parsed = JSON.parse(raw) as Record<string, { at: number; text: string }>;
      const cutoff = this.now() - STEWARD_WATCH_TTL_MS;
      for (const [sessionId, w] of Object.entries(parsed)) {
        if (typeof w?.at === "number" && w.at >= cutoff) {
          this.awaitingReply.set(sessionId, { at: w.at, text: String(w.text ?? "").slice(0, 400) });
        }
      }
    } catch {
      this.deps.logger?.warn("投递关注快照恢复失败（解析异常，忽略）");
    }
  }

  /** 投递关注快照持久化（fire-and-forget；空图写 "{}"——无 delete 面不生残留）。 */
  private persistWatchSnapshot(): void {
    const kv = this.deps.kv;
    if (kv === undefined) return;
    const snapshot: Record<string, { at: number; text: string }> = {};
    for (const [sessionId, w] of this.awaitingReply) snapshot[sessionId] = w;
    void kv.set(STEWARD_WATCH_KV_KEY, JSON.stringify(snapshot)).catch(() => {});
  }

  // ── 激活判定（D12-⑪：feed 订阅在场 ∧ 近期 ask 衰减窗） ──────────

  /** 主动环激活态读面（v2.9：**投递面判据**——激活=对话内主动汇报；未激活
   *  =toast/语音异步。不再是 LLM 门槛：启用态分诊恒做）。 */
  isActive(): boolean {
    if (!this.deps.feedGate.hasStewardSubscribers()) return false;
    if (this.lastAskAt < 0) return false;
    return this.now() - this.lastAskAt <= this.tuningOf().activation.windowMs;
  }

  /** 激活信号②：用户 ask 活动信号（组合根接 StewardService.ask 入口——
   *  一问即入激活，响应环点亮主动环）。 */
  noteUserActivity(): void {
    this.lastAskAt = this.now();
  }

  /** 投递关注注册（StewardService deliverSession 投递成功后经组合根接线
   *  调用）：注册后该会话下一次 turn.completed 触发分诊（「那边回完了」
   *  ——用户在等回复的场景）。传的是关注意图（哪个会话值得等回复 + 投递
   *  文本素材），不是汇报内容——内容仍从事件流/ring 取，生产者不直喂禁令
   *  边界不变（防自激纪律同源）。 */
  noteDelivered(sessionId: string, deliveredText?: string): void {
    this.awaitingReply.set(sessionId, { at: this.now(), text: (deliveredText ?? "").slice(0, 400) });
    this.persistWatchSnapshot();
  }

  // ── 感知入口（D10：订阅总线，生产者不直喂） ──────────────────

  /**
   * fanout 目标入口（wireEventFanout steward-perception-bridge 装配）：
   * 终态/周期事件入 ring（D11 ①层，零 LLM）；分诊锚判定（agent.failed/
   * killed 即报 + 非 task 会话 agent.completed——task 会话完成类聚合任务级
   * 锚，onJobTerminal 触发）。只产出内存记录与协议帧，零领域事件（防自激）。
   */
  onDomainEvent(event: DomainEvent): void {
    const entry = this.ringEntryOf(event);
    if (entry !== undefined) this.pushRing(entry);
    const input = this.replyDiagnosisInputOf(event);
    if (input !== undefined) this.ensureDiagnosis(input);
  }

  /**
   * 任务级完成锚（组合根接 TaskOrchestratorService.onJobTerminal）：
   * job 终态入 ring；done 触发任务级分诊（完成类聚合的主播报锚——设计
   * D12-⑨ 粒度演进：批次收口级而非 agent 级）；failed/cancelled 不做任务级
   * 分诊（失败类保留 agent 级即报——早知道）；未启用（money gate 关）
   * 恒报终态事实（极简语音直供，D12-⑨ 机械降级，零 LLM）。title = 任务
   * 标题机械字段（notify title 用，非 UUID）。
   */
  onJobTerminal(jobId: string, status: "done" | "failed" | "cancelled" | string, title?: string): void {
    const sessionId = `${TASK_SESSION_PREFIX}${jobId}`;
    this.pushRing({
      at: this.now(),
      kind: "task.terminal",
      sessionId,
      jobId,
      // 任务标题（M3-d1）：活动账白话行文用——白话铁律禁 jobId 入句
      ...(title !== undefined && title.trim() !== "" ? { title: title.trim().slice(0, 80) } : {}),
      text: `任务 ${jobId} 终态：${status}`,
    });
    // 机械短讯（白话硬约束）：任务状态是机械事实——零 LLM 零判官零分诊，
    // 启用态与否不影响（机械事实不依赖 LLM 配置）；failed = high 豁免
    // 通知限流（失败早知道）。语音激活绑定（C 裁决 2026-10-08）：光球不在场
    // = normal 只 toast 零语音，仅 failed 破沉默开口；在场 = 语音同句直供。
    const body = status === "failed" ? "任务失败了" : status === "cancelled" ? "任务被停掉了" : "任务完成了";
    const urgency = status === "failed" ? "high" : "normal";
    // 语音（播报队列独立限流——上限 5 溢出合并，不受通知预算约束）：
    // failed 恒播（真出事破沉默）；done/cancelled 仅激活态（说面与 TR-250 同源）
    if (status === "failed" || this.isActive()) {
      this.deps.voice?.enqueueDiagnosed({ kind: "task.done", agentId: sessionId, text: body });
    }
    const now = this.now();
    if (urgency !== "high") {
      this.normalSentAt = this.normalSentAt.filter((t) => now - t < NOTIFY_BUDGET_WINDOW_MS);
      if (this.normalSentAt.length >= NOTIFY_NORMAL_HOURLY_LIMIT) {
        this.deps.logger?.warn(`管家通知预算超限（任务终态机械短讯丢弃）：${title ?? jobId}`);
        return;
      }
      this.normalSentAt.push(now);
    }
    const taskTitle = title !== undefined && title.trim() !== "" ? title.trim() : "后台任务";
    this.notifySeq += 1;
    this.deps.emitNotify?.({
      urgency,
      title: taskTitle,
      body,
      suggestions: status === "done" ? [{ label: "看看报告", verb: "open_tasks" }] : [],
      seq: this.notifySeq,
    });
  }

  /**
   * 表面族第三源（M1 browser adapter 接线点——感知源扩面，组合根经
   * SurfaceRegistry 观察者订阅）：SurfaceEvent 入 ring（D11 ①层零 LLM）。
   * **不改分诊/激活门语义**：表面事件非分诊锚，永不触发 LLM（消费面（ask
   * 时投影/聚焦摘要）后续批次接）。
   */
  onSurfaceEvent(event: SurfaceEvent): void {
    this.pushRing({
      at: event.at ?? this.now(),
      kind: "surface.event",
      sessionId: event.surfaceId, // 归属表面（ring sessionId 位承载 surfaceId）
      origin: event.origin, // M3-d1：活动账 attribution 归一（E-251 三原语）
      surfaceKind: event.kind, // M3-d1：活动账白话映射（免解析拼接串）
      text: `${event.kind}${event.detail !== undefined ? ` ${JSON.stringify(event.detail).slice(0, 120)}` : ""}`,
    });
  }

  // ── BroadcastService 归一面（③层摘要调用退役 → content 源） ──────

  ringSnapshot(): readonly PerceptionRingEntry[] {
    return this.ring;
  }

  /** 测试收口面：等待在途分诊链清空（生产 fire-and-forget）。 */
  async drain(): Promise<void> {
    await this.chain;
    while (this.inflight.size > 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // ── 内部：ring 沉淀 ───────────────────────────────────

  private pushRing(entry: PerceptionRingEntry): void {
    this.ring.push(entry);
    if (this.ring.length > PERCEPTION_RING_LIMIT) {
      this.ring = this.ring.slice(this.ring.length - PERCEPTION_RING_LIMIT);
    }
    // M3-d1：ring 六类条目沉淀活动账（隔离面——回调异常不炸感知主链路）
    try {
      this.deps.onRingEntry?.(entry);
    } catch {
      // 账本侧自记降级（记账失败不阻断感知；StewardActivityService 内部
      // 已 warn 可观测——此处二次防御仅防御回调面自身抛错）
    }
  }

  private ringEntryOf(event: DomainEvent): PerceptionRingEntry | undefined {
    switch (event.type) {
      case "agent.completed":
      case "agent.failed":
      case "agent.killed": {
        const p = event.payload as AgentCompletedPayload | AgentFailedPayload | AgentKilledPayload;
        return {
          at: this.now(),
          kind: event.type,
          sessionId: event.sessionId,
          agentId: p.agentId,
          text: p.closure?.summary?.slice(0, 120) ?? "",
        };
      }
      case "steer.queued": {
        // 周期进展 ping（D12-① 汇报分级：只进 ring 零 LLM 零唤醒主线之外的
        // 第二消费面；主线侧注入由 reportIntervalMs opt-in 语义保持）
        const p = event.payload as { text?: string; source?: string };
        if (p.source !== "progress") return undefined;
        return {
          at: this.now(),
          kind: "progress.ping",
          sessionId: event.sessionId,
          text: (p.text ?? "").slice(0, 200),
        };
      }
      case "turn.completed": {
        // 会话回合终态（设计 D10 系统族最后一块订阅面——主会话回合结束）：
        // 恒入 ring（感知记录，零 LLM）；回复锚在 replyDiagnosisInputOf
        // ——仅投递关注命中的会话（用户在等回复），无关注零分诊（成本闸）。
        const p = event.payload as { reason?: string; replyEntryId?: string };
        return {
          at: this.now(),
          kind: "turn.completed",
          sessionId: event.sessionId,
          text: `回合结束（${p.reason ?? "done"}${p.replyEntryId !== undefined ? ` #${p.replyEntryId.slice(0, 8)}` : ""}）`,
        };
      }
      default:
        return undefined;
    }
  }

  // ── 内部：分诊锚与输入构造 ─────────────────────────────

  /** 回复锚判定（2026-10-08 裁决后唯一 LLM 分诊锚）：投递关注命中的
   *  turn.completed——notify 机械短讯 + 管家语音详略轨。agent.* 终态
   *  零分诊零播报（用户只关心任务整体；事件照入 ring）。 */
  private replyDiagnosisInputOf(event: DomainEvent): DiagnosisInput | undefined {
    if (event.type !== "turn.completed") return undefined;
    // 投递关注命中（deliver_to_session 投递后的「那边回完了」）：一次性
    // 消费关注表（一次投递等一次回复）；reason=daemon_restarted 是重启
    // 恢复不是回复——保留关注不消费不通知。
    const p = event.payload as { reason?: string };
    if (p.reason === "daemon_restarted") return undefined;
    const awaiting = this.awaitingReply.get(event.sessionId);
    if (awaiting === undefined) return undefined;
    this.awaitingReply.delete(event.sessionId);
    this.persistWatchSnapshot(); // 消费即重写快照（跨重启不重复通知）
    const lines = [
      "事件：用户投递过消息的对话回合结束（回复就绪）",
      `会话：${event.sessionId}`,
      `回合终态：${p.reason ?? "done"}`,
      `用户投递的内容：${awaiting.text || "（无文本）"}`,
    ];
    return {
      key: `turn.reply:${event.sessionId}:${awaiting.at}`,
      voiceKind: "agent.completed",
      voiceAgentId: event.sessionId,
      taskTitle: "对话回复了",
      notifyBody: "回完了，具体我语音里说",
      replyContextSessionId: event.sessionId, // runDiagnosis 异步取回复正文
      fallbackText: "那个对话回你了", // 未启用/分诊失败/空文本三路保底（白话）
      userPrompt: lines.join("\n"),
    };
  }

  // ── 内部：分诊编排（启用门 + in-flight 归一 + 产物消费） ────────

  /** 分诊入口：启用（money gate+模型配）→ 串行链上跑一次（事件键 in-flight
   *  去重——BroadcastService content 源与事件入口双触发共用同一调用：归一
   *  断言 calls=1 的落点）；未启用零入链零 LLM。v2.9：激活不是门槛（分诊
   *  恒做，激活只决定投递面）。 */
  private ensureDiagnosis(input: DiagnosisInput): Promise<StewardDiagnosisResult | undefined> {
    // 启用门（管家开∧总结开∧模型配——port 三条件收口）；未启用（money
    // gate 关）→ 回复锚机械保底 notify + 语音同句（白话句，事件不静默）
    if (this.deps.diagnose === undefined || !this.deps.diagnose.isAvailable()) {
      if (input.fallbackText !== undefined) {
        this.emitFallbackDelivery(input);
      }
      return Promise.resolve(undefined);
    }
    const existing = this.inflight.get(input.key);
    if (existing !== undefined) return existing.promise; // 归一去重
    const step = this.chain.then(() => this.runDiagnosis(input));
    this.chain = step.then(
      () => undefined,
      () => undefined,
    ); // 链推进（异常吞掉保链不断）
    this.inflight.set(input.key, { promise: step });
    void step.finally(() => this.inflight.delete(input.key));
    return step;
  }

  /** 一次分诊调用 + 消费（回复锚专用：notify 机械短讯恒发——分诊失败/空
   *  文本走 fallbackText 保底句，事件不静默；语音详略轨——verbose=detail
   *  逐项上嘴（≤600 截断），否则 present 一句（≤60）；ring 摄入轨照记）。 */
  private async runDiagnosis(input: DiagnosisInput): Promise<StewardDiagnosisResult | undefined> {
    const port = this.deps.diagnose;
    if (port === undefined || !port.isAvailable()) return undefined;
    try {
      let userPrompt = input.userPrompt;
      if (input.replyContextSessionId !== undefined) {
        let replyBlock = "（无回复正文可读）";
        try {
          const reply = await this.deps.readReply?.(input.replyContextSessionId);
          if (reply !== undefined && reply.trim() !== "") replyBlock = reply.trim();
        } catch {
          // 读面失败保底标注（诊断照常）
        }
        userPrompt = `${userPrompt}\n回复内容（尾部截取）：${replyBlock}`;
      }
      const { result, verbose } = await this.diagnoseOrJudge(port, input, userPrompt);
      const present = this.clampPresent(result.present);
      const detail = result.detail !== undefined ? this.clampBody(result.detail) : undefined;
      const voiceDetail = result.detail !== undefined ? this.clampVoiceDetail(result.detail) : undefined; // 语音轨独立预算（600 视觉预算不误伤长报告）
      if (result.ingest.trim() !== "") {
        this.pushRing({
          at: this.now(),
          kind: "task.diagnosed",
          sessionId: input.voiceAgentId,
          text: present !== "" ? present : (detail ?? ""),
          ingest: result.ingest,
        });
      }
      // 语音详略轨（白话硬约束——详文归宿是管家语音；详报用语音轨预算）
      let voiceText = verbose && voiceDetail !== undefined && voiceDetail !== "" ? voiceDetail : present;
      let notifyBody = input.notifyBody ?? input.fallbackText ?? "那个对话回你了";
      if (voiceText === "") {
        // 空文本兑底：保底白话句（事件不静默——notify 机械短讯照发）
        voiceText = input.fallbackText ?? "那个对话回你了";
        notifyBody = voiceText;
      }
      // 语音激活绑定（C 裁决）：详报只在光球在场时上嘴；不在场 = notify 机械短讯静默告知
      if (this.isActive()) {
        this.deps.voice?.enqueueDiagnosed({ kind: input.voiceKind, agentId: input.voiceAgentId, text: voiceText });
      }
      // notify 机械短讯（白话——通知生命周期短，写多也看不完）
      const now = this.now();
      this.normalSentAt = this.normalSentAt.filter((t) => now - t < NOTIFY_BUDGET_WINDOW_MS);
      if (this.normalSentAt.length >= NOTIFY_NORMAL_HOURLY_LIMIT) {
        this.deps.logger?.warn(`管家通知预算超限（回复机械短讯丢弃）：${notifyBody.slice(0, 40)}`);
        return result;
      }
      this.normalSentAt.push(now);
      const title = input.taskTitle ?? "对话回复了";
      this.notifySeq += 1;
      this.deps.emitNotify?.({
        urgency: "normal",
        title,
        body: notifyBody,
        seq: this.notifySeq,
      });
      if (this.isActive()) {
        this.deps.reportDialog?.({ title, text: notifyBody, suggestions: [] });
      }
      return result;
    } catch (err) {
      this.deps.logger?.warn(`管家分诊降级（${input.key}）：${(err as Error).message}`);
      if (input.fallbackText !== undefined) {
        this.emitFallbackDelivery(input);
      }
      return undefined;
    }
  }

  /** 判定/生成拆面（2026-10-08 裁决）：判官开启且就绪 → noul 单判详略
   *  （verbose——零格式风险）+ 生成纯文本两段制白话；不可用/抛错 → 回退
   *  现行 LLM JSON 路径（detail 在场决定详略——回退语义）。 */
  private async diagnoseOrJudge(
    port: StewardDiagnosisPort,
    input: DiagnosisInput,
    userPrompt: string,
  ): Promise<{ result: StewardDiagnosisResult; verbose: boolean }> {
    const judge = this.deps.triageJudge;
    if (judge !== undefined && judge.enabled() && judge.ready()) {
      try {
        const verbose = (await judge.noul(userPrompt, TRIAGE_JUDGE_VERBOSE_QUESTION)) >= TRIAGE_JUDGE_VERBOSE_THRESHOLD;
        const text = await port.generateText({ systemPrompt: TRIAGE_GENERATION_SYSTEM_PROMPT, userPrompt });
        return this.resultOfGeneratedText(text, verbose);
      } catch (err) {
        // 判官抛错即降级不重试（E-214 同款保守语义；生成段 LLM 失败同路回退）
        this.deps.logger?.warn(
          `分诊判官判定路径失败（${input.key}）：${(err as Error).message}——回退 LLM JSON 判定路径`,
        );
      }
    } else if (judge !== undefined && judge.enabled()) {
      // 开关开但端点未配/已删/非 classifier——值得提醒（用户预期判官生效）
      this.deps.logger?.warn(
        `分诊判官开启但端点未配或已失效（${input.key}）——回退 LLM JSON 判定路径`,
      );
    }
    // 回退（判官关/未配/抛错）：detail 在场决定详略
    const result = await port.diagnose({ systemPrompt: DIAGNOSIS_SYSTEM_PROMPT, userPrompt });
    return { result, verbose: result.detail !== undefined };
  }

  /** 纯文本两段制 → 分诊产物（烂文本也是文本——无「解析失败」类别）：
   *  空行分段——第一段 = present、余段合并 = detail（单块但含单换行时按首行
   *  /余行兑底拆分）；截断兑底归消费面 clampPresent/clampBody（≤60/≤600）；
   *  ingest = 完整生成文本原样；verbose 附着（详略裁决传消费面）。 */
  private resultOfGeneratedText(text: string, verbose?: boolean): { result: StewardDiagnosisResult; verbose: boolean } {
    let paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (paragraphs.length === 1 && paragraphs[0]!.includes("\n")) {
      // 单块多行兑底：首行 = 口语句，余行 = 正文
      const [first, ...rest] = paragraphs[0]!.split("\n");
      paragraphs = [first!.trim(), rest.join("\n").trim()].filter((p) => p !== "");
    }
    const present = paragraphs[0] ?? "";
    const detail = paragraphs.length > 1 ? paragraphs.slice(1).join("\n") : undefined;
    return {
      result: {
        notify: true,
        urgency: "normal",
        present,
        ...(detail !== undefined ? { detail } : {}),
        ingest: text.trim(),
        suggestions: [],
      },
      verbose: verbose ?? true,
    };
  }

  /** 机械保底投递（未启用/分诊失败两路共用）：保底白话句 notify + 语音
   *  同句（预算照过——防降级风暴轰炸）；激活态补对话内汇报。 */
  private emitFallbackDelivery(input: DiagnosisInput): void {
    const text = input.fallbackText ?? "那个对话回你了";
    const now = this.now();
    this.normalSentAt = this.normalSentAt.filter((t) => now - t < NOTIFY_BUDGET_WINDOW_MS);
    if (this.normalSentAt.length >= NOTIFY_NORMAL_HOURLY_LIMIT) {
      this.deps.logger?.warn(`管家保底通知预算超限，丢弃：${text.slice(0, 40)}`);
      return;
    }
    this.normalSentAt.push(now);
    if (this.isActive()) {
      this.deps.voice?.enqueueDiagnosed({ kind: input.voiceKind, agentId: input.voiceAgentId, text });
    }
    const title = input.taskTitle ?? "对话回复了";
    this.notifySeq += 1;
    this.deps.emitNotify?.({
      urgency: "normal",
      title,
      body: text,
      seq: this.notifySeq,
    });
    if (this.isActive()) {
      this.deps.reportDialog?.({ title, text, suggestions: [] });
    }
  }

  /** 呈现轨防御截断（≤60 字 + 省略号——prompt 约束外兑底）。 */
  private clampPresent(present: string): string {
    const trimmed = present.trim();
    const chars = [...trimmed];
    if (chars.length <= NOTIFY_PRESENT_MAX_CHARS) return trimmed;
    return `${chars.slice(0, NOTIFY_PRESENT_MAX_CHARS).join("")}…`;
  }

  /** 正文轨防御截断（≤600 字 + 省略号——双预算分轨的视觉面兑底）。 */
  private clampBody(detail: string): string {
    const trimmed = detail.trim();
    const chars = [...trimmed];
    if (chars.length <= NOTIFY_BODY_MAX_CHARS) return trimmed;
    return `${chars.slice(0, NOTIFY_BODY_MAX_CHARS).join("")}…`;
  }

  /** 语音详报轨防御截断（≤2000 字 + 省略号——语音/视觉分轨：听 600 字只要
   *  两分钟，视觉预算不该误伤长报告语音）。 */
  private clampVoiceDetail(detail: string): string {
    const trimmed = detail.trim();
    const chars = [...trimmed];
    if (chars.length <= VOICE_DETAIL_MAX_CHARS) return trimmed;
    return `${chars.slice(0, VOICE_DETAIL_MAX_CHARS).join("")}…`;
  }
}
