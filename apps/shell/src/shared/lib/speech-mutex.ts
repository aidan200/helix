/**
 * speech-mutex —— 播报-收音互斥（管家语音交互闭环批 ⑥：问题 11 根修）。
 *
 * 病根（2026-10-06 同日报告）：daemon 播报服务与 shell 收音零互斥——
 * duplex listening 中播报（任务终态语音/管家触达短句）插入，TTS 自声经
 * 扬声器回灌麦克风（无 AEC）→ 转写污染（「回执冲掉说话」）。
 *
 * 务实解（不做系统级 AEC——那是系统级工程）：播报侧发言期登记租约，
 * 收音侧（useStewardVoice duplex listening）订阅互斥态——speaking 期本地
 * 暂停 STT 上行（onPcmFrame 门控，流保持开——不重开流不丢用户话），播报
 * 完成（duplex 仍活跃）自动恢复收音。模块级单例（audio-output-warmup /
 * steward-open-signal 同构——跨 hook 通信用，无 React context 依赖）。
 *
 * 租约语义：多源计数（同 source 幂等——重复 begin 不叠租约）；全零 →
 * 互斥态 false（0→1 / 1→0 边沿通知监听者，非边沿零通知）。
 */

/** 活跃租约源（幂等集）。 */
const activeLeases = new Set<string>();

/** 互斥态监听者（speaking 边沿通知）。 */
const listeners = new Set<(speaking: boolean) => void>();

/** 边沿通知（监听器抛错隔离不阻断其余监听者——通知面绝不断播报链）。 */
function notify(speaking: boolean): void {
  for (const l of [...listeners]) {
    try {
      l(speaking);
    } catch {
      // 隔离单监听者异常（收音门控不依赖监听面——抛错零扩散）
    }
  }
}

/** 当前互斥态（有任一播报租约在场 = true）。 */
export function speechLeaseActive(): boolean {
  return activeLeases.size > 0;
}

/**
 * 播报开始登记（source 幂等——同源重复 begin 不叠加）。首个租约进入时
 * 通知监听者 speaking=true。
 */
export function beginSpeechLease(source: string): void {
  if (activeLeases.has(source)) return;
  const wasActive = activeLeases.size > 0;
  activeLeases.add(source);
  if (!wasActive) notify(true);
}

/**
 * 播报结束释放（未知源 no-op）。最后一个租约释放时通知 speaking=false。
 */
export function endSpeechLease(source: string): void {
  if (!activeLeases.delete(source)) return;
  if (activeLeases.size === 0) notify(false);
}

/** 订阅互斥态边沿（返回退订函数）。监听器抛错隔离不阻断其余监听者。 */
export function onSpeechMutexChange(listener: (speaking: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试隔离用：清空租约与监听者（生产零调用）。 */
export function resetSpeechMutexForTest(): void {
  activeLeases.clear();
  listeners.clear();
}
