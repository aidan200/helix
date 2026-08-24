import type { ChatPort, SendOutcome } from "../ports/inbound/ChatPort";
import type { AgentOrchestrationPort } from "../ports/inbound/AgentOrchestrationPort";
import type { AgentEngineEvent, AgentEnginePort, AgentThinkingState } from "../ports/outbound/AgentEnginePort";
import type { EventPublisherPort } from "../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../ports/outbound/ClockPort";
import { AgentLifecycle, type AgentLifecycleState } from "../../domain/agent/AgentLifecycle";
import { Session } from "../../domain/session/Session";
import type { ThinkingEntryData } from "../../domain/session/ThinkingEntry";
import { MAIN_INSTANCE_ID, ZERO_USAGE, type ErrorCode } from "@helix/protocol"; // MAIN_INSTANCE_ID re-export 自 @helix/common（AD-1）；ZERO_USAGE = projection 单源
import { ToolCallRecord, type ToolCallRecordData } from "../../domain/tools/ToolCallRecord";
import { parseDataUrlImages, ImageValidationError } from "./images";
import type {
  AgentInstantiatedPayload, AgentModelChangedPayload, AgentStateChangedPayload, AgentThinkingChangedPayload, CompactionCompletedPayload,
  DomainEvent, MessageCompletedPayload, ProfileSnapshotData, SteerPayload, ThinkingCompletedPayload,
  ToolCallPayload, ToolResultPayload, TurnCompletedPayload, UsageRecordedPayload,
} from "../../domain/events/DomainEvent";

type EngineEventOf<T extends AgentEngineEvent["type"]> = Extract<AgentEngineEvent, { type: T }>;

/** ThinkingBuffer —— thinking 块两态缓冲（原 thinkingStarts/pendingThinking 收编；两态 = 计时中→暂存，第三态「已落账」归 domain ThinkingEntry）。streamEntryId 不入 Buffer——message_update（非 thinking 事件）也消费，归 ChatService 流式族。 */
class ThinkingBuffer {
  private readonly starts = new Map<number, string>();
  private pending: { contentIndex: number; text: string; startedAt: string }[] = [];

  /** thinking_started：记墙钟起点（durationMs = start→end，ClockPort）。 */
  start(contentIndex: number, startedAt: string): void {
    this.starts.set(contentIndex, startedAt);
  }

  /** thinking_end：计时取出 + 完成块暂存（起点缺失防御取 now——thunk 惰性求值，clock 调用面不变）。 */
  end(contentIndex: number, text: string, now: () => string): void {
    const startedAt = this.starts.get(contentIndex) ?? now();
    this.starts.delete(contentIndex);
    this.pending.push({ contentIndex, text, startedAt });
  }

  /** message_start(assistant)：新消息两态整体重置（上轮残留不串入新消息）。 */
  reset(): void {
    this.starts.clear();
    this.pending = [];
  }

  /** message_end 消费：取出全部暂存块（取后清空）。 */
  drain(): readonly { contentIndex: number; text: string; startedAt: string }[] {
    const blocks = this.pending;
    this.pending = [];
    return blocks;
  }
}

/** ChatService —— 对话全流程编排（AD-17.1，architecture.md §3.4）。idle 落 user Entry → 开 Turn → running → 驱动引擎（事件经 onEngineEvent 薄路由回流，按四关注点分族私有方法处理）；running/steering 输入转 steer 注入（domain SteerQueue 权威 + 引擎队列，turn 边界 drain §5.3）；abort 非销毁（interrupted 后回 idle）；closure 注入（AD-8）同队列同语义。状态所有权（AD-16）全在 domain；持久化（AD-3 §3.2②）只产事件，write-through 归会话投影消费者。 */
/** deps 基础字段面（两形态共通，架构 §4.2.6）：3 必填 + 2 恢复场景参数（非钩子——两形态均保持可选）。 */
interface ChatServiceDepsBase {
  /** agent 引擎（pi 防腐墙后的驱动出口）。 */
  readonly engine: AgentEnginePort;
  /** 事件流发布（领域事件 + 流式 delta；write-through 归会话投影消费者）。 */
  readonly events: EventPublisherPort;
  /** 时间源（领域事件/条目时间戳，测试可控）。 */
  readonly clock: ClockPort;
  /** 恢复场景传入重建聚合（RestoreService）；默认新建会话。 */
  readonly session?: Session;
  /** 恢复场景传入历史工具调用记录（重启后工具历史随快照延续）。 */
  readonly restoredToolCalls?: readonly ToolCallRecordData[];
}

