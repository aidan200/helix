/**
 * 「升起管家面板」进程内信号（B4 全局组合键批：唤醒待命是显式用户手势触发
 * 的新采集态，须有可见待命指示——组合键触发即请求面板升起，指示与后续
 * 回答同屏可见）。
 *
 * FSD 链路与 open-settings-signal 同构（TR-203 跨层指路信号定式）：
 * - 发起方（features 层 useStewardVoice 唤醒链）→ requestOpenSteward
 *   （features 引 shared 合法）；
 * - 接线方 = app 层 AppRoutes 订阅 → setStewardOpen(true)（开合态在 app 层）。
 *
 * 不用 pending 单例而用 listener 广播：触发时机任意（全局快捷键随时），
 * 订阅制零轮询；App 重挂载自然重订阅。
 */

type OpenStewardListener = () => void;

const listeners = new Set<OpenStewardListener>();

/** 发起：请求升起管家面板（已在开 = 无感幂等）。 */
export function requestOpenSteward(): void {
  for (const listener of listeners) listener();
}

/** 订阅（app 层接线方消费；返回退订函数）。 */
export function subscribeOpenSteward(listener: OpenStewardListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
