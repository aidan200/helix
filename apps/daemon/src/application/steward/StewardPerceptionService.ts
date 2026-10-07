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
 * 分诊（D12-⑨/⑩）：门控事件（job done 任务级锚 / agent.failed/killed
 * agent 级即报 / 非 task 会话 agent.completed）→ 启用 → **一次 LLM 调用
 * 双轨产物**（StewardDiagnosisPort——与原 E-232 ③层摘要归一：
 * BroadcastService 内容源回调 supplyBroadcastText 与本服务共用同一
 * in-flight 调用，事件键去重，一次事件恒一次调用）。判官判定面（分诊
 * 判官接入批）：判官开启且就绪 → noul 校准概率双判（值得 ≥0.5 / 高危
 * ≥0.5）接管 notify/urgency 判别，不值得 = 静默零 LLM；生成面转纯文本
 * 两段制（禁 JSON 包装，烂文本截断兑底无解析失败类别）；关闭/未配/抛错
 * → 回退现行单次 LLM JSON 路径（d7449d79 基线零变化）：
 * - 摄入轨 → ring buffer 工作记录 + recordSessionProgress 薄条目（E-247
 *   机制零改动只调用——120 码点覆盖更新，全文不进长期记忆）；非激活完成
 *   的任务**同样产摄入轨**（回来能看到干了什么——D12-⑪ v2.9 注记）；
 * - 呈现轨 → 语音（agent 级经 content 源占位替换 / 任务级锚
 *   enqueueDiagnosed 直供——各自单路，防双路重播）+ steward.notify 帧
 *   （限流后；title=任务标题机械字段、suggestions=LLM 接续提案 +
 *   机械 [看看报告]）+ 对话内主动汇报（激活态 reportDialog 面）。
 * 未启用/降级态：零 LLM；任务级完成锚恒报终态事实（极简语音直供——
 * 「后台任务已完成」，D12-⑨ 机械降级路径零新造）。
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
import type { BroadcastContentResult } from "../voice/BroadcastService";
import type { StewardNotifyPayload, StewardNotifySuggestion, SurfaceEvent, VoiceBroadcastKind } from "@helix/protocol";

/** 任务会话 id 前缀（完成类聚合判别——task:* 会话的 agent.completed 不在
 *  agent 级播报，聚任务级锚；与 TaskOrchestratorService.TASK_SESSION_PREFIX
 *  同值，application 层不 import 编排服务（域间窄面纪律），字面量单源注释互指）。 */
const TASK_SESSION_PREFIX = "task:";

/** ring buffer 滚动上限（内存有界——D11 ①层：原始事件流滚动淘汰，不落盘）。 */
export const PERCEPTION_RING_LIMIT = 200;

/** 激活信号②近期 ask 衰减窗（毫秒——v1 常量起步，brief 实施顺序②；设计⑪
 *  「衰减窗 N 分钟，参数」——未上配置面（范围钳制：不建新配置项），演进
 *  待激活信号升 SurfaceRegistry 后一并评估）。 */
export const STEWARD_ACTIVE_WINDOW_MS = 5 * 60_000;

/** notify 呈现轨字数上限（设计⑩：≤60 字口语；超长截断加省略号——LLM
 *  产物防御，与语音播报 80 字符兜底同族）。 */
export const NOTIFY_PRESENT_MAX_CHARS = 60;

/** notify 正文轨字数上限（双预算分轨：语音短句 ≤60，视觉正文可到 200——
 *  用户反馈批「摘要不细致」；detail 缺席回退 present 单轨）。 */
