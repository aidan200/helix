/**
 * startParentWatchdog —— sidecar 父死看门狗（H-4；contracts/sidecar-lifecycle.md §3
 * daemon 侧义务补款）。
 *
 * 背景：壳对 sidecar 的收编（SIGTERM→5s→SIGKILL）只在壳优雅退出路径执行；
 * 壳异常死亡（SIGKILL/崩溃/Ctrl+C 前台进程组广播秒杀——Rust 壳无 SIGINT
 * 处理器）时收编被跳过，sidecar 被 reparent 到 pid 1 成为孤儿，持单例锁
 * 常驻 → 下次启动新 sidecar 撞锁 fail-fast、壳看护重试 3 次注定失败
 * （「锁冲突」非瞬时崩溃），应用被砖化。
 *
 * 判据：sidecar 形态下壳恒直 spawn 且终身看护——父死即孤儿（ppid→1，
 * macOS launchd / Linux init 回收重挂），无歧义形态。周期判定 ppid===1
 * → onOrphan（调用方接优雅关停，与 SIGTERM 同路径）。
 *
 * 判据/动作/间隔全注入（unit 测试零真进程依赖）。仅 sidecar 形态接线
 * （CLI 形态父 = 终端会话，父死不适用本语义——CLI 由终端 SIGHUP 体系管）。
 */

export interface ParentWatchdogDeps {
  /** 孤儿判定后动作（调用方接优雅关停；保证至多触发一次）。 */
  readonly onOrphan: () => void;
  /** ppid 读面（缺省 process.ppid；测试注入可控源）。 */
  readonly ppidOf?: () => number;
  /** 判定周期 ms（缺省 5000——孤儿泄漏窗口上限；测试注入小值）。 */
  readonly intervalMs?: number;
}

/** 启动看门狗，返回停止函数（关停竞态收口：stop 后不再触发）。 */
export function startParentWatchdog(deps: ParentWatchdogDeps): () => void {
  const ppidOf = deps.ppidOf ?? (() => process.ppid);
  const intervalMs = deps.intervalMs ?? 5000;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (ppidOf() !== 1) return;
    stopped = true; // 一次性判定：触发即自停（onOrphan 不得重入）
    clearInterval(timer);
    deps.onOrphan();
  }, intervalMs);
  timer.unref?.(); // 看门狗不得成为事件循环保活源（保活归 WS 服务）
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