/** 完整形态（生产装配面，架构 §4.2.6）：四钩子必填——组合根装配缺钩子 = 编译红，消灭「未装配静默降级」。 */
export interface ChatServiceDeps extends ChatServiceDepsBase {
  /** 定向 steer 转投面（契约 v0.3 §3.2）：组合根接 SchedulerService.send；delivered=false 时本服务抛 SteerTargetNotRunningError（不落 Entry 不入队）。 */
  readonly sendToInstance: AgentOrchestrationPort["send"];
  /** 模型回退读面（AD-6）：换模 from 兜底；组合根接默认模型读面。 */
  readonly modelFallback: () => string;
  /** 主实例 instantiated 快照供给（AD-5，契约 v0.4 §2）：driven 常量不进 application。 */
  readonly instantiatedSnapshot: () => ProfileSnapshotData;
  /** 首个用户条目落聚合回调（转正单点触发面）：组合根接 SessionRegistry.promoteDraft（恰好一次 instantiated + 补 created 广播；恢复会话结构性不触发）。 */
  readonly onFirstUserEntry: () => void;
}

/** 测试形态（宽松）：四钩子可选——缺省行为与旧单接口一致。 */
export interface ChatServiceTestDeps extends ChatServiceDepsBase {
  readonly sendToInstance?: AgentOrchestrationPort["send"];
  readonly modelFallback?: () => string;
  readonly instantiatedSnapshot?: () => ProfileSnapshotData;
  readonly onFirstUserEntry?: () => void;
}

/** 定向 steer 目标非运行中（契约 v0.3 §3.2）：WS 据 code 判别转 connection.error 点对点回执（TR-AD-21）；message 复用 SendOutcome.detail。 */
export class SteerTargetNotRunningError extends Error {
  /** 错误码（additive）：值 = 既有回码，判别契约从 name 改码匹配。 */
  readonly code: ErrorCode = "command.invalid_payload";
  constructor(message: string) {
    super(message);
    this.name = "SteerTargetNotRunningError";
  }
}

export class ChatService implements ChatPort {
  private readonly session: Session;
  private readonly lifecycle = new AgentLifecycle();
  /** 本会话的工具调用记录（id → 聚合；pending→running→completed/failed）。 */
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  /** 流式期间预分配的 assistant entry id（D-2：delta.messageId 对齐最终 entry id；归流式族非 ThinkingBuffer）。 */
  private streamEntryId: string | null = null;
  /** thinking 块两态缓冲（原 thinkingStarts/pendingThinking 收编）。 */
  private readonly thinking = new ThinkingBuffer();
  /** 在飞 run 的 promise（AD-4 删除收口链）：开 run 登记、收口清空——currentRun()/whenSettled() 等待面。 */
  private activeRun: Promise<void> | null = null;
  /** closure 暂存缓冲（T2 送达补齐）：aborting 窗口 FIFO 暂存，abort 收尾回 idle 后逐条 flush（fire-and-forget sendMessage，失败 engine.error 可观测不崩链）。aborting 是瞬时窗口，内存缓冲即可（不做持久化）。 */
  private readonly closureBuffer: string[] = [];

  constructor(private readonly deps: ChatServiceDeps | ChatServiceTestDeps) {
    this.session = deps.session ?? Session.create();
    for (const data of deps.restoredToolCalls ?? []) {
      const record = ToolCallRecord.restore(data);
      // D-1 恢复收口：非终态重启后不可能继续跑，收口 failed（pending 先 markRunning 保持迁移合法性）。
      if (data.status === "pending") {
        record.markRunning();
        record.fail("daemon 重启，工具调用未完成（恢复时收口）");
      } else if (data.status === "running") {
        record.fail("daemon 重启，工具调用未完成（恢复时收口）");
      }
      this.toolCalls.set(data.id, record);
    }
  }

  // ── 观测面（SessionService/SystemPort 经组合根取，不走私有状态） ──

