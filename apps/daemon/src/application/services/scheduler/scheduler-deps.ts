/**
 * SchedulerService 依赖面（P2 体量门 ④ 轻拆批：自 SchedulerService.ts 机械
 * 迁出，零逻辑改动）。
 *
 * 归属理由：这是组合根 → 调度器装配的**注入面契约**（组合根按需提供回调/
 * 读口，调度器只消费），与门面的编排力学（注册表/FIFO/收口链）是两个变更
 * 节奏——装配面加注入口不牵动编排逻辑。公共 API 面不变：SchedulerService.ts
 * 原样 re-export 本类型，消费方零感知。
 */
import type { SchedulingPolicy } from "../../../domain/agent/SchedulingPolicy";
import type { SessionRunStateLike } from "../../../domain/agent/ObservabilityState";
import type { AgentInstantiatedPayload } from "../../../domain/events/DomainEvent";
import type { EventPublisherPort } from "../../ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../ports/outbound/ClockPort";
import type { SessionRepositoryPort } from "../../ports/outbound/SessionRepositoryPort";
import type { InstanceRunner } from "../InstanceRunner";
import type { ClosureFindingsSink } from "./ClosureRecorder";

export interface SchedulerServiceDeps {
  /** 调度策略工厂（每次判定现拍：maxConcurrent/maxQueued 运行期可调——装配层闭 KV 读现值；stalled 阈值由此携带）。 */
  readonly policy: () => SchedulingPolicy;
  /** 实例运行器（SubagentLauncher 真体；替身跑 integration）。 */
  readonly runner: InstanceRunner;
  /** 事件流发布（领域事件 → fan-out：stdout/WS 落盘目标）。 */
  readonly events: EventPublisherPort;
  /** 持久化（closure 记录行/报告文件/agent_lifecycle 投影，经 WriteQueue 单写通道）。 */
  readonly repository: SessionRepositoryPort;
  /** 时间源（领域事件 occurredAt / 实例 createdAt / stalled 毫秒判定，测试可控）。 */
  readonly clock: ClockPort;
  /**
   * 任务报告目录（O-5：<home>/reports/<session>；**多会话**：调度器
   * daemon 全局一份，报告目录按实例归属会话解析——注入 (sessionId) => dir；
   * 缺省不产报告文件（closure.reportPath 为 null——既有测试口径）。
   */
  readonly reportsDirFor?: (sessionId: string) => string;
  /**
   * findings 旁路文件读（task-778eb18a 截断兜底）：透传 ClosureRecorder；
   * 组合根接 fs 只读实现（application 零 IO）；缺省不兜底（测试形态）。
   */
  readonly readFindingsFile?: (path: string) => string | null;
  /**
   * closure 注入主线回调（AD-8 双通道之一；组合根接 ChatService.injectClosure）。
   * 可选——无主线编排场景（纯调度 integration）不注入。
   * source（T11a）：closure=收口注入（ClosureRecorder 链）；progress=周期进展报告。
   */
  readonly injectClosure?: (agentId: string, message: string, source?: "closure" | "progress") => void;
  /** stalled 轮询间隔 ms（缺省 阈值/2；测试注入小值）。 */
  readonly stalledPollMs?: number;
  /**
   * spawn 锚计算（契约 v0.3 §1 规则②，AD-5）：spawn 时刻聚合内最后一条
   * main/compaction entry 的 id（无 → null 流首）。组合根注入（会话聚合视图
   * 读面）；spawn 处理点计算一次，随实例视图内存携带（派生值不落盘，无第二
   * 事实源——E-AgentInstance 禁忌）；缺省 = 纯调度测试形态（锚点面缺席）。
   */
  readonly spawnAnchorFor?: (sessionId: string) => string | null;
  /**
   * 占用协调回调（U4，一行转发）：subagent 终态 → 租约摘执行者（isolated
   * 租约执行者清空即释放）；worktree 登记 → isolated 租约登记。组合根接
   * CoordinationService；缺省不通知（纯调度测试形态）。
   */
  readonly onSubagentSettled?: (executorId: string) => void;
  readonly onWorktreeClaim?: (input: { sessionId: string; executorId: string; worktreeRoot: string }) => void;
  /**
   * 会话运行态读口（U2 观测态）：main 实例 displayState 编译输入——
   * SessionRegistry.runStateOf 消化后的三值词汇。晚绑闭包（组合根
   * registry 建成后回填；scheduler 先于 registry 构造）；缺省 = 冷会话
   * idle 语义（displayStateOf 对 undefined 同 idle）。
   */
  readonly sessionRunStateOf?: (sessionId: string) => SessionRunStateLike;
  /**
   * Sub 实例化快照供给（AD-5，契约 v0.4 §2）：spawn 时与
   * agent.spawned 同批发布 agent.instantiated 的快照数据源——profile 常量
   * （systemPrompt 全文/工具集/hooks 名）与模型两级链解析（profile 槽位 ??
   *   全局兜底，AD-3 联动；T12 砍 spawn 会话快照级）均归组合根装配（driven
   *   常量不进 application）；缺省 = 纯调度测试形态，不发布 instantiated。
   * 入参 profileKind（D8 W-R6）：实例 kind 派发（subagent-kg-writer 领
   * 豁免面快照——组合根组装缓存按 kind 拼生效集）。
   */
  readonly subagentSnapshotFor?: (profileKind?: string, sessionId?: string) => {
    readonly profileSnapshot: AgentInstantiatedPayload["profileSnapshot"];
    /** spawn 解析的 thinkingLevel 快照（AD-4④；与 launcher resolveThinkingFor 同源同时点；无配置 → undefined = 默认关）。 */
    readonly thinkingLevel: string | undefined;
  };
  /**
   * 任务文本切片注入器（T3.3，CL-1 F1.3；检索语义化批 async 化）：spawn
   * 派发时任务文本 → 图查询（关键词轨 ∪ 向量轨）→ digest+指针切片拼入
   * task 约束区（组合根接 KgQueryService.injectTaskSlice——sessionId 即
   * 跨通道去重键）。返回值 = 子进程实际收到的 task；注入器抛错/缺席 →
   * 原文透传（注入是增强，绝不阻断 spawn）。异步落定（嵌入往返超时上限
   * 800ms——用户裁决：延迟可接受不预热缓存）；无嵌入往返的注入器可同步
   * 落定（Awaitable，与 spawn 返回口径同构）。
   */
  readonly taskInjector?: (sessionId: string, task: string) => string | Promise<string>;
  /**
   * 实例终态钩子（CDP 地基）：done/failed/killed 收口链完成后回调——
   * 组合根接 `browserPort.reclaimOwner`（回收该 owner 全部 managed tabs，
   * 浏览器侧资源随 agent 终态释放；idle sweep 兼底）。可选——纯调度测试
   * 形态不注入；迟到/重复收口被门面幂等吞，钩子恰好触发一次。
   */
  readonly onInstanceTerminal?: (agentId: string) => void;
  /** 日志（容器接 file logger——kill 终止信号失败/findings 落账跳过可观测；缺省静默）。 */
  readonly logger?: { warn: (message: string) => void };
  /**
   * findings 落账管道（F3.0③，透传 ClosureRecorder）：findings 文件 canonical（旧格式信封兼容回退）
   * 非空时映射 kg 写 op 落账（组合根接 kg 栈 KgWriteService 唯一写入口）。
   * 缺省不落账（纯调度测试形态）。
   */
  readonly findingsSink?: ClosureFindingsSink;
  /**
   * pending_sync job 归属解析（W2-D R13，透传 ClosureRecorder）：task:*
   * 会话 → jobId、chat 会话 → null；缺省恒 null（job_id 可空列）。
   */
  readonly pendingSyncJobIdOf?: (sessionId: string) => string | null;
}
