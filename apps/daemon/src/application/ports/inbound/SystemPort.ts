/**
 * daemon 系统级入口端口（inbound，architecture.md §3.4）。
 *
 * 状态查询与优雅关闭等系统操作；实现由组合根/生命周期侧提供
 * （lifecycle.ts 持有进程级事实）。本文件只有接口定义（AG-01）。
 */

export interface DaemonStatus {
  /** daemon 是否处于运行中（未 shutdown）。 */
  readonly running: boolean;
  /** 单例锁是否持有（同 --home 二启检测，AG-17）。 */
  readonly locked: boolean;
  /** 主目录（--home 解析结果）。 */
  readonly home: string;
  /** 当前会话 id。 */
  readonly sessionId: string;
  /** agent 生命周期状态。 */
  readonly agentState: string;
  /** 配置的模型字符串（未配置时 undefined）。 */
  readonly model?: string;
}

export interface SystemPort {
  getStatus(): DaemonStatus;
  /** 优雅关闭：停输入、等当前 run 收尾、释放单例锁。 */
  shutdown(): Promise<void>;
}