export const NOTIFY_BODY_MAX_CHARS = 200;

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
  /** 任务标题（机械字段——notify title 用，非 UUID；仅任务级锚携带）。
   *  来源：TaskOrchestratorService.titleOf（skill 任务说明首段 + 项目语境）。 */
  readonly taskTitle?: string;
  /** 语音直供判别：true = 任务级锚（无 BroadcastService 占位——enqueueDiagnosed
   *  直供）；false = agent 级（呈现轨经 content 源占位替换——直供会双路重播）。 */
  readonly directVoice: boolean;
  /** progress 薄条目锚（缺席 = 不写 progress——agent 级即报无会话锚语义）。 */
  readonly progressSessionId?: string;
  /** 任务锚建议动作（去任务页看报告——点按才动）。 */
  readonly openTasksSuggestion?: boolean;
  /** 回复正文读面锚（修复①：回合终态分诊取「那边回了什么」——runDiagnosis
   *  异步读后拼入 userPrompt；缺席 = 不补正文段）。 */
  readonly replyContextSessionId?: string;
  /** 未启用（money gate 关）极简保底语音（修复③：turn-reply 锚「投递的
   *  会话已回复」——对齐 task.done「后台任务已完成」降级语义）。 */
  readonly fallbackText?: string;
  /** 分诊 userPrompt 素材（终态事实 + ring 现场投影 + 可选回复正文）。 */
  readonly userPrompt: string;
}

/** 分诊器系统提示词（双轨协议单点——JSON 判别 + 派生关系约束）。 */
export const DIAGNOSIS_SYSTEM_PROMPT = [
  "你是 helix 管家的分诊器：判断一个刚结束的后台任务值不值得主动告诉用户，并产出两份摘要。",
  "输出必须是单个 JSON 对象（无围栏无解释），字段：",
  '- notify: 布尔——是否值得打扰用户（不值得 = false，静默）',
  '- urgency: "normal" 或 "high"（仅高危：失败阻塞、数据风险、预算耗尽）',
  "- present: 给用户听的一句话，口语化中文，不超过 60 字",
  "- detail: 通知正文，中文要点摘要，可到 200 字，带具体结果与结论（缺席时通知用 present）",
  "- ingest: 给管家分析用的全面记录，结构化分节：做了什么/改动面/发现统计/阻塞/下一步，总长不超过 2000 字",
  "- suggestions: 建议按钮数组，每项 {label: 短句}，最多 3 条（完成只是事实，接续才是价值：开修复/投递下一会话/跳报告）",
  "硬约束：present 的内容必须出自 ingest 已写明的事实（呈现轨是摄入轨的投影，不得编造 ingest 没有的信息）。",
].join("\n");

// ── 分诊判官判定面常量（管家分诊判官接入批）────────────────────

/** 判官阈值（noul 校准概率 ≥ 此值 = 是——E-214 记忆查重 0.5 同款）。 */
export const TRIAGE_JUDGE_THRESHOLD = 0.5;

/** 判官问句①：值不值得主动通知（问题文本单源常量——测试直引，防措辞漂移
 *  导致判定语义漂移）。 */
export const TRIAGE_JUDGE_WORTH_QUESTION =
  "这个事件值得主动通知用户吗？（用户投递过消息在等回复 / 任务失败阻塞 / 数据风险 = 值得；例行完成且用户无等待 = 不值得）";

/** 判官问句②：高危与否（与 DIAGNOSIS_SYSTEM_PROMPT urgency 字段同口径）。 */
export const TRIAGE_JUDGE_HIGH_RISK_QUESTION = "高危吗？（失败阻塞 / 数据风险 / 预算耗尽）";

/** 判官路径生成段系统提示词：纯文本两段制——禁 JSON/围栏/前缀（聊天模型
 *  填表形态错配是现行解析失败的根因；本路径零格式风险）。 */