  get sessionId(): string {
    return this.session.id;
  }
  get agentState(): AgentLifecycleState {
    return this.lifecycle.current;
  }
  /** 会话当前模型 id（AD-2："provider/model-id"；引擎不暴露时 undefined）。 */
  get currentModel(): string | undefined {
    return this.deps.engine.currentModel?.();
  }
  /** 主实例 agent.instantiated 发布（转正语义，AD-5 契约 v0.4 §2）：发布点 = 会话**转正**（promoteDraft 触发一次；内存草稿不写 domain_events 无幻影；恢复路径不调；只落盘不广播；re-profile 不存在）。 */
  publishInstantiated(): void {
    if (this.deps.instantiatedSnapshot === undefined) return;
    this.publish<AgentInstantiatedPayload>(
      "agent.instantiated",
      { instanceId: MAIN_INSTANCE_ID, profileKind: "main-session", profileSnapshot: this.deps.instantiatedSnapshot() },
      undefined,
      MAIN_INSTANCE_ID,
    );
  }
  /** 运行期换模（AD-2：AgentEnginePort.setModel 域内扩面，下一 turn 生效；不支持即抛错；AD-6 契约 v0.4 §3：成功同点发布 agent.model.changed——from 缺省回退全局默认，只落盘不广播）。 */
  setModel(modelId: string): void {
    if (this.deps.engine.setModel === undefined) {
      throw new Error(`引擎未实现运行期换模接口（AgentEnginePort.setModel），无法切换到 ${modelId}`);
    }
    const from = this.deps.engine.currentModel?.() ?? this.deps.modelFallback?.() ?? modelId;
    this.deps.engine.setModel(modelId);
    this.publish<AgentModelChangedPayload>(
      "agent.model.changed",
      { instanceId: MAIN_INSTANCE_ID, from, to: modelId },
      undefined,
      MAIN_INSTANCE_ID,
    );
  }
  /** 运行期改生效工具集/系统提示（setModel 同构 per-session 入口）：直达 AgentEnginePort 直改面（下一 turn 生效）；不支持即抛错；契约广播（agent.config.changed）归 EventStream 广播链。 */
  setTools(names: readonly string[]): void {
    if (this.deps.engine.setTools === undefined) {
      throw new Error(`引擎未实现运行期工具集直改接口（AgentEnginePort.setTools），无法设置为 ${names.join(", ")}`);
    }
    this.deps.engine.setTools(names);
  }
  setSystemPrompt(text: string): void {
    if (this.deps.engine.setSystemPrompt === undefined) {
      throw new Error("引擎未实现运行期系统提示直改接口（AgentEnginePort.setSystemPrompt），无法刷新提示");
    }
    this.deps.engine.setSystemPrompt(text);
  }
  /** 运行期 thinking 覆盖（thinking 批①，AD-4①：AgentEnginePort.setThinking 域内扩面，下一 turn 生效；不支持即抛错；成功同点发布 agent.thinking.changed——只落盘不广播，跨冷恢复数据源；广播归 thinking.changed 链）。level 字符串透传（AD-2：helix 不做档位校验，未知档由引擎按能力适配）。 */
  setThinking(level: string): void {
    if (this.deps.engine.setThinking === undefined) {
      throw new Error(`引擎未实现运行期 thinking 覆盖接口（AgentEnginePort.setThinking），无法设置为 ${level}`);
    }
    this.deps.engine.setThinking(level);
    this.publish<AgentThinkingChangedPayload>(
      "agent.thinking.changed",
      { instanceId: MAIN_INSTANCE_ID, level },
      undefined,
      MAIN_INSTANCE_ID,
    );
  }
  /** 会话 thinking 覆盖/生效（观测面：快照 thinking 位 + thinking.changed 广播数据源；引擎未实现 → undefined，additive 缺省）。 */
  get currentThinking(): AgentThinkingState | undefined {
    return this.deps.engine.currentThinking?.();
  }
  /** 聚合只读访问（SessionService 快照取数；组合根接线用）。 */
  get sessionView() {
    return this.session;
  }
  get sessionSnapshot() {
    return this.session.toSnapshot();
  }
  /** 领域状态整体（持久化载荷，AD-16）：会话聚合 + 生命周期 + 工具记录。 */
  get persistedState() {
    return {
      session: this.session.toSnapshot(),
      agentState: this.lifecycle.current,
      toolCalls: [...this.toolCalls.values()].map((r) => r.toData()),
    };
  }
  /** 工具调用记录只读观测面（D-1：SessionService 快照取数经组合根接线）。 */
  get toolCallData(): readonly ToolCallRecordData[] {
    return [...this.toolCalls.values()].map((r) => r.toData());
  }

  // ── ChatPort 实现 ────────────────────────────────────────

