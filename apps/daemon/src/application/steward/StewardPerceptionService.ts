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
 * in-flight 调用，事件键去重，一次事件恒一次调用）：
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

/** 通知预算：normal 档滑动窗口时长（D12-⑦「如 ≤4 条/小时」）。 */
export const NOTIFY_BUDGET_WINDOW_MS = 60 * 60_000;

/** 通知预算：normal 档窗口内上限（high 档豁免）。 */
export const NOTIFY_NORMAL_HOURLY_LIMIT = 4;

/** ring buffer 条目（D11 ①层原始事件流 + ⑩ 摄入轨工作记录）。 */
export interface PerceptionRingEntry {
  /** 记录时刻（epoch ms）。 */
  readonly at: number;
  /** 记录类别：agent 终态三值 / 周期进展 ping / 任务终态事实 / 分诊摄入轨 / 表面事件。 */
  readonly kind:
    | "agent.completed"
    | "agent.failed"
    | "agent.killed"
    | "progress.ping"
    | "task.terminal"
    | "task.diagnosed"
    | "surface.event";
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
  /** 分诊 userPrompt 素材（终态事实 + ring 现场投影）。 */
  readonly userPrompt: string;
}

/** 分诊器系统提示词（双轨协议单点——JSON 判别 + 派生关系约束）。 */
export const DIAGNOSIS_SYSTEM_PROMPT = [
  "你是 helix 管家的分诊器：判断一个刚结束的后台任务值不值得主动告诉用户，并产出两份摘要。",
  "输出必须是单个 JSON 对象（无围栏无解释），字段：",
  '- notify: 布尔——是否值得打扰用户（不值得 = false，静默）',
  '- urgency: "normal" 或 "high"（仅高危：失败阻塞、数据风险、预算耗尽）',
  "- present: 给用户听的一句话，口语化中文，不超过 60 字",
  "- ingest: 给管家分析用的全面记录，结构化分节：做了什么/改动面/发现统计/阻塞/下一步，总长不超过 2000 字",
  "- suggestions: 建议按钮数组，每项 {label: 短句}，最多 3 条（完成只是事实，接续才是价值：开修复/投递下一会话/跳报告）",
  "硬约束：present 的内容必须出自 ingest 已写明的事实（呈现轨是摄入轨的投影，不得编造 ingest 没有的信息）。",
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

  constructor(deps: StewardPerceptionDeps) {
    this.deps = deps;
    this.now = deps.clock ?? (() => Date.now());
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
    // 启用门（D12-⑨/⑫：管家开∧总结开∧模型配——port 三条件收口）
    if (this.deps.diagnose === undefined || !this.deps.diagnose.isAvailable()) {
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
      const result = await port.diagnose({ systemPrompt: DIAGNOSIS_SYSTEM_PROMPT, userPrompt: input.userPrompt });
      const present = this.clampPresent(result.present);
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
      this.emitDeliveryCapped(result, present, input);
      return result;
    } catch (err) {
      this.deps.logger?.warn(`管家分诊降级（${input.key}）：${(err as Error).message}`);
      return undefined;
    }
  }

  /** 主动投递面收口（通知预算 + 投递面分支）：normal 滑动窗 ≤4 条/小时
   *  （high 豁免）——超限丢弃 notify 帧与对话内汇报（同属主动投递，共用
    *  预算防轰炸；语音照播——播报队列独立限流）；激活 = 对话内主动汇报
   *  + notify；未激活 = notify/语音异步零对话插话（v2.9）。 */
  private emitDeliveryCapped(result: StewardDiagnosisResult, present: string, input: DiagnosisInput): void {
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
        body: present,
        ...(suggestions.length > 0 ? { suggestions } : {}),
        seq: this.notifySeq,
      });
    }
    // 投递面分支（D12-⑪/⑫）：激活 = 对话内主动汇报（接续提案对话内提出）
    if (this.isActive()) {
      this.deps.reportDialog?.({ title, text: present, suggestions });
    }
  }

  /** 呈现轨防御截断（≤60 字 + 省略号——prompt 约束外兑底）。 */
  private clampPresent(present: string): string {
    const trimmed = present.trim();
    const chars = [...trimmed];
    if (chars.length <= NOTIFY_PRESENT_MAX_CHARS) return trimmed;
    return `${chars.slice(0, NOTIFY_PRESENT_MAX_CHARS).join("")}…`;
  }
}
