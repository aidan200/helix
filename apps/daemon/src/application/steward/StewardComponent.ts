/**
 * StewardComponent —— 管家域服务生命周期契约（DDD 重构批 0：§3.4）。
 *
 * 为什么存在：批 0 前管家域各服务（StewardService 可靠性巡检定时器、
 * StewardMemoryService 淡忘 GC 定时器）各自在组合根手工挂 start 与
 * shutdown 双端——每新增一个带定时器/后台任务的服务都要记得两处挂点，
 * 漏挂即泄漏（排查清单 #11）。统一契约后组合根维护登记表统一启停，
 * 新服务实现本接口登记即入生命周期。
 *
 * 语义：
 * - start/stop 幂等（二调不炸不二启；stop 后可再 start——测试反复装配面）；
 * - stop 即 shutdown 挂点语义：停定时器、释放后台资源；不承诺在途 run
 *   的优雅收口（半截流随进程消亡，协议面不变——设计文档 §3.4 定界）。
 */
export interface StewardComponent {
  /** 启动后台面（定时器/巡检；幂等）。 */
  start(): void;
  /** 停止后台面（shutdown 挂点；幂等）。 */
  stop(): void;
}