  /** 发送用户消息：空闲开新轮次并驱动引擎；生成中转 steer 注入（返回值告诉 driving 侧去向——CLI/WS 据此回执）。图片上行：images 可选（base64 data URL）——入口统一校验（parseDataUrlImages：≤4 张/格式/单张 ≤2MB）；仅 idle 分支消费；生成中携带抛错（steer 不带图，不静默丢图）。 */
  async sendMessage(text: string, images?: readonly string[]): Promise<SendOutcome> {
    if (text.trim() === "") {
      throw new Error("消息内容不能为空");
    }
    // 入口统一校验（两分支共用；idle 分支随后透传，running 分支拒收）
    if (images !== undefined && images.length > 0) {
      parseDataUrlImages(images);
    }
    switch (this.lifecycle.current) {
      case "idle": {
        // ① 消息落聚合：user Entry；零条目会话首个用户条目落聚合后同步
        //    触发转正回调（promoteDraft：instantiated 先于 message.completed 落盘）
        const isFirstEntry = this.session.isEmpty();
        const entry = this.session.appendUserEntry(text, this.now(), images);
        if (isFirstEntry) this.deps.onFirstUserEntry?.();
        this.publishMessageCompleted(entry.toData().id, "user", text, false, images);
        // ② 开新轮次（Turn=generating）并广播开始
        const turn = this.session.beginTurn(entry.id, this.now());
        this.publish("turn.started", { turnId: turn.id });
        // ③ idle→running，驱动引擎（await 整个 run：含工具轮与 steer drain 轮）
        this.setLifecycle("running");
        const run = (async () => {
          try {
            await this.deps.engine.start(text, (e) => this.onEngineEvent(e), images);
          } catch (err) {
            // 引擎异常不崩会话：可观测（engine.error）+ 轮次收口为中断 + 回 idle
            this.publish("engine.error", { message: (err as Error).message });
            this.settleRunEnd("aborted");
          }
        })();
        this.activeRun = run; // 在飞 run 登记（whenSettled 等待面）
        try {
          await run;
        } finally {
          if (this.activeRun === run) this.activeRun = null;
        }
        return { mode: "turn", turnId: turn.id, entryId: entry.id };
      }
      case "running":
      case "steering": {
        // 非目标防护：steer 注入不带图——生成中携带 images 抛错
        if (images !== undefined && images.length > 0) {
          throw new ImageValidationError("生成中发送图片暂不支持（注入不带图），请等待本轮结束后再发");
        }
        // ④ 生成中的输入 = steer 注入（domain 队列可观测 + 引擎即时入队）
        const { entryId } = await this.steer(text);
        return { mode: "steered", entryId };
      }
      case "aborting":
        throw new Error("正在中断当前生成，请稍候再发送（abort 收尾后即恢复输入）");
      case "stopped":
        throw new Error("daemon 已停止，不再接受新消息");
    }
  }

  /** 显式 steer 注入：instanceId 缺省/显式 main = 主实例路径（要求运行中）——applySteer 落 isSteer entry + SteerQueue.enqueue（domain 权威）+ 引擎 steer（执行机制）；instanceId = SubAgent id = 定向分支。 */
  async steer(text: string, instanceId?: string): Promise<{ entryId: string }> {
    if (instanceId !== undefined && instanceId !== MAIN_INSTANCE_ID) {
      return this.steerInstance(instanceId, text);
    }
    this.lifecycle.assertIn("running", "steering");
    const entry = this.session.applySteer(text, this.now());
    if (this.lifecycle.current === "running") {
      this.setLifecycle("steering"); // running→steering：有注入待 drain
    }
    this.publish<SteerPayload>("steer.queued", { entryId: entry.id, text });
    this.deps.engine.steer(text);
    return { entryId: entry.id };
  }

  /** 定向 steer 分支（契约 v0.3 §3.2，Q-3a）：① 转投 AgentOrchestrationPort.send（agent_send 同链路）；② delivered=false → SteerTargetNotRunningError，不落 Entry 不入队（TR-AD-21）；③ 已投递 → applyDirectedSteer 落主时间轴（不入主 SteerQueue、不双写实例 channel）+ steer.queued 信封挂 instanceId=目标。 */
  private steerInstance(instanceId: string, text: string): { entryId: string } {
    if (this.deps.sendToInstance === undefined) {
      throw new Error("定向 steer 通道未装配（ChatServiceDeps.sendToInstance 未注入，契约 v0.3 §3.2）");
    }
    const outcome = this.deps.sendToInstance(instanceId, text);
    if (!outcome.delivered) {
      throw new SteerTargetNotRunningError(outcome.detail);
    }
    const entry = this.session.applyDirectedSteer(text, instanceId, this.now());
    this.publish<SteerPayload>("steer.queued", { entryId: entry.id, text }, undefined, instanceId);
    return { entryId: entry.id };
  }

