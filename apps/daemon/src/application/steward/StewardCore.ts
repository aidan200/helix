/**
 * StewardCore —— 管家三域共享内核（体量门 P4）。
 *
 * 定位：StewardService 原私有状态面收编——依赖注入面、可达状态容器
 * （ProposalLedger / StewardRun / AskQueue / StewardToolKit）、伴随编排态
 * （askSettler/pendingRunAsk/askStreamEvents/projectionChain/runSettled）与
 * 引擎代际引用，外加三个横切小面（money gate 读面、生命周期 info 日志、
 * 工作记忆追加/窗口投影）。
 *
 * 为什么存在：体量门 P4 把 StewardService 按职责三拆为
 * 分诊路由（StewardRouting）/ 播报编排（StewardOutlet）/ 生命周期
 * （StewardLifecycle）三个协作模块；三域共享的可变状态不能各持一份（那会
 * 重新造出「多处清锚」族问题），一律留在本内核单点持有——域类只持有
 * `core` 引用，方法体里 `this.<状态>` 与拆分前逐字等价（迁移只做
 * `this.X → this.core.X` 改写）。
 *
 * 纪律面：run 状态与锚清理仍只经 StewardRun 迁移方法（E-289）；确认闸
 * 状态判定仍只经 ProposalLedger（E-288/TR-240）——本类不复制任何判定逻辑。
 */
import { AskQueue } from "../../domain/steward/run/AskQueue";
import { StewardRun } from "../../domain/steward/run/StewardRun";
import { ProposalLedger, type PendingAction } from "../../domain/steward/confirmation/ProposalLedger";
import { STEWARD_TUNING_DEFAULTS, type StewardTuning } from "../../domain/steward/tuning/StewardTuning";
import type { StewardAskErrorKind, StewardHistoryRecord } from "@helix/protocol";
import type { AgentEnginePort } from "../ports/outbound/AgentEnginePort";
import type { StewardLlmMessage } from "../ports/outbound/StewardLlmPort";
import { StewardDialogMemory } from "./StewardDialogMemory";
import { StewardToolKit } from "./tools/StewardToolKit";
import { buildLlmWindow } from "./stewardProjections";
import { STEWARD_ENABLED_KEY } from "./stewardConstants";
import type { StewardAskEvents, StewardAskItem, StewardServiceDeps } from "./stewardServiceTypes";
import type { StewardRouting } from "./StewardRouting";
import type { StewardOutlet } from "./StewardOutlet";

export class StewardCore {
  /** 依赖注入面（原 StewardService.deps——域类经 core.deps 消费）。 */
  readonly deps: StewardServiceDeps;
  /** 工作记忆 KV（完整记录持久化——thinking/工具/对话全形态；daemon 重启
   *  后懒加载恢复，A1 批取代裸内存数组）。 */
  readonly dialog: StewardDialogMemory;
  /** 时钟（记录 at 时间戳；缺省 Date.now）。 */
  readonly now: () => number;
  /** 行为阈值现拍面（批 0：缺省 STEWARD_TUNING_DEFAULTS；组合根接 KV 现拍
   *  运行期即热——每 tick 消费成本可忽略）。 */
  readonly tuningOf: () => StewardTuning;
  /** 确认闸聚合（批 1：pending 卡集合 + 终局登记簿 + 卡生命周期判定——
   *  domain/steward/confirmation/ProposalLedger 纯状态机，应用层只做编排
   *  与出站翻译；行为零变更）。 */
  readonly ledger: ProposalLedger;
  /** 工具面（批 3a 收编 tools/StewardToolKit——registerTools/挂闸/工具体）。 */
  readonly toolKit: StewardToolKit;
  /** ask 自持队列（批 2 收编 AskQueue 值对象——上限 tuning.ask.queueMax 即热，
   *  E-197 行为等价：FIFO 不丢/满拒新/收口后自动下一轮）。 */
  readonly askQueue: AskQueue<StewardAskItem>;
  /** run 状态容器（批 2：6 散字段收编；锚清理只经容器迁移方法）。 */
  readonly run: StewardRun<StewardAskErrorKind>;