export const TRIAGE_GENERATION_SYSTEM_PROMPT = [
  "你是 helix 管家的通知文案撰写器：一个后台事件刚刚结束，已裁定值得通知用户。",
  "直接输出两个自然段，禁止 JSON、代码围栏、标题或编号前缀及任何格式包装：",
  "第一段：给用户听的一句话，口语化中文，不超过 60 字。",
  "第二段：通知正文要点摘要，中文，不超过 200 字，写清具体结果与结论。",
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
   *  服务 supplyBroadcastText）；缺席 = 零语音。 */
  readonly voice?: { enqueueDiagnosed(item: { kind: VoiceBroadcastKind; agentId: string; text: string }): void };
  /** 回复正文读面（修复①：回合终态分诊输入补「那边回了什么」——组合根接
   *  SessionRepository.readSessionTail 尾投影取末条 assistant；缺席 = prompt
   *  标注无正文，读面失败不阻塞诊断）。 */
  readonly readReply?: (sessionId: string) => Promise<string | undefined>;
  /** 投递关注持久化 kv（修复②：RuntimeConfigPort 窄面——单键整图快照，跨
   *  重启恢复 + TTL 过滤；缺席 = 纯内存形态（回归兼容）。 */
  readonly kv?: { get(key: string): string | undefined; set(key: string, value: string): Promise<void> };
  /** 时钟（缺省 Date.now——测试注入衰减窗/限流窗步进）。 */
  readonly clock?: () => number;
  readonly logger?: { warn(message: string): void };
}

/** 分诊一次调用的完整上下文（in-flight 去重 + 产物消费）。 */
interface DiagnosisFlight {
  readonly promise: Promise<StewardDiagnosisResult | undefined>;
}

