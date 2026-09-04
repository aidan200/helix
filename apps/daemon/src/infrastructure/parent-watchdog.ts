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
 * 判据：sidecar 形态下壳恒直 spawn 且终身看护——父死即孤儿（posix 下
 * ppid→1，macOS launchd / Linux init 回收重挂；win32 无 reparent-to-1
 * 语义，ppid 滞留死父 pid——补 kill(ppid, 0) 存活探测双判据，TR-95
 * windows-x64 兼容面），无歧义形态。周期判定 → onOrphan（调用方接优雅
 * 关停，与 SIGTERM 同路径）。
 *
 * 判据/动作/间隔全注入（unit 测试零真进程依赖）。仅 sidecar 形态接线
 * （CLI 形态父 = 终端会话，父死不适用本语义——CLI 由终端 SIGHUP 体系管）。
 */

export interface ParentWatchdogDeps {
  /** 孤儿判定后动作（调用方接优雅关停；保证至多触发一次）。 */
  readonly onOrphan: () => void;
  /** ppid 读面（缺省 process.ppid；测试注入可控源）。 */
  readonly ppidOf?: () => number;
  /** 父存活探测（win32 缺省自动启用 kill(pid, 0)——win32 无 ppid→1 重挂，
   * 孤儿判据靠它；posix 缺省不探测，行为与 ppid===1 单判据时代逐字节一致；
   * 测试注入即启用）。true=存活。 */
  readonly aliveOf?: (pid: number) => boolean;
  /** 判定周期 ms（缺省 5000——孤儿泄漏窗口上限；测试注入小值）。 */
  readonly intervalMs?: number;
}

/** 缺省父存活探测：信号 0 只探测不发送；ESRCH=不存在，EPERM=存在但无权（存活）。 */
function defaultAliveOf(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 启动看门狗，返回停止函数（关停竞态收口：stop 后不再触发）。 */
export function startParentWatchdog(deps: ParentWatchdogDeps): () => void {
  const ppidOf = deps.ppidOf ?? (() => process.ppid);
  // 存活探测启用面：显式注入恒启用（测试钩子）；缺省仅 win32（posix 靠
  // ppid===1 reparent 判据，零行为变化）
  const aliveOf = deps.aliveOf ?? (process.platform === "win32" ? defaultAliveOf : undefined);
  const intervalMs = deps.intervalMs ?? 5000;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const ppid = ppidOf();
    // 双判据：ppid===1（posix reparent 重挂）或父进程已死（win32 主判据——
    // ppid 滞留不重挂；posix 缺省不走此支）
    if (ppid !== 1 && (aliveOf === undefined || aliveOf(ppid))) return;
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