  /** 中断当前生成：running/steering→aborting + 引擎 abort()；空闲/已中断幂等忽略。 */
  abort(): void {
    if (this.lifecycle.current === "running" || this.lifecycle.current === "steering") {
      this.setLifecycle("aborting");
      this.deps.engine.abort();
    }
  }

  /** closure 注入主线（AD-8 双通道之一；组合根接 SchedulerService 收口回调，非 ChatPort 成员）：idle 立即新 turn / running·steering 同队列同语义入队（source=closure，FIFO 保序）/ aborting FIFO 暂存（T2 送达补齐：abort 收尾回 idle 后逐条 flush）/ stopped 可观测丢弃。同步方法（调度链不 await）；新 turn fire-and-forget，异常经 engine.error 可观测不崩会话。 */
  injectClosure(text: string): void {
    switch (this.lifecycle.current) {
      case "idle":
        void this.sendMessage(text).catch((err) => {
          this.publish("engine.error", { message: `closure 注入失败：${(err as Error).message}` });
        });
        return;
      case "running":
      case "steering": {
        try {
          const entry = this.session.applySteer(text, this.now(), "closure");
          if (this.lifecycle.current === "running") {
            this.setLifecycle("steering"); // 同用户 steer：有注入待 drain
          }
          this.publish<SteerPayload>("steer.queued", { entryId: entry.id, text });
          this.deps.engine.steer(text);
        } catch (err) {
          this.publish("engine.error", { message: `closure 注入失败：${(err as Error).message}` });
        }
        return;
      }
      case "aborting":
        // T2 送达补齐：中断收尾窗口不丢弃——FIFO 暂存，abort 收尾回 idle 后逐条 flush（settleRunEnd 触发）。
        this.closureBuffer.push(text);
        return;
      case "stopped":
        // 终态无可投递对象：可观测丢弃（closure 已在 closure_records 落盘，恢复会话可见）。
        this.publish("engine.error", {
          message: `closure 注入被丢弃（生命周期 ${this.lifecycle.current}）：${text.slice(0, 80)}`,
        });
        return;
    }
  }

  /** 触发缓冲 closure 续送（T2）：有在飞/收尾中 run → 挂其 promise settle 后再 drain——本方法常在 agent_end 同步回流段内被调（settleRunEnd），此刻引擎仍视为在飞，此窗再 start 会撞在飞守卫（delete-settle-race 同款竞态窗口）；无 run → 即刻 drain。 */
  private scheduleClosureDrain(): void {
    const run = this.activeRun;
    if (run !== null) void run.then(() => this.drainClosureBuffer(), () => this.drainClosureBuffer());
    else this.drainClosureBuffer();
  }

  /** 逐条 flush 缓冲 closure（T2）：idle 即发一条（fire-and-forget sendMessage，失败 engine.error——与 idle 分支同语义），该条 promise settle 后续发下一条（链式保 FIFO，单条失败不崩链）；非 idle（flush 窗口被新 run 占用）挂该 run 收口后重试（settleRunEnd 亦会再触发，幂等守卫收敛）；stopped/无 run 可挂时不投递（终态无可投递对象）。 */
  private drainClosureBuffer(): void {
    if (this.closureBuffer.length === 0) return;
    if (this.lifecycle.current !== "idle") {
      if (this.activeRun !== null) this.scheduleClosureDrain();
      return;
    }
    const text = this.closureBuffer.shift()!;
    void this.sendMessage(text)
      .catch((err) => {
        this.publish("engine.error", { message: `closure 注入失败：${(err as Error).message}` });
      })
      .then(() => this.drainClosureBuffer());
  }

  /** 系统停止（SystemPort.shutdown 经组合根调用）：终态，拒绝后续输入。stop 时 closureBuffer 残留（aborting 暂存窗未 flush）逐条补发可观测丢弃 engine.error（与 injectClosure stopped 分支同族文案；closure_records 已落盘，只补可观测性），随后清空（终态无可投递对象，防残留滞留）。 */
  stop(): void {
    if (this.lifecycle.current !== "stopped") {
      this.lifecycle.transition("stopped");
      this.publish<AgentStateChangedPayload>("agent.state.changed", { state: "stopped" });
    }
    if (this.closureBuffer.length > 0) {
      for (const text of this.closureBuffer) {
        this.publish("engine.error", {
          message: `closure 注入被丢弃（生命周期 stopped）：${text.slice(0, 80)}`,
        });
      }
      this.closureBuffer.length = 0;
    }
  }

