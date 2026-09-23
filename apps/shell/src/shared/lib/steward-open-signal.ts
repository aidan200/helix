/**
 * 「唤起管家光球」进程内信号（B2 全局语音批：接线方从 setStewardOpen(true)
 * 改为唤起光球——唤醒 = 光球浮现 + 欢迎语 + 持续麦双工，**不弹面板**；
 * app 层 AppRoutes 订阅计数递进 → StewardVoiceLayer 消费唤起）。
 *
 * FSD 链路与 open-settings-signal 同构（TR-203 跨层指路信号定式）：
 * - 发起方（features 层）→ requestOpenSteward（features 引 shared 合法）；
 * - 接线方 = app 层 AppRoutes 订阅 → voiceWakeSignal 递进 → 光球层唤起
 *  （已在双工会话 = 无感幂等；全局热键路径在 useStewardVoice 内直连
 *  wake-hotkey 注册面零经信号）。
 *
 * 不用 pending 单例而用 listener 广播：触发时机任意（全局快捷键随时），
 * 订阅制零轮询；App 重挂载自然重订阅。
 */

type OpenStewardListener = () => void;

const listeners = new Set<OpenStewardListener>();

/** 发起：请求唤起管家光球（已在双工会话 = 无感幂等）。 */
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
