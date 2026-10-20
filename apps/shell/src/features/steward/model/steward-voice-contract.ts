/**
 * steward-voice-contract —— useStewardVoice 接口面契约（P2 体量门 ④ 轻拆批：
 * 从 useStewardVoice.ts 机械迁出，声明逐字未改；消费方仍从 useStewardVoice
 * 导入——组合根 re-export 保公共 API 面不变）。
 *
 * 两面：注入面 UseStewardVoiceOptions（测试缝：设备面/时钟面）+ 返回面
 * UseStewardVoice（面板/光球层消费的全量读取面与命令面）。
 */
import type { StewardAskSource } from "@helix/protocol";
import type { PcmPumpFactory } from "@/shared/lib/pcm-pump";
import type { RmsMeterFactory } from "@/shared/lib/rms-meter";
import type { SpeechPlayerFactory } from "@/shared/lib/pcm-player";
import type { useSteward, StewardAskActivity, StewardPanelItem } from "./useSteward";
import type { StewardInputMode, StewardVoicePhase } from "./steward-voice-machine";

/** useStewardVoice 注入面（测试缝：设备面/时钟面可注入——生产调用方缺省）。 */
export interface UseStewardVoiceOptions {
  /** RMS meter 工厂（透传 useVoiceInput；测试注入 fake）。 */
  readonly createMeter?: RmsMeterFactory;
  /** PCM 泵工厂（透传 useVoiceInput；测试注入 fake）。 */
  readonly createPump?: PcmPumpFactory;
  /** 终帧等待上限 ms（缺省 STREAM_FINAL_TIMEOUT_MS；测试注入短窗）。 */
  readonly streamFinalTimeoutMs?: number;
  /** 流式朗读播放器工厂（缺省 Web Audio；测试注入 fake——jsdom 无音频设备）。 */
  readonly createPlayer?: SpeechPlayerFactory;
  /** B2 欢迎语文本（缺省 i18n 常量；Layer 注入）。 */
  readonly welcomeText?: string;
  /** B2 终帧拦截钩（D3=b 语音口令）：返回 "consumed" = 前端本地消费零 ask
   *  （口令解析/执行面 voice-command.ts + StewardVoiceLayer）；"pass" = 照发。
   *  第二参 ctx（意图窗批）：bargeInIntent = final 落在意图窗内——消费方
   *  （Layer）走意图判定分支（声纹→Jev 停止判定→真停/丢弃）而非常规口令/ask 链。 */
  readonly onFinalText?: (text: string, ctx?: { bargeInIntent: boolean }) => "consumed" | "pass";
}

