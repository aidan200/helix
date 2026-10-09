/**
 * StewardRun —— run 状态容器（DDD 重构批 2：执行轮子域）。
 *
 * 绞杀形态（批 2 取舍）：**字段搬运而非语义重写**——批 2 前 run 生命周期
 * 是 StewardService 的 7 个散字段（runActive/runLastProgressAt/
 * watchdogFiredAt/manualAbortAt/pausedGateToken/runState/currentPause 归属
 * 语义）+ 注释约定，本容器把它们收编为显式状态对象，**迁移方法与原读写
 * 点一一对应**（行为等价由一一对应保证；后续批次可在此基础上演化成真
 * 状态机）。核心价值兑现：「三处清锚」类问题从根上消灭——**锚清理只经
 * begin/finish/assemblyFailed/clearAll 迁移函数发生**，任何新代码想动锚
 * 只有一个入口。
 *
 * 迁移面（与原代码对应点）：
 * - occupy：driveAsk 同步占位（runActive=true，零 await 间隙——ask 检查面
 *   立即可见；26ms 双 run 竞态防御，事故热修批④）；
 * - begin：assembleAndRunInner 的 run 开始赋值块（推进锚锚定/双锚清除/
 *   runState 重置/gate 锚清空——原 1476-1493 段）；
 * - touch：onEngineEvent 推进锚（任何引擎事件 = 活跃）；
 * - noteAbort / armWatchdog / forceRecoverPrepared：锚置位与快进轨同步
 *   清锚（防重复 tick 二触）；
 * - finish：finishRun 收口清块（runActive=false + 三锚复位；幂等守卫在
 *   调用方——forceRecover 与自然收口双发防御）；
 * - assemblyFailed：装配异常释放占位（防 runActive 永真死锁队列）；
 * - clearAll：clearHistory 新对话清场。
 *
 * 伴随编排态（askSettler/pendingRunAsk/askStreamEvents/projectionChain/
 * runSettled）与引擎引用（engine 代际守卫）**不收编**——它们与 promise
 * 编排/引擎调用深度耦合，归应用层（记录于设计文档批 2 deviation）。
 */

/** 单 run 结果推导态（事件投影写点经引用共享——批 2 不改写入面）。 */
export interface RunState<ErrorKind extends string = string> {
  lastAnswerText: string;
  hardError: string | undefined;
  hardErrorKind: ErrorKind | undefined;
  softError: string | undefined;
  sawAborted: boolean;
  roundLimit: boolean;
  toolCalls: number;
}

function freshRunState<ErrorKind extends string = string>(): RunState<ErrorKind> {
  return {
    lastAnswerText: "",
    hardError: undefined,
    hardErrorKind: undefined,
    softError: undefined,
    sawAborted: false,
    roundLimit: false,
    toolCalls: 0,
  };
}

/** run 状态容器（时钟注入外零依赖；写点唯一性经迁移方法保证）。 */
export class StewardRun<ErrorKind extends string = string> {
  private readonly now: () => number;
  private _active = false;
  private _lastProgressAt: number | undefined = undefined;
  private _watchdogFiredAt: number | undefined = undefined;
  private _manualAbortAt: number | undefined = undefined;
  private _gateToken: string | undefined = undefined;
  private _state: RunState<ErrorKind> = freshRunState<ErrorKind>();

  constructor(now: () => number) {
    this.now = now;
  }

  /** run 在途自持位（busy 判别——不依赖 engine.isStreaming）。 */
  get active(): boolean {
    return this._active;
  }

  /** 最近事件时刻（看门狗推进锚；undefined = 未锚定哨兵）。 */
  get lastProgressAt(): number | undefined {
    return this._lastProgressAt;
  }

  /** 看门狗已触发时刻（undefined = 未触发；同集 episode 不重复）。 */
  get watchdogFiredAt(): number | undefined {
    return this._watchdogFiredAt;
  }

  /** 手动 abort 时刻（快进锚——abortInFlight 置位、run 边界复位）。 */
  get manualAbortAt(): number | undefined {
    return this._manualAbortAt;
  }

  /** 当前挂闸中的 pauseToken（暂停态新 ask 的 abort-再驱动判别锚）。 */
  get gateToken(): string | undefined {
    return this._gateToken;
  }

  /** 当前 run 结果推导态（引用共享——事件投影写入面批 2 不迁）。 */
  get state(): RunState<ErrorKind> {
    return this._state;
  }

  /** 看门狗判定快照（RunWatchdog 纯函数输入）。 */
  watchdogSnapshot(enginePresent: boolean): {
    runActive: boolean;
    enginePresent: boolean;
    manualAbortAt: number | undefined;
    runLastProgressAt: number | undefined;
    watchdogFiredAt: number | undefined;
  } {
    return {
      runActive: this._active,
      enginePresent,
      manualAbortAt: this._manualAbortAt,
      runLastProgressAt: this._lastProgressAt,
      watchdogFiredAt: this._watchdogFiredAt,
    };
  }

  /** 同步占位（driveAsk——ask 检查面立即可见，零 await 间隙）。 */
  occupy(): void {
    this._active = true;
  }

  /** run 开始赋值块（推进锚锚定/双锚清除/runState 重置/gate 锚清空）。 */
  begin(): void {
    this._active = true; // 幂等（driveAsk 已占位——防御直接调用面）
    this._lastProgressAt = this.now();
    this._watchdogFiredAt = undefined;
    this._manualAbortAt = undefined; // 新 run 清手动锚（上一 run 残锚不残留）
    this._state = freshRunState<ErrorKind>();
    this._gateToken = undefined;
  }

  /** 推进锚步进（任何引擎事件 = 活跃——活跃轮永不触发看门狗）。 */
  touch(): void {
    this._lastProgressAt = this.now();
  }

  /** 手动 abort 置锚（快进轨——abortInFlight）。 */
  noteAbort(): void {
    this._manualAbortAt = this.now();
  }

  /** 看门狗触发置锚（同集 episode 不重复）。 */
  armWatchdog(): void {
    this._watchdogFiredAt = this.now();
  }

  /** 强制收口前置清手动锚（同步防重——finishRun 异步，重复 tick 不二触）。 */
  forceRecoverPrepared(): void {
    this._manualAbortAt = undefined;
  }

  /** 挂闸凭据登记（handleEnginePaused）。 */
  gate(token: string): void {
    this._gateToken = token;
  }

  /** 挂闸凭据清除（pending 清空/收口/clearHistory）。 */
  ungate(): void {
    this._gateToken = undefined;
  }

  /** run 收口清块（runActive=false + 三锚复位；幂等守卫在调用方）。 */
  finish(): void {
    this._active = false;
    this._lastProgressAt = undefined;
    this._watchdogFiredAt = undefined;
    this._manualAbortAt = undefined;
  }

  /** 装配异常释放占位（占位提前后的必需兑底——防 runActive 永真死锁队列）。 */
  assemblyFailed(): void {
    this._active = false;
    this._lastProgressAt = undefined;
    this._watchdogFiredAt = undefined;
    this._manualAbortAt = undefined;
  }

  /** 新对话清场（clearHistory——run 态全复位）。 */
  clearAll(): void {
    this.assemblyFailed();
    this._gateToken = undefined;
  }
}