export class StewardPerceptionService {
  private readonly deps: StewardPerceptionDeps;
  private readonly now: () => number;
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
    return this.now() - this.lastAskAt <= STEWARD_ACTIVE_WINDOW_MS;
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
    const input = this.agentLevelDiagnosisInputOf(event);
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
      text: `任务 ${jobId} 终态：${status}`,
    });
    if (status !== "done") return;
    // 未启用（money gate/模型配断点）：恒报终态事实（极简语音直供——
    // D12-⑨ 机械降级，零 LLM）；启用态分诊恒做（不看激活——v2.9）
    if (this.deps.diagnose === undefined || !this.deps.diagnose.isAvailable()) {
      this.deps.voice?.enqueueDiagnosed({ kind: "task.done", agentId: sessionId, text: "后台任务已完成" });
      return;
    }
    this.ensureDiagnosis(this.taskDoneInput(jobId, sessionId, title));
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
      text: `${event.kind}${event.detail !== undefined ? ` ${JSON.stringify(event.detail).slice(0, 120)}` : ""}`,
    });
  }

  // ── BroadcastService 归一面（③层摘要调用退役 → content 源） ──────

  /**
   * BroadcastService 内容源（deps.content 回调目标）：事件 → 分诊呈现轨
   * 文本。与事件入口共用 in-flight（归一：一次事件一次 LLM 调用）；
   * unavailable = 无分诊（未启用/gate 断点）→ BroadcastService 回退②层
   * 极简终态通知（回归保护面）。
   */
  async supplyBroadcastText(event: DomainEvent): Promise<BroadcastContentResult> {
    const input = this.agentLevelDiagnosisInputOf(event);
    if (input === undefined) return { kind: "unavailable" };
    const result = await this.ensureDiagnosis(input);
    if (result === undefined) return { kind: "unavailable" };
    if (!result.notify || result.present.trim() === "") return { kind: "silent" };
    return { kind: "text", text: this.clampPresent(result.present) };
  }

  // ── 读面 ─────────────────────────────────────────────

  /** ring buffer 快照（测试/诊断读面——ask 时投影消费面后续批次接）。 */
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
        // 恒入 ring（感知记录，零 LLM）；分诊锚在 agentLevelDiagnosisInputOf
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

  /** agent 级分诊锚判定：failed/killed 即报 + 非 task 会话 completed（task
   *  会话完成类聚合任务级锚——onJobTerminal 唯一触发面）。 */
  private agentLevelDiagnosisInputOf(event: DomainEvent): DiagnosisInput | undefined {
    switch (event.type) {
      case "agent.failed": {
        const p = event.payload as AgentFailedPayload;
        return {
          key: `agent.failed:${p.agentId}`,
          voiceKind: "agent.failed",
          voiceAgentId: p.agentId,
          directVoice: false, // 呈现轨经 content 源占位替换（BroadcastService 单路）
          userPrompt: [
            "事件：后台实例失败",
            `实例：${p.agentId}`,
            `错误：${p.error?.slice(0, 500) ?? ""}`,
            `closure 摘要：${p.closure?.summary ?? ""}`,
          ].join("\n"),
        };
      }
      case "agent.killed": {
        const p = event.payload as AgentKilledPayload;
        return {
          key: `agent.killed:${p.agentId}`,
          voiceKind: "agent.killed",
          voiceAgentId: p.agentId,
          directVoice: false,
          userPrompt: [
            "事件：后台实例被终止",
            `实例：${p.agentId}`,
            `closure 摘要：${p.closure?.summary ?? ""}`,
          ].join("\n"),
        };
      }
      case "agent.completed": {
        const p = event.payload as AgentCompletedPayload;
        if (event.sessionId.startsWith(TASK_SESSION_PREFIX)) return undefined; // 聚任务级
        return {
          key: `agent.completed:${p.agentId}`,
          voiceKind: "agent.completed",
          voiceAgentId: p.agentId,
          directVoice: false,
          userPrompt: [
            "事件：后台实例完成",
            `实例：${p.agentId}`,
            `closure 摘要：${p.closure?.summary ?? ""}`,
          ].join("\n"),
        };
      }
      case "turn.completed": {
        // 投递关注命中（deliver_to_session 投递后的「那边回完了」）：一次性
        // 消费关注表（一次投递等一次回复）；reason=daemon_restarted 是重启
        // 恢复不是回复——保留关注不消费不通知。
        const p = event.payload as { reason?: string };
        if (p.reason === "daemon_restarted") return undefined;
        const awaiting = this.awaitingReply.get(event.sessionId);
        if (awaiting === undefined) return undefined;
        this.awaitingReply.delete(event.sessionId);
        this.persistWatchSnapshot(); // 修复②：消费即重写快照（跨重启不重复通知）
        const lines = [
          "事件：用户投递过消息的会话回合结束（回复就绪）",
          `会话：${event.sessionId}`,
          `回合终态：${p.reason ?? "done"}`,
          `用户投递的内容：${awaiting.text || "（无文本）"}`,
        ];
        return {
          key: `turn.reply:${event.sessionId}:${awaiting.at}`,
          voiceKind: "agent.completed",
          voiceAgentId: event.sessionId,
          directVoice: true,
          taskTitle: "会话回复了",
          replyContextSessionId: event.sessionId, // 修复①：runDiagnosis 异步取回复正文
          fallbackText: "投递的会话已回复", // 修复③：未启用极简保底
          userPrompt: lines.join("\n"),
        };
      }
      default:
        return undefined;
    }
  }

  /** 任务级完成锚输入：终态事实 + ring 现场投影（批次 closure 素材——
   *  分诊 LLM 看 ring 全貌才能写双轨，D11 ask 时投影同构）。 */
  private taskDoneInput(jobId: string, sessionId: string, title?: string): DiagnosisInput {
    const lines: string[] = [`事件：任务整体完成（jobId=${jobId}）`];
    const batchRecords = this.ring.filter((r) => r.sessionId === sessionId && r.kind !== "task.diagnosed").slice(-20);
    if (batchRecords.length > 0) {
      lines.push("批次现场（ring 投影）：");
      for (const r of batchRecords) {
        lines.push(`- [${r.kind}]${r.agentId !== undefined ? ` ${r.agentId}` : ""}：${r.text}`);
      }
    } else {
      lines.push("批次现场：无批次实例记录（单批任务/锚点竞态）");
    }
    return {
      key: `task.done:${jobId}`,
      voiceKind: "task.done",
      voiceAgentId: sessionId,
      directVoice: true, // 任务级锚无 BroadcastService 占位——enqueueDiagnosed 直供
      ...(title !== undefined && title.trim() !== "" ? { taskTitle: title.trim() } : {}),
      progressSessionId: sessionId,
      openTasksSuggestion: true,
      userPrompt: lines.join("\n"),
    };
  }

  // ── 内部：分诊编排（启用门 + in-flight 归一 + 产物消费） ────────

  /** 分诊入口：启用（money gate+模型配）→ 串行链上跑一次（事件键 in-flight
   *  去重——BroadcastService content 源与事件入口双触发共用同一调用：归一
   *  断言 calls=1 的落点）；未启用零入链零 LLM。v2.9：激活不是门槛（分诊
   *  恒做，激活只决定投递面）。 */
  private ensureDiagnosis(input: DiagnosisInput): Promise<StewardDiagnosisResult | undefined> {
    // 启用门（D12-⑨/⑫：管家开∧总结开∧模型配——port 三条件收口）；未启用
    // 且锚带极简保底（turn-reply）→ 零 LLM 机械语音（对齐 task.done 降级语义）
    if (this.deps.diagnose === undefined || !this.deps.diagnose.isAvailable()) {
      if (input.fallbackText !== undefined) {
        this.deps.voice?.enqueueDiagnosed({ kind: input.voiceKind, agentId: input.voiceAgentId, text: input.fallbackText });
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

  /** 一次分诊调用 + 双轨产物消费（异常吞掉保链不断——静默降级不播半产物）。 */
  private async runDiagnosis(input: DiagnosisInput): Promise<StewardDiagnosisResult | undefined> {
    const port = this.deps.diagnose;
    if (port === undefined || !port.isAvailable()) return undefined;
    try {
      // 修复①：回合终态锚补回复正文（异步读面——LLM 能看到那边回了什么；
      // 读面缺席/报错不阻塞诊断，prompt 标注无正文）
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
      const result = await this.diagnoseOrJudge(port, input, userPrompt);
      const present = this.clampPresent(result.present);
      const body = result.detail !== undefined ? this.clampBody(result.detail) : present;
      const ingest = result.ingest.trim();
      if (ingest !== "") {
        // 摄入轨 → ring 工作记录（只活 ring，不进长期记忆——防膨胀与召回挤占）
        this.pushRing({
          at: this.now(),
          kind: "task.diagnosed",
          sessionId: input.voiceAgentId,
          jobId: input.key.startsWith("task.done:") ? input.key.slice("task.done:".length) : undefined,
          text: present,
          ingest,
        });
      }
      // progress 薄条目：任务级锚写进展状态（E-247 覆盖更新入口——120 码点
      // 截断在服务内部；呈现轨一句话即进展状态，全文靠 ring/深读闭环）
      if (input.progressSessionId !== undefined && present !== "") {
        await this.deps.memory?.recordSessionProgress(input.progressSessionId, present);
      }
      if (!result.notify || present === "") return result; // 静默裁决：零 notify 零语音零对话插话（两态一致）
      // 呈现轨 → 语音（任务级锚直供；agent 级经 content 源占位替换——单路）
      if (input.directVoice) {
        this.deps.voice?.enqueueDiagnosed({ kind: input.voiceKind, agentId: input.voiceAgentId, text: present });
      }
      // 呈现轨 → notify 帧 + 对话内主动汇报（限流后；投递面按激活分支）
      this.emitDeliveryCapped(result, present, body, input);
      return result;
    } catch (err) {
      this.deps.logger?.warn(`管家分诊降级（${input.key}）：${(err as Error).message}`);
      // 降级保底（用户反馈批「第二条通知静默丢失」实锤：解析失败 → 整体丢弃
      // → 用户在等回复的事件被静默吞掉）：锚带 fallbackText 时发机械保底
      // notify + 语音（与未启用态同形——事件真实发生，分诊失败只损失丰富度）。
      if (input.fallbackText !== undefined) {
        this.emitFallbackDelivery(input);
      }
      return undefined;
    }
  }

  /** 判定/生成拆面（管家分诊判官接入批）：判官开启且就绪 → noul 双判
   *  （值得/高危——零格式风险）+ 生成纯文本两段制；不可用/抛错 → 回退
   *  现行 LLM JSON 路径（d7449d79 基线——三重容错与机械保底均在位）。 */
  private async diagnoseOrJudge(
    port: StewardDiagnosisPort,
    input: DiagnosisInput,
    userPrompt: string,
  ): Promise<StewardDiagnosisResult> {
    const judge = this.deps.triageJudge;
    if (judge !== undefined && judge.enabled()) {
      if (judge.ready()) {
        try {
          const worth = await judge.noul(userPrompt, TRIAGE_JUDGE_WORTH_QUESTION);
          if (worth < TRIAGE_JUDGE_THRESHOLD) {
            // 判官裁决不值得：静默——零 LLM 零通知（ring 原始事件照记）；合成
            // notify=false 产物供供给面归一（supplyBroadcastText → silent，
            // 不回退极简终态通知；零摄入轨零 progress）。
            return { notify: false, urgency: "normal", present: "", ingest: "", suggestions: [] };
          }
          const highRisk =
            (await judge.noul(userPrompt, TRIAGE_JUDGE_HIGH_RISK_QUESTION)) >= TRIAGE_JUDGE_THRESHOLD;
          const text = await port.generateText({ systemPrompt: TRIAGE_GENERATION_SYSTEM_PROMPT, userPrompt });
          return this.resultOfGeneratedText(text, highRisk);
        } catch (err) {
          // 判官抛错即降级不重试（E-214 同款保守语义；生成段 LLM 失败同路回退）
          this.deps.logger?.warn(
            `分诊判官判定路径失败（${input.key}）：${(err as Error).message}——回退 LLM JSON 判定路径`,
          );
        }
      } else {
        // 开关开但端点未配/已删/非 classifier——值得提醒（用户预期判官生效）
        this.deps.logger?.warn(
          `分诊判官开启但端点未配或已失效（${input.key}）——回退 LLM JSON 判定路径`,
        );
      }
    }
    return port.diagnose({ systemPrompt: DIAGNOSIS_SYSTEM_PROMPT, userPrompt });
  }

  /** 纯文本两段制 → 分诊产物（烂文本也是文本——无「解析失败」类别）：
   *  空行分段——第一段 = present、余段合并 = detail（单块但含单换行时按首行
   *  /余行兑底拆分）；截断兑底归消费面 clampPresent/clampBody（≤60/≤200）；
   *  ingest = 完整生成文本原样（摄入轨不再要求结构化分节）；suggestions 空
   *  （LLM 不产建议——机械接续沿 emitDeliveryCapped open_tasks 提案）。 */
  private resultOfGeneratedText(text: string, highRisk: boolean): StewardDiagnosisResult {
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
      notify: true,
      urgency: highRisk ? "high" : "normal",
      present,
      ...(detail !== undefined ? { detail } : {}),
      ingest: text.trim(),
      suggestions: [],
    };
  }

  /** 机械保底投递（分诊失败降级/未启用两路共用形态）：通知预算照过 +
   *  notify（标题机械字段 + fallbackText 正文）+ directVoice 语音同句。 */
  private emitFallbackDelivery(input: DiagnosisInput): void {
    const present = input.fallbackText!;
    const now = this.now();
    // 通知预算（normal 档滑动窗 ≤4/h——保底也计入，防降级风暴轰炸）
    this.normalSentAt = this.normalSentAt.filter((t) => now - t < NOTIFY_BUDGET_WINDOW_MS);
    if (this.normalSentAt.length >= NOTIFY_NORMAL_HOURLY_LIMIT) {
      this.deps.logger?.warn(`管家保底通知预算超限，丢弃：${present.slice(0, 40)}`);
      return;
    }
    this.normalSentAt.push(now);
    if (input.directVoice) {
      this.deps.voice?.enqueueDiagnosed({ kind: input.voiceKind, agentId: input.voiceAgentId, text: present });
    }
    const title = input.taskTitle ?? "后台实例终态";
    this.notifySeq += 1;
    this.deps.emitNotify?.({
      urgency: "normal",
      title,
      body: present,
      seq: this.notifySeq,
    });
    if (this.isActive()) {
      this.deps.reportDialog?.({ title, text: present, suggestions: [] });
    }
  }

  /** 主动投递面收口（通知预算 + 投递面分支）：normal 滑动窗 ≤4 条/小时
   *  （high 豁免）——超限丢弃 notify 帧与对话内汇报（同属主动投递，共用
    *  预算防轰炸；语音照播——播报队列独立限流）；激活 = 对话内主动汇报
   *  + notify；未激活 = notify/语音异步零对话插话（v2.9）。 */
  private emitDeliveryCapped(
    result: StewardDiagnosisResult,
    present: string,
    body: string,
    input: DiagnosisInput,
  ): void {
    const now = this.now();
    if (result.urgency !== "high") {
      this.normalSentAt = this.normalSentAt.filter((t) => now - t < NOTIFY_BUDGET_WINDOW_MS);
      if (this.normalSentAt.length >= NOTIFY_NORMAL_HOURLY_LIMIT) {
        this.deps.logger?.warn(
          `管家通知预算超限（normal 窗口内已达 ${NOTIFY_NORMAL_HOURLY_LIMIT} 条，丢弃本条 notify）：${present.slice(0, 40)}`,
        );
        return; // 丢弃 notify 帧与对话内汇报（语音照播——播报队列独立限流）
      }
      this.normalSentAt.push(now);
    }
    const suggestions: StewardNotifySuggestion[] = [
      ...result.suggestions.slice(0, 3).map((s) => ({ label: s.label })),
    ];
    if (input.openTasksSuggestion && !suggestions.some((s) => s.verb === "open_tasks")) {
      suggestions.push({ label: "看看报告", verb: "open_tasks" }); // 机械接续提案（点按才动）
    }
    const title =
      input.taskTitle ??
      (input.voiceKind === "task.done" ? "任务完成" : input.voiceKind === "agent.failed" ? "后台任务失败" : "后台实例终态");
    this.notifySeq += 1;
    if (this.deps.emitNotify !== undefined) {
      this.deps.emitNotify({
        urgency: result.urgency === "high" ? "high" : "normal",
        title,
        body,
        ...(suggestions.length > 0 ? { suggestions } : {}),
        seq: this.notifySeq,
      });
    }
    // 投递面分支（D12-⑪/⑫）：激活 = 对话内主动汇报（接续提案对话内提出）
    if (this.isActive()) {
      this.deps.reportDialog?.({ title, text: body, suggestions });
    }
  }

  /** 呈现轨防御截断（≤60 字 + 省略号——prompt 约束外兑底）。 */
  private clampPresent(present: string): string {
    const trimmed = present.trim();
    const chars = [...trimmed];
    if (chars.length <= NOTIFY_PRESENT_MAX_CHARS) return trimmed;
    return `${chars.slice(0, NOTIFY_PRESENT_MAX_CHARS).join("")}…`;
  }

  /** 正文轨防御截断（≤200 字 + 省略号——双预算分轨的视觉面兑底）。 */
  private clampBody(detail: string): string {
    const trimmed = detail.trim();
    const chars = [...trimmed];
    if (chars.length <= NOTIFY_BODY_MAX_CHARS) return trimmed;
    return `${chars.slice(0, NOTIFY_BODY_MAX_CHARS).join("")}…`;
  }
}
