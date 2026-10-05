/**
 * BroadcastService —— V2 TTS 播报管道 application service（设计 §5.3
 * 播报管道①②层：规则粗筛 + 极简终态通知（回退面）+ 内容源回调）。
 *
 * 职责分层（任务总结子功能批重构 + 管家感知批 M0.5 归一）：**内容生产归
 * 管家分诊器**（StewardPerceptionService 一次 LLM 调用双轨产物——启用态
 * 供给呈现轨文本（v2.9：LLM 门槛=启用，不看激活）；原③层独立摘要调用已
 * 归一退役，E-232 叙述推翻），**语音播报只负责播**（粗筛/闸门/队列/
 * 合成/广播，不关心内容生产）。
 *
 * 链路：fanout 带名目标 voice-broadcast-bridge（wireEventFanout 装配）→
 * onDomainEvent → ①粗筛（agent.failed/killed 即报 + 非 task 会话
 * agent.completed；**task:* 会话完成类聚合任务级锚**（onJobTerminal →
 * StewardPerceptionService → enqueueDiagnosed 直供）——管家感知批粒度
 * 演进：批次收口级而非 agent 级，防多批任务逐实例轰炸）→ 闸门（连接级
 * voice 订阅零登记 = 直接丢弃——零 LLM 零合成零花费）→ 内容源回调
 * （deps.content——分诊呈现轨文本；unavailable = 回退②层极简终态通知，
 * silent = 分诊裁决静默丢弃占位；缺省 = 恒极简——纯测试/降级形态）→
 * 播放队列（串行合成串行发；上限 5 条溢出丢最旧、下一条合并「另有 N 条
 * 已跳过」提示）→ TtsPort 合成 → emit 广播帧（EventStream.broadcastVoice
 * ——仅发已订阅连接）。
 *
 * 串行保序：内容源调用挂在 drained 链上按事件到达序逐条进行（耗时不均
 * 不乱序——播报序 = 事件序）。
 *
 * 单向播报（无监听/VAD/打断——V3 范畴）；合成失败跳过该条不中断后续
 * （warn 观测，不向用户面发错误帧——播报是旁路增强面）。
 */
import type { DomainEvent, DomainEventType } from "../../domain/events/DomainEvent";
import type { TtsPort } from "../ports/outbound/TtsPort";
import type { VoiceBroadcastPayload } from "@helix/protocol";

/** 任务会话 id 前缀（完成类聚合判别——与 StewardPerceptionService 同值
 *  字面量，两处互指注释；application 层不互相 import 域服务）。 */
const TASK_SESSION_PREFIX = "task:";

/** V2 播报集合（①层规则粗筛单源）：三终态；扩集合改此处 + 测试同步。 */
const BROADCAST_EVENT_TYPES: ReadonlySet<string> = new Set(["agent.completed", "agent.failed", "agent.killed"]);

/** 粗筛判定（纯函数，测试单点）。 */
export function isBroadcastEligible(type: DomainEventType | string): boolean {
  return BROADCAST_EVENT_TYPES.has(type);
}

/**
 * agent 级播报聚合判定（管家感知批 M0.5）：task:* 会话的 agent.completed
 * 不在 agent 级播报——聚任务级锚（StewardPerceptionService.onJobTerminal
 * → enqueueDiagnosed 直供任务级播报）；失败/终止类保留 agent 级即报。
 */
export function isAggregatedToTaskLevel(event: DomainEvent): boolean {
  return event.type === "agent.completed" && event.sessionId.startsWith(TASK_SESSION_PREFIX);
}

/** 内容源产物截断上限（~80 字符防长播——分诊呈现轨防御：perception 侧
 *  已 60 字截断，此处兜底防御纵深）。 */
export const SUMMARY_MAX_CHARS = 80;

/** 内容源回调超时上限（超时回退②层极简终态通知；测试经 deps.contentTimeoutMs 注入覆盖）。 */
export const CONTENT_TIMEOUT_MS = 8000;

/** 播放队列上限（溢出丢最旧合并提示）。 */
export const QUEUE_LIMIT = 5;

/** 溢出合并提示模板（下一条播报 text 前缀）。 */
const DROPPED_NOTE = (n: number): string => `（另有 ${n} 条较早播报已跳过）`;

/**
 * 内容源判别（管家感知批 M0.5 归一面）：
 * - text = 分诊呈现轨文本（直供播报）；
 * - silent = 分诊裁决静默（丢弃播报占位——「可判不打扰而静默」）；
 * - unavailable = 无分诊（未启用/gate 断点/面缺席）→ 回退②层极简终态通知
 *   （回归保护：播报不哑）。
 * 类型定义归消费域单点（voice）；生产实现 = StewardPerceptionService
 * .supplyBroadcastText（一次事件一次 LLM 调用——in-flight 去重归一；
 * agent 级呈现轨唯一播报供给路——任务级锚走 enqueueDiagnosed 直供，
 * 两路互斥防双路重播）。
 */
export type BroadcastContentResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "silent" }
  | { readonly kind: "unavailable" };