  /** 当前在飞 run 的 promise 引用（捕获语义等待面）：无 run 时 null。调用方捕获引用后等待——期间新登记的 run 不延长等待（消灭原 while 轮询的「等到无 run」语义漂移）。 */
  currentRun(): Promise<void> | null {
    return this.activeRun;
  }

  /** 等待**调用时刻**的在飞 run 收口（AD-4；捕获语义）：等待对象 = 调用时刻快照；run 异常向上抛（删除链 withTimeout 双通道 warn 兜底）。仅等待主线引擎 run；SubAgent 由调度器 cancelSession 同步收口。 */
  async whenSettled(): Promise<void> {
    const run = this.currentRun();
    if (run !== null) await run;
  }

  // ── 引擎事件回流：薄路由（12 case 按四关注点分族私有方法，本体无业务逻辑） ──

  private onEngineEvent(e: AgentEngineEvent): void {
    switch (e.type) {
      // 流式透传族：中间态直达事件流（不落盘不改聚合，TR-AD-5）
      case "message_update": this.forwardMessageDelta(e); break;
      case "thinking_delta": this.forwardThinkingDelta(e); break;
      // 状态机族
      case "turn_end": this.resumeGeneratingAfterToolBatch(e); break;
      case "agent_end": this.settleAgentRun(); break;
      // 落盘族（多为混合 case：按主导关注点归族、usage 拆子调用）
      case "message_start":
        if (e.role === "assistant") this.prepareAssistantStream();
        if (e.role === "user" && e.source === "steer-drain") this.drainSteerTurn();
        break;
      case "message_end":
        if (e.role === "assistant") this.recordAssistantMessage(e);
        break;
      case "thinking_started": this.thinking.start(e.contentIndex, this.now()); break;
      case "thinking_end": this.stageThinkingBlock(e); break;
      case "compaction_completed": this.recordCompaction(e); break;
      case "tool_execution_start": this.recordToolExecutionStart(e); break;
      case "tool_execution_end": this.recordToolExecutionEnd(e); break;
      // 可观测（无聚合动作，不崩会话）
      case "engine_error": this.publish("engine.error", { message: e.message }); break;
      default:
        break; // agent_start/turn_start 无领域动作
    }
  }

  // ── 流式透传族（中间态不落盘、不改聚合） ──────────────────

  /** message_update：文本 delta 直达事件流（messageId = 预分配 entry id，D-2 契约 §5 字段语义对齐；fallback 仅防御）。 */
  private forwardMessageDelta(e: EngineEventOf<"message_update">): void {
    this.deps.events.publishDelta({
      messageId: this.streamEntryId ?? this.currentTurnId(),
      delta: e.delta,
      sessionId: this.session.id, // v0.2 信封 sessionId 必发纪律（章印在 EventStream）
    });
  }

  /** thinking_delta：thinking 频道 delta 直达（instanceId=main；messageId 对齐面同上）。 */
  private forwardThinkingDelta(e: EngineEventOf<"thinking_delta">): void {
    this.deps.events.publishDelta({
      messageId: this.streamEntryId ?? this.currentTurnId(),
      delta: e.delta,
      channel: "thinking",
      instanceId: MAIN_INSTANCE_ID,
      sessionId: this.session.id,
    });
  }

  /** message_start(assistant)：流式准备——预分配最终 entry id（D-2：放弃不回收，计数器空洞无害）+ thinking 两态重置。 */
  private prepareAssistantStream(): void {
    this.streamEntryId = this.session.reserveEntryId();
    this.thinking.reset();
  }

  // ── 状态机族（生命周期/Turn 状态推进） ─────────────────────

  /** message_start(user, steer-drain)：注入消费——收口旧 Turn（reason=steerDrained）+ domain 队列出账 + 以注入消息开新 Turn + steering→running 回转（注入已消费，续跑）。 */
  private drainSteerTurn(): void {
    this.finishOpenTurn("steerDrained");
    const item = this.session.dequeueSteer();
    if (item) {
      this.publish<SteerPayload>("steer.drained", { entryId: item.entryId, text: item.text });
      const turn = this.session.beginTurn(item.entryId, this.now());
      this.publish("turn.started", { turnId: turn.id });
    }
    if (this.lifecycle.current === "steering") {
      this.setLifecycle("running");
    }
  }

