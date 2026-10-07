/**
 * speech-floor —— 出声面发言协调器（播×播互斥；双声重叠修复批 ①④）。
 *
 * 病根（2026-10-06 用户报告「两段语音同时播放」）：四条出声面互不排他——
 * 流式播放器（a）/一次性回执 Audio（b）/通知播报队列（c）/欢迎语固化音频
 * （d，用户裁决不接——很短不值得接，现状行为保持）任意两者可同时出声。
 *
 * 与 speech-mutex（播×收互斥）正交并存：租约管「播报期暂停收音上行」（拦
 * STT 上行不拦耳 meter——barge-in 判定活路），本面管「同一时刻对话压过通知」
 * ——两维度不混（E-257 租约语义零改动）。
 *
 * 收编语义（优先级：对话 > 通知）：
 * - 对话发言期 = 任一对话源在场：回答轮在途（askInFlight——ask 发出到终态）、
 *   a 流式播放器在播、b 一次性回执 Audio 在播。口令回读（sayNow）经 a 面首
 *   块起播自然占面；
 * - 新对话发言期开始（空 → 首源）→ 通知面 stopAndClear：停 c 在播 + 清队列
 *   （最新对话优先——c 弃播不回放）；
 * - c 到达时对话发言期在场 → 延后入队（不打断对话），对话收口（末源退出）→
 *   resume 串行放行；
 * - 全轨停止（stopSpeaking 的④扩面）：stopNotificationSpeech 直停通知面
 *   （弃播不续——内容 toast/活动流可查，不排队回放）。
 *
 * 模块级单例（speech-mutex/audio-output-warmup 同构——跨 hook 通信用，无
 * React context 依赖；useVoiceBroadcast 挂载注册通知控制，useStewardVoice
 * 各对话源 begin/end 配对）。
 */

/** 通知播报控制面（useVoiceBroadcast 挂载注册；卸载注销 null）。 */
export interface NotificationSpeechControl {
  /** 对话发言期开始 / 全轨停止：停当前在播 + 清空队列（弃播不续）。 */
  stopAndClear(): void;
  /** 对话发言期收口：串行放行延后队列（空队列/在播中 no-op）。 */
  resume(): void;
}

/** 活跃对话源（幂等集——与 speech-mutex 租约同构的边沿语义）。 */
const dialogueSources = new Set<string>();

/** 通知面控制（useVoiceBroadcast 未挂载时 null——全程 no-op）。 */
let notificationControl: NotificationSpeechControl | null = null;

/** 通知面控制登记（控制面生命周期归挂载方——卸载传 null 收位）。 */
export function registerNotificationSpeech(control: NotificationSpeechControl | null): void {
  notificationControl = control;
}

/** 对话发言期判别（任一对话源在场）。c 面起播前查——在场即延后。 */
export function dialogueSpeechActive(): boolean {
  return dialogueSources.size > 0;
}

/**
 * 对话源发言开始（source 幂等——同源重复 begin 不叠加）。首个源进入时
 * 停掉通知面在播 + 清队列（最新对话优先）。
 */
export function beginDialogueSpeech(source: string): void {
  if (dialogueSources.has(source)) return;
  const wasIdle = dialogueSources.size === 0;
  dialogueSources.add(source);
  if (wasIdle) notificationControl?.stopAndClear();
}

/**
 * 对话源发言结束（未知源 no-op）。最后一个源退出时放行通知面（延后队列
 * 串行起播）。
 */
export function endDialogueSpeech(source: string): void {
  if (!dialogueSources.delete(source)) return;
  if (dialogueSources.size === 0) notificationControl?.resume();
}

/** 全轨停止的通知面（stopSpeaking ④扩面入口）：弃播不续（零放行）。 */
export function stopNotificationSpeech(): void {
  notificationControl?.stopAndClear();
}

// ── 通知占用（打断不灵敏修复：通知播报期 barge-in 门武装面）────────────────
// 通知语音（c 面）不驱动 steward speaking 相位（相位只由对话轨 a/b 派生）——
// 无此面时通知播报期相位 idle → 打断门未武装 → 用户喊停零拾取。占用镜像由
// useVoiceBroadcast 播放边沿驱动；useStewardVoice 门武装读它（等价 speaking
// 相位语义：阈值 ×2 抬档防自声回灌）。
let notificationPlaying = false;

/** 通知播报占用开始（useVoiceBroadcast 起播边沿；幂等）。 */
export function beginNotificationPlayback(): void {
  notificationPlaying = true;
}

/** 通知播报占用结束（播毕/停播/清队列边沿；幂等）。 */
export function endNotificationPlayback(): void {
  notificationPlaying = false;
}

/** 通知播报占用判别（barge-in 门武装面：语音模式 × 占用 → 门开）。 */
export function notificationSpeechActive(): boolean {
  return notificationPlaying;
}

// ── 麦克占用（重叠修复：收音/转写期延后通知——用户说话不叠播报）──────────────
// 通知到达时若用户正在说话（recording/transcribing），立即播会双声重叠且 TTS
// 灌麦污染转写。占用由 useStewardVoice 录音链态驱动；useVoiceBroadcast 的
// playNext 查它延后；释放（true→false 边沿）触发 resume 串行放行。
let micOccupiedState = false;

/** 麦克占用置位/复位（幂等；复位边沿触发通知 resume）。 */
export function setMicOccupied(occupied: boolean): void {
  if (micOccupiedState === occupied) return;
  micOccupiedState = occupied;
  if (!occupied) notificationControl?.resume();
}

/** 麦克占用判别（通知播放前的延后检查）。 */
export function micOccupied(): boolean {
  return micOccupiedState;
}

/** 测试隔离用：清空对话源与通知控制（生产零调用）。 */
export function resetSpeechFloorForTest(): void {
  dialogueSources.clear();
  notificationControl = null;
  notificationPlaying = false;
  micOccupiedState = false;
}