export interface UseStewardVoice {
  // ── useSteward 整面透传（面板数据面不二开；A1：messages → items 过程条目）──
  readonly items: readonly StewardPanelItem[];
  readonly streamingText: string | null;
  /** ask 进行中态投影（过程活动行数据面——useSteward 同构透传：phase 随最近
   *  过程帧切 thinking/tool + thinking 首行摘要窗；null = 非在途。光球字幕
   *  活动行与面板状态区同源同形（TR-241 语音版）。 */
  readonly askActivity: StewardAskActivity | null;
  readonly feed: ReturnType<typeof useSteward>["feed"];
  readonly askInFlight: boolean;
  readonly config: ReturnType<typeof useSteward>["config"];
  /** dropped 通知序号（闸门对应修复批：addressee 静默丢弃时递增——光球字幕
   *  note 淡行消费；零播报零条目不变）。 */
  readonly dropNoticeSeq: number;
  ask(text: string, source?: StewardAskSource): boolean;
  /** 声纹总闸放行后的 utterance 派发口（StewardVoiceLayer consumed 自派发
   *  专用）：发问 + planTranscript 回退（与 routeToAsk 同构）；source 按
   *  双工态自动归类（voice-duplex = addressee 判定触发面）。 */
  submitUtterance(text: string): void;
  newDialog(): boolean;
  // ── 双模（互斥；打开默认 voice）──
  readonly mode: StewardInputMode;
  setMode(mode: StewardInputMode): void;
  // ── 语音面 ──
  /** 面板唯一阶段事实源（idle/listening/transcribing/asking/speaking/unsupported）。 */
  readonly phase: StewardVoicePhase;
  /** 实时电平 0..1（listening 波形可视化数据源；他态恒 0）。 */
  readonly level: number;
  /** 用户正在发声（最近 ~900ms 人声判据帧；recording 外恒 false）——光球
   *  相位细分：开麦未开口 → 待机驻留（waking），开口才转倾听。 */
  readonly userSpeaking: boolean;
  /** 流式 interim 文本（listening/transcribing 态实时上屏；prior+text+stash
   *  拼接态；final 到达替换、出态清空；null = 无）。 */
  readonly interim: string | null;
  /** 流式链已降级（开流失败/终帧超时/error——本轮回落非流式；不弹错误卡，
   *  面板一处不显眼提示消费）。 */
  readonly streamDegraded: boolean;
  /** TTS 朗读中（speaking 态同义布尔——静音钮显隐）。 */
  readonly speaking: boolean;
  /** TTS 在途队列深度（光球左上角计数徽标：流式在途句 + 一次性回执在播）。 */
  readonly ttsQueue: number;
  /** 转写/录音侧最近失败原因（toast 消费；null = 无）。 */
  readonly voiceError: string | null;
  /** ask 发送失败的转写文本（面板采纳进输入框后 clearVoiceDraft 清位）。 */
  readonly voiceDraft: string | null;
  /** 点击 mic 开始说话（新一轮：先停上轮朗读；流式开流同步发出）。 */
  startListening(): Promise<void>;
  /** 录音中点击 = 强制停（转写链照常：流式 finish 或回落非流式）。 */
  stopListening(): void;
  /** 静音钮：一键停读（在播音频即停；无播报 no-op）。 */
  stopSpeaking(): void;
  /** 面板采纳转写回填后清位。 */
  clearVoiceDraft(): void;
  /** 手动退出双工会话（Esc / 组合键再按）：关麦收场，零 ask。
   *  B2 起 = duplex 会话收口（停采集 + 停朗读 + duplex 落）。 */
  cancelWake(): void;
  // ── B2 双工会话面（光球层数据源）──
  /** 双工会话活跃（组合键开 → 关麦收口落；光球可见性/耳 meter 采样窗）。 */
  readonly duplexActive: boolean;
  /** 欢迎语期（duplex 开启后、用户开口前——欢迎语音频在播标记；光球待机驻留）。 */
  readonly welcomeActive: boolean;
  /** 通知轨播报占用镜像（speech-floor 边沿订阅——光球说话姿驱动；与 barge-in
   *  门武装面同信号源：通知语音不驱动 speaking 相位，视觉面由此镜像补齐）。 */
  readonly notifSpeaking: boolean;
  // ── barge-in 意图窗（意图门控打断：停止意图才真停，其余声音保持播报）──
  /** 意图窗并（barge-in 声学触发后→意图判定中：播报 duck 不停、收音豁免门控
   *  收插话）；Layer 的 onFinalText 读 ctx.bargeInIntent 分流，窗收口由
   *  executeBargeInStop（真停）/ closeBargeInIntentWindow（不打断）驱动。 */
  readonly bargeInIntentActive: boolean;
  /** 真停（停止意图确认）：三步打断序（停播全轨 + interrupt + 靠自动续听重开
   *  收音）——窗先关再执行，录音链/续听照常。 */
  executeBargeInStop(): void;
  /** 窗收口不真停（噪音/旁人/非停止插话）：恢复音量 + 回收音门控；录音链
   *  照常（自动续听边沿重开）。 */
  closeBargeInIntentWindow(): void;
  // 批 3b 退役（裁决 #2）：queueUtterance（排队插话）拆除——播报期单向
  // 广播，判非 stop = 丢弃关窗。
  /** 停止意图判定（Jev 单轨——停止词表退役批，daemon 判官 noul 回执
   *  steward.judge_stop_intent.result）。三态判定："stop" = 判要打断；
   *  "other" = 判不打断；"unjudged" = 判不出（判官降级/抛错/超时/不可达
   *  ——fail-stop 归消费面：窗内判不出=真停宁误停不漏停，非窗内判不出=
   *  照常派发不吞用户发言）。不抛异常（异常归一 unjudged）。 */
  judgeStopIntent(text: string): Promise<"stop" | "other" | "unjudged">;
  /** 临时静音（D5：listening 点击切换——静音期续听挂起，duplex 会话保持）。 */
  readonly muted: boolean;
  /** D5 点击行为：listening 点击 = 临时静音切换（speaking 停读归 stopSpeaking）。 */
  toggleMute(): void;
  /** B2 光球唤起入口（wake-hotkey / steward-open-signal 接线共径——Layer 消费）。 */
  toggleWake(): void;
  /** B2 主动发言（欢迎语/口令回读同链；money 闸内判——偏好关零合成）。 */
  say(text: string): void;
  /** M3-c 声纹面：取本句音频（授权点专用——尾部语音段 Int16 域 PCM；
   *  null = 无语音可用。duplex 收口清环，跨会话旧音频不泄入）。
   *  fromMark = 从 barge-in 开窗标记帧起选（声纹防自声污染——duck 期管家
   *  自声持续过门限，常规回溯会扩到窗前独白导致恒 reject）。 */
  lastUtterancePcm(opts?: { fromMark?: boolean }): Float32Array | null;
}