  /** turn_end：带工具结果 = assistant 将带结果续生成（新 pi turn）——Turn 保持 open、toolRunning 回 generating；无工具结果的 turn_end 不动（run 收尾归 agent_end 兜底收口）。 */
  private resumeGeneratingAfterToolBatch(e: EngineEventOf<"turn_end">): void {
    if (e.toolResultCount > 0 && this.session.openTurn?.status === "toolRunning") {
      this.session.resumeTurnGenerating();
    }
  }

  /** agent_end：run 收口入口（abort→interrupted / 正常→completed）+ 回 idle。 */
  private settleAgentRun(): void {
    this.settleRunEnd(this.lifecycle.current === "aborting" ? "aborted" : "done");
  }

  /** run 结束统一收口：Turn 终态 + 生命周期 idle。 */
  private settleRunEnd(reason: TurnCompletedPayload["reason"]): void {
    if (this.session.openTurn) {
      // 直接语句调用不接返回值（与 finishOpenTurn 同构；Turn 返回面归口在 publish 落盘链，此处丢弃即原 void t 语义）
      if (reason === "aborted") {
        this.session.interruptTurn(this.now());
        this.publish<TurnCompletedPayload>("turn.interrupted", { reason: "aborted", replyEntryId: undefined });
      } else {
        this.session.completeTurn(this.now());
        this.publish<TurnCompletedPayload>("turn.completed", { reason: "done", replyEntryId: undefined });
      }
    }
    if (this.lifecycle.current !== "idle" && this.lifecycle.canTransition("idle")) {
      this.setLifecycle("idle");
    }
    // T2 送达补齐：run 收口回 idle 后续送缓冲 closure（经 scheduleClosureDrain 挂本 run
    // promise settle 后再发——本同步段内引擎仍在飞，直接 sendMessage 会撞在飞守卫）。
    if (this.closureBuffer.length > 0) this.scheduleClosureDrain();
  }

  /** 收口当前 open Turn（steer drain 收口落点；settleRunEnd 前半同构）。 */
  private finishOpenTurn(reason: TurnCompletedPayload["reason"]): void {
    const open = this.session.openTurn;
    if (!open) return;
    if (reason === "aborted") {
      this.session.interruptTurn(this.now());
      this.publish<TurnCompletedPayload>("turn.interrupted", { reason });
    } else {
      this.session.completeTurn(this.now());
      this.publish<TurnCompletedPayload>("turn.completed", { reason });
    }
  }

  private setLifecycle(to: AgentLifecycleState): void {
    this.lifecycle.transition(to);
    this.publish<AgentStateChangedPayload>("agent.state.changed", { state: to });
  }

  // ── 落盘族（领域状态落聚合 + 里程碑事件） ─────────────────

  /** message_end(assistant)：thinking 块先落（流序对齐契约 §5.2；reasoningTokens 取本 turn usage.reasoning 收口）→ 非空文本落 Entry + message.completed → usage 入账子调用 → 预留清空。abort 空消息不落 Entry（空文本非语义单元），但已暂存 thinking 块仍以 reasoning=0 落账（锚定面）；user/toolResult 已在注入/工具事件落账，不重复。 */
  private recordAssistantMessage(e: EngineEventOf<"message_end">): void {
    this.flushPendingThinking(e.usage?.reasoning ?? 0);
    if (e.text.trim() !== "") {
      const entry = this.session.appendAssistantEntry(e.text, this.now(), this.streamEntryId ?? undefined);
      this.publishMessageCompleted(entry.id, "assistant", e.text, false);
    }
    if (e.usage !== undefined && e.stopReason !== "error") {
      this.publishTurnUsage(e.usage);
    }
    this.streamEntryId = null; // 预留消耗完毕（空文本/abort 轮同样清空）
  }

  /** thinking_end：完成块暂存入 Buffer（待 message_end 关联落账）。 */
  private stageThinkingBlock(e: EngineEventOf<"thinking_end">): void {
    this.thinking.end(e.contentIndex, e.content, () => this.now());
  }

  /** compaction_completed：CompactionEntry 落树 + 里程碑事件 + usage 入账子调用（AD-9③；provider 未报 usage 时零值占位仍入账——账目行完整）。 */
  private recordCompaction(e: EngineEventOf<"compaction_completed">): void {
    const entry = this.session.appendCompactionEntry({
      kind: "compaction",
      instanceId: MAIN_INSTANCE_ID,
      tokensBefore: e.tokensBefore,
      tokensAfter: e.tokensAfter,
      summary: e.summary,
      usage: e.usage ?? ZERO_USAGE,
      createdAt: this.now(),
    });
    this.publish<CompactionCompletedPayload>("compaction.completed", { entry: entry.toData() }, undefined, MAIN_INSTANCE_ID);
    this.publishCompactionUsage(entry.toData().usage);
  }