/** 队列条目（占位-激活双态）：事件到达即占位（②层极简通知文本），内容源
 *  完成后替换激活（unavailable 回退占位文本；silent 丢弃占位）；pump 只
 *  消费 ready 前缀。 */
interface QueueItem {
  /** 占位关联键（接受序，单源）。 */
  readonly id: number;
  readonly kind: VoiceBroadcastPayload["kind"];
  readonly agentId: string;
  /** 播报文本（占位 = ②层极简通知；激活时替换为分诊呈现轨）。 */
  text: string;
  /** false = 占位（内容未就绪，pump 停在其后保序）；true = 可消费。 */
  ready: boolean;
}

/** 摘要截断（超长加省略号——分诊产物防御纵深；极简通知恒短不触发）。 */
function truncateSummary(summary: string): string {
  if (summary.length <= SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, SUMMARY_MAX_CHARS)}…`;
}

/**
 * 极简终态通知（②层，纯函数；内容源回退面）：终态三事件 → 可听懂的最小
 * 信息量播报——只报终态本身，不念 agentId（UUID 逐字念无意义）/closure
 * 摘要（技术黑话截断后听不懂）/error 原文（英文报错是噪声）；详情归
 * 视觉面（closure 通知行/会话卡片）。非播报集合事件返回 undefined（粗筛
 * 负例）。
 */
export function buildBroadcastText(event: DomainEvent): string | undefined {
  switch (event.type) {
    case "agent.completed":
      return "后台任务已完成";
    case "agent.failed":
      return "后台任务失败";
    case "agent.killed":
      return "后台任务已终止";
    default:
      return undefined;
  }
}

/** 播报闸门读面（EventStream 连接级 voice 订阅表的窄接口注入——方法名与 EventStream 同构）。 */
export interface BroadcastGate {
  /** 是否存在已订阅连接（零连接 = 零 LLM 零合成零花费）。 */
  hasVoiceSubscribers(): boolean;
  /** 当前音色偏好（最近一次订阅携带；无偏好 = undefined → adapter 默认）。 */
  voicePreference(): string | undefined;
}

export interface BroadcastServiceDeps {
  readonly tts: TtsPort;
  /** 广播帧出口（组合根接 EventStream.broadcastVoice 的载荷面）。 */
  readonly emit: (payload: VoiceBroadcastPayload) => void;
  /** 连接级订阅闸门读面。 */
  readonly gate: BroadcastGate;
  /** 内容源（管家感知批归一面：分诊呈现轨；缺席 = ②层极简通知——纯测试/
   *  降级形态）。 */
  readonly content?: (event: DomainEvent) => Promise<BroadcastContentResult>;
  /** 内容源超时上限 ms（可选，缺省 CONTENT_TIMEOUT_MS；测试注入面）。 */
  readonly contentTimeoutMs?: number;
  readonly logger?: { warn(message: string): void };
}

export class BroadcastService {
  private readonly tts: TtsPort;
  private readonly emit: (payload: VoiceBroadcastPayload) => void;
  private readonly gate: BroadcastGate;
  private readonly content?: (event: DomainEvent) => Promise<BroadcastContentResult>;
  private readonly contentTimeoutMs: number;
  private readonly logger?: { warn(message: string): void };

  private queue: QueueItem[] = [];
  private droppedCount = 0;
  private processing = false;
  private seq = 0;
  private acceptSeq = 0;
  private drained: Promise<void> = Promise.resolve();

  constructor(deps: BroadcastServiceDeps) {
    this.tts = deps.tts;
    this.emit = deps.emit;
    this.gate = deps.gate;
    this.content = deps.content;
    this.contentTimeoutMs = deps.contentTimeoutMs ?? CONTENT_TIMEOUT_MS;
    this.logger = deps.logger;
  }

  /** fanout 目标入口（wireEventFanout voice-broadcast-bridge 装配）。 */
  onDomainEvent(event: DomainEvent): void {
    if (!isBroadcastEligible(event.type)) return;
    // 完成类聚合（管家感知批 M0.5）：task 会话的 agent.completed 不在 agent
    // 级播报——任务级锚（StewardPerceptionService.onJobTerminal）经
    // enqueueDiagnosed 直供任务级播报。
    if (isAggregatedToTaskLevel(event)) return;
    // 闸门（money gate）：无订阅连接直接丢弃——不调内容源（LLM 花钱）不合成不排队
    if (!this.gate.hasVoiceSubscribers()) return;
    const fallback = buildBroadcastText(event);
    if (fallback === undefined) return;
    const kind = event.type as VoiceBroadcastPayload["kind"];
    const agentId = (event.payload as { agentId: string }).agentId;
    // 同步占位（②层极简通知文本）：溢出丢弃判定在事件到达面（同旧语义——burst
    // 连发即限流，不等内容就绪）；内容源完成后替换激活，挂 drained 链按
    // 到达序串行（耗时不均不乱序）。id 闭包捕获局部常量——链步异步执行时
    // 不得回读 this.acceptSeq（多事件连发时全错位→队列死锁）。
    const id = this.nextId();
    this.enqueue({ id, kind, agentId, text: fallback, ready: false });
    this.drained = this.drained.then(() => this.resolveAndActivate(event, id, fallback));
  }

  /**
   * 分诊直供播报面（管家感知批 M0.5）：StewardPerceptionService 任务级锚
   *  极简直供（呈现轨/机械保底已产文本，零内容回调），入队即 ready；闸门
   *  单点保持（无订阅连接 = 零入队零合成）。溢出语义与事件占位同队列同
   *  规则。agent 级事件不经此面（呈现轨经 content 源占位替换——防双路重播）。
   */
  enqueueDiagnosed(item: { kind: VoiceBroadcastPayload["kind"]; agentId: string; text: string }): void {
    if (!this.gate.hasVoiceSubscribers()) return;
    this.enqueue({ id: this.nextId(), kind: item.kind, agentId: item.agentId, text: item.text, ready: true });
    void this.pump();
  }

  /**
   * 测试收口面：等待在途内容/合成队列清空（生产不调用——fire-and-forget）。
   * 串行保证：drained 链逐条 await（内容+合成），processing 序防 pump 重入。
   */
  async drain(): Promise<void> {
    await this.drained;
    while (this.processing || this.queue.some((item) => item.ready)) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** 内容源 + 激活 + 泵（drained 链上单步；任何异常吞掉防断链——回退面在 resolveContent 内收口）。 */
  private async resolveAndActivate(event: DomainEvent, id: number, fallback: string): Promise<void> {
    try {
      const outcome = await this.resolveContent(event, fallback);
      const item = this.queue.find((q) => q.id === id);
      if (item === undefined) {
        // 占位已被溢出丢弃（在途条目被更早事件挤出——链上内容已花费，观测后放行）
        this.logger?.warn(`语音播报内容就绪但条目已被溢出丢弃（id=${id}）：跳过播报`);
        return;
      }
      if (outcome === null) {
        // 分诊裁决静默：丢弃占位（不播极简——「可判不打扰而静默」）
        this.queue = this.queue.filter((q) => q.id !== id);
        return;
      }
      item.text = outcome;
      item.ready = true;
      await this.pump();
    } catch (err) {
      // 兜底（resolveContent/pump 内部已各自捕获；此处保 drained 链不断——断链即后续事件全哑）
      this.logger?.warn(`语音播报处理异常（跳过 id=${id}）：${(err as Error).message}`);
    }
  }

  /** 内容源调用：面缺席/unavailable → fallback（极简通知）；text → 截断
   *  防御；silent → null（静默丢弃哨兵）；超时 → fallback（分诊链迟到
   *  产物由感知服务自行消费 notify/ingest，语音不白等）。 */
  private async resolveContent(event: DomainEvent, fallback: string): Promise<string | null> {
    const content = this.content;
    if (content === undefined) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = content(event);
      call.catch(() => undefined); // 超时后迟到 rejection 兜底（防 unhandled rejection）
      const outcome = await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`内容源超时（>${this.contentTimeoutMs}ms，回退极简通知）`)),
            this.contentTimeoutMs,
          );
        }),
      ]);
      if (outcome.kind === "text") return truncateSummary(outcome.text);
      if (outcome.kind === "silent") return null;
      return fallback; // unavailable（未启用/gate 断点）——②层极简通知
    } catch (err) {
      this.logger?.warn(`语音播报内容源失败（回退②层极简通知）：${(err as Error).message}`);
      return fallback;
    } finally {
      if (timer !== undefined) clearTimeout(timer); // 快速路径清 timer（防泄漏）
    }
  }

  /** 入队（溢出丢最旧——含在途占位；dropped 计入下一条合并提示）。 */
  private enqueue(item: QueueItem): void {
    if (this.queue.length >= QUEUE_LIMIT) {
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push(item);
  }

  private nextId(): number {
    this.acceptSeq += 1;
    return this.acceptSeq;
  }

  /** 串行泵：ready 前缀逐条（合成 → 广播），异常隔离跳过后续；队头占位
   * （内容未就绪）即停——保序，等对应链步激活后再泵。 */
  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && this.queue[0]!.ready) {
        const item = this.queue.shift()!;
        let text = item.text;
        let dropped: number | undefined;
        if (this.droppedCount > 0) {
          dropped = this.droppedCount;
          text = `${DROPPED_NOTE(dropped)}${text}`;
          this.droppedCount = 0;
        }
        const voice = this.gate.voicePreference();
        try {
          const result = await this.tts.synthesize({
            text,
            ...(voice !== undefined ? { voice } : {}),
          });
          this.seq += 1;
          this.emit({
            kind: item.kind,
            agentId: item.agentId,
            text,
            audio: result.audio,
            provider: this.tts.providerId,
            ...(voice !== undefined ? { voice } : {}),
            seq: this.seq,
            ...(dropped !== undefined ? { droppedCount: dropped } : {}),
          });
        } catch (err) {
          // 合成失败跳过该条不中断后续（旁路增强面——warn 观测即可）
          this.logger?.warn(`语音播报合成失败（跳过 ${item.agentId}）：${(err as Error).message}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