  /** 段B翻转：pi 引擎（懒构造——首问时经 createEngine 唯一配方装配，
   *  dialog 懒加载回填 initialMessages）。 */
  engine: AgentEnginePort | undefined;
  /** 当前 run 的挂闸提案候选（confirm_required 回执映射锚——每 run 重置）。 */
  currentPause: { actionId: string; action: PendingAction }[] = [];
  /** 当前 run 驱动的 ask 项（收口 deliver 回执锚）。 */
  pendingRunAsk: StewardAskItem | undefined;
  /** ask promise 收口器（confirm_required 在 engine_paused 即收，其余 agent_end）。 */
  askSettler: ((payload: import("@helix/protocol").StewardAskResultPayload) => void) | undefined;
  /** 当前 run 事件投影链（KV 写入与收口定序——事件乱序投影即数据竞争）。 */
  projectionChain: Promise<void> = Promise.resolve();
  /** 当前 ask 的流式回调（事件转发面）。 */
  askStreamEvents: StewardAskEvents = {};
  /** run 收口通知（driveAsk 的 abort-再驱动路径等 settle）。 */
  runSettled: Promise<void> = Promise.resolve();
  /** run 收口通知标记（runSettled promise 的 resolve 句柄）。 */
  runSettledMark: (() => void) | undefined;
  /** 当前 run 供判官/看门狗持有的代际号（occupy 时递增——异步判定只作用于
   *  发问时那一代）。 */
  runEpoch = 0;
  /** 可靠性提醒帧序（emitNotify 单调 seq——与感知服务同构）。 */
  notifySeq = 0;
  /** 主动汇报实时帧序（emitProactive 单调 seq——M3-a，与 notify 同构口径）。 */
  proactiveSeq = 0;
  /** feed 帧序（steward.feed 单调 seq）。 */
  feedSeq = 0;
  /** 可靠性批巡检定时器（生产 interval 句柄——start/stopReliabilityTimers；
   *  测试不启定时器直接调 reliabilityTick 注入时钟）。 */
  reliabilityTimer: ReturnType<typeof setInterval> | undefined;

  /** 三域装配位（聚合根 StewardService 构造时回填——域间协作经 core.<域>）。 */
  routing!: StewardRouting;
  outlet!: StewardOutlet;

  constructor(deps: StewardServiceDeps) {
    this.deps = deps;
    this.dialog = deps.dialog ?? new StewardDialogMemory();
    this.now = deps.clock ?? (() => Date.now());
    this.tuningOf = deps.tuningOf ?? (() => STEWARD_TUNING_DEFAULTS);
    this.ledger = new ProposalLedger({ now: () => this.now() });
    this.run = new StewardRun<StewardAskErrorKind>(() => this.now());
    this.askQueue = new AskQueue<StewardAskItem>(() => this.tuningOf().ask.queueMax); // 批 2：上限现拍（KV 即热）
    // 批 3a：工具面收编 StewardToolKit（deps 全量透传；executePending 不注入
    // ——挂闸工具 execute 不直行写动作，确认执行体留在分诊路由域 confirm）
    this.toolKit = new StewardToolKit(deps);
  }

  /** 三域装配（门面构造序单点——域类跨域调用依赖本步已完成）。 */
  bindDomains(domains: { routing: StewardRouting; outlet: StewardOutlet }): void {
    this.routing = domains.routing;
    this.outlet = domains.outlet;
  }

  /** 八工具中立规格（createEngine 装配面——委托 toolKit 观测面）。 */
  get toolSpecs(): readonly import("../ports/outbound/StewardToolSpec").StewardToolSpec[] {
    return this.toolKit.toolSpecs;
  }

  /** 隐藏面板原语名（不进引擎工具面——getProfile 观测面合并显示）。 */
  get hiddenToolNames(): readonly string[] {
    return this.toolKit.hiddenToolNames;
  }

  /** 开关现态（money gate 读面）。 */
  isEnabled(): boolean {
    return this.deps.config.get(STEWARD_ENABLED_KEY) === "1";
  }

  /** 生命周期 info 日志（旧装配 logger 无 info 位时降级静默）。 */
  logInfo(message: string): void {
    this.deps.logger?.info?.(message);
  }

  /** 完整记录追加（工作记忆 KV——预算闸在 memory 内部）。 */
  async pushRecord(record: StewardHistoryRecord): Promise<void> {
    await this.dialog.append(record);
  }

  /** 工作记忆镜像 → LLM 消息窗口（同源：UI 回放显示的 = LLM 记得的；
   *  A1-hotfix：经 buildLlmWindow 配对防御——孤儿 toolResult 丢弃/缺结果
   *  toolCall 补合成结果；KV 存储与 history 回放读面不动）。 */
  dialogSnapshotMessages(): StewardLlmMessage[] {
    return buildLlmWindow(this.dialog.snapshot());
  }
}