  /** tool_execution_start：建记录（pending→running）、轮次切 toolRunning、广播。 */
  private recordToolExecutionStart(e: EngineEventOf<"tool_execution_start">): void {
    const record = ToolCallRecord.create(e.toolCallId, e.toolName, e.args);
    record.markRunning(this.now());
    this.toolCalls.set(e.toolCallId, record);
    if (this.session.openTurn?.status === "generating") {
      this.session.markTurnToolRunning();
    }
    this.publish<ToolCallPayload>("tool.call.started", { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args });
  }

  /** tool_execution_end：记录收口（completed/failed）+ 广播结果。下行：images（工具截图 data URL）随记录/事件同点落账（工具卡缩略图源）。 */
  private recordToolExecutionEnd(e: EngineEventOf<"tool_execution_end">): void {
    const record = this.toolCalls.get(e.toolCallId);
    if (record) {
      if (e.isError) record.fail(e.result, this.now());
      else record.complete(e.result, this.now(), e.images);
    }
    this.publish<ToolResultPayload>("tool.call.result", {
      toolCallId: e.toolCallId, toolName: e.toolName, args: record?.args, isError: e.isError, result: e.result,
      ...(e.images !== undefined && e.images.length > 0 ? { images: [...e.images] } : {}),
    });
  }

  /** 落 Buffer 暂存的 thinking 块：每块一条 ThinkingEntry + thinking.completed 事件（reasoningTokens 为本 turn 关联值——块间共享，账目归 UsageLedger）。 */
  private flushPendingThinking(reasoningTokens: number): void {
    for (const block of this.thinking.drain()) {
      const entry = this.session.appendThinkingEntry({
        kind: "thinking",
        instanceId: MAIN_INSTANCE_ID,
        text: block.text,
        durationMs: Math.max(0, Date.parse(this.now()) - Date.parse(block.startedAt)),
        reasoningTokens,
        createdAt: this.now(),
      });
      const data: ThinkingEntryData = entry.toData();
      this.publish<ThinkingCompletedPayload>("thinking.completed", { entry: data }, undefined, MAIN_INSTANCE_ID);
    }
  }

  // ── usage 族（AD-4 事件即账：账本投影归组合根 fan-out 末端） ──

  /** turn 入账：message_end 携带 usage 即一条 usage.recorded(source=turn)。error 轮零值不入账（终验热修——零成本非真实计费）；工具轮中间 message_end(stopReason=toolUse) 无 usage 不入账。 */
  private publishTurnUsage(usage: UsageRecordedPayload["usage"]): void {
    this.publish<UsageRecordedPayload>(
      "usage.recorded",
      { instanceId: MAIN_INSTANCE_ID, usage, source: "turn" },
      undefined,
      MAIN_INSTANCE_ID,
    );
  }

  /** compaction 入账：source=compaction（与 turn 账并存不重复）。 */
  private publishCompactionUsage(usage: UsageRecordedPayload["usage"]): void {
    this.publish<UsageRecordedPayload>(
      "usage.recorded",
      { instanceId: MAIN_INSTANCE_ID, usage, source: "compaction" },
      undefined,
      MAIN_INSTANCE_ID,
    );
  }

  // ── 事件信封/工具 ─────────────────────────────────────────

  private currentTurnId(): string {
    return this.session.openTurn?.id ?? "idle";
  }

  private publishMessageCompleted(
    entryId: string, role: MessageCompletedPayload["role"], text: string, isSteer: boolean, images?: readonly string[],
  ): void {
    this.publish<MessageCompletedPayload>("message.completed", {
      entryId,
      role,
      text,
      isSteer,
      // 图片上行：user 消息携带图片附件（data URL 原样，事件/投影同源）
      ...(images !== undefined && images.length > 0 ? { images: [...images] } : {}),
    });
  }

  private publish<P>(type: DomainEvent["type"], payload: P, turnId?: string, instanceId?: string): void {
    // 只产事件——write-through 由会话投影消费者（SessionProjection）在 fan-out 末端触发（先事件行后状态行，全局 FIFO；AD-3）。
    this.deps.events.publish({
      type,
      sessionId: this.session.id,
      turnId: turnId ?? this.session.openTurn?.id,
      ...(instanceId !== undefined ? { instanceId } : {}),
      payload,
      occurredAt: this.now(),
    });
  }

  private now(): string {
    return this.deps.clock.now();
  }
}
