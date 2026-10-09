/**
 * useStewardVoice —— 管家语音模式组合钩子（V3a「跟管家说话」闭环 + V3b-1
 * 流式转写面）。
 *
 * 组合四件（纯逻辑面全在 steward-voice-machine.ts——AG-14 分离）：
 * - useSteward（同 slice）：ask/confirm/feed/config 全面透传——面板数据面
 *   单实例单点（TR-169 族防自激：本钩子不再开第二份订阅闸门 effect）；
 * - shared/lib/useVoiceInput（V3a 下移，DI 注入）：录音 + VAD + 转写——
 *   转写回执单飞门控在他消费面（Composer）与本面互不串台；
 * - 流式转写层（V3b-1，本文件）：stt.stream 四命令接流（开流→PCM 块上行
 *   →interim 实时上屏→finish→final 即刻喂 ask）；WS 失败/超时/终帧 error
 *   → 自动回落非流式链路（V3a 行为等价——失败静默降级，面板一处不显眼
 *   提示，不弹错误卡）；streamId 单飞门控（他流/旧流帧丢弃）；
 * - TTS 朗读层（V3b-2 流式优先 + 回退链，编排体 = steward-speech-out.ts）：
 *   steward.ask.delta 增量喂 SentenceBuffer 切句 → 逐句 voice.synthesize.stream
 *   （utterId 单调）→ chunk 帧入 SpeechPlayer 播放队列（Web Audio 无缝调度
 *   ——上一句播放中下一句已在合成）；流式失败（error 帧且零出声/首帧超时/
 *   发送失败/播放面不可用）→ answer 终态一次性 voice.synthesize 整段回退
 *   （V3a 现行为）→ 再失败只丢句不断对话；静音钮 stopSpeaking →
 *   voice.synthesize.stop + 播放队列清空 + 分句缓冲 reset；面板卸载（Dock
 *   关）即停。money 闸：语音模式 × 偏好开在 delta/result 两时点判。
 *   双声重叠修复批①②③④：出声面协调（speech-floor——对话 > 通知：c 通知面
 *   延后/收编，a×b 互斥 b 起播即停 a）；新轮清在途（resetAnswer 停在途句 +
 *   player 旧尾音）；回执轮次校验（迟到回执弃播）；stopSpeaking 全轨停止
 *   （含 c——弃播不续）。欢迎语固化音频不接协调（用户裁决：很短不值得接）。
 *
 * 语音链（V3b-1）：点击 mic（idle→listening；同步发 stt.stream.start）→
 * 边说边转写（interim 淡色浮字实时上屏）→ VAD 静音 ~1.8s/点击强制停 →
 * stt.stream.finish → final（实测 ~250-400ms）→ onTranscript 一次性喂 ask
 *（asking，流式回答）→ answer 终态 → 朗读（speaking）→ 播毕回 idle。
 * 开流失败/终帧超时/error → transcribeNow 回落（blob 上传整段转写，
 * V3a 同构——零静默丢话）。
 *
 * B2 barge-in（V3b-3 全双工核心）：语音模式全程 RMS 采样（耳 meter 常开
 * ——rms-meter 注入面从「仅录音期」扩展全程，text 模式/面板关即收）；
 * speaking/asking 相位人声门（B3 双参：RMS 分档超阈 + ZCR 人声带 + 持续
 * ≥ 最短发声时长 + 停播后静默窗 + fired 闩锁，判定全在 steward-voice-machine
 * 纯函数面；门参数逐帧读偏好——设置面改参即时生效）→ 打断序 = ①stopSpeaking
 * 立即停播（UX 零延迟）②steward.interrupt（daemon abortInFlight 幂等善后
 * ——E-198 截断记账零改动）③listening 开 stt.stream.start 新流；新转写
 * final → steward.ask 新轮。触发帧特征入误触埋点（barge-in-trace 环形缓冲
 * ——校准数据面）。asking 相位可打断（旧轮让位新输入）；text 模式/mic
 * 不可用行为完全不变。
 *
 * B4 唤醒链（全局组合键手动开麦；B2-hotfix 语义修订：热键直通双工）：
 * 全局组合键（壳 tauri-plugin-global-shortcut，wake-hotkey 注册面单点）
 * → **直通双工对话**（listening 开麦即听——热键是显式用户手势，身份已
 * 确认；唤醒词门槛属未来「被动监听唤起」场景，热键会话二次确认语义冗余
 * ——B2-hotfix 修复「说完话零回应 + 待命 30s 超时光球消失」）。唤醒词
 * 机制（待命/超时收场/词剥离/matchWakeWord）已随欢迎词工坊批拆除（热键
 * 直通后永不触发的死机制）；唤醒词偏好槽位改存欢迎词固化音频（工坊面
 * VoiceSettingsSection）。组合键再按 / Esc = 关麦收场（cancelWake——
 * duplex 落，在途 ask 轮不动）。
 *
 * 问题 8 欢迎语音频冷启动（输出通道预热 + 欢迎语错峰）：首次呼出的欢迎
 * 语首段顿挫 = 两个音频会话并发冷启动（new Audio 输出通道激活 ×
 * getUserMedia 输入会话建立抢设备）。修复双管：① 挂载即静音播零音量音频
 * 预热 WKWebView CoreAudio 输出会话（audio-output-warmup，模块级一次性，
 * 失败静默吞，不预热麦克风——隐私/权限语义）；② speakWelcome 移至
 * beginListening 完成后（toggleWake 内错峰——输入会话先建立，欢迎语后
 * 播；错峰窗口内快速关麦由 duplexRef 守卫零补播）。E-208 barge-in 门
 * 参数零改动（欢迎语本就不置 speaking 相位，仅挪播放起点）。
 *
 * B2 双工会话（全局语音批，设计稿 §3.2/§3.3）：挂载点从 StewardPanel 迁
 * 至 StewardVoiceLayer（光球层，app 壳级常驻）——open 参数（面板活跃）退
 * 役，采样/耳 meter 注入面改「双工会话活跃」（duplex 态内聚，语义同构平移
 * ——E-200 判据零改动）。组合键 → duplex=true + 欢迎语（固化音频优先，
 * 欢迎词工坊确认解零合成直播；球呈待机动画驻留——欢迎语是伴随声非回复）
 * → 待命/直通 listening → 终帧喂 ask → delta 字幕 + TTS → 播毕自动续听
 * （直到关麦）。关麦（组合键再按，D2 单键 toggle）= 停采集（track.stop
 * 即刻零转写，ed508171 同纪律）+ 停朗读（synthesize stop + 队列清空）+
 * duplex=false 光球淡出；**不动在途 ask 轮**（零 interrupt/abortInFlight，
 * 结果照常落历史，D6）。临时静音（D5）：listening 点击 toggleMute →
 * 续听挂起（停采集），再按恢复。口令拦截（D3=b）：终帧文本先过
 * onFinalText 钩子——返回 consumed 即前端本地消费（零 ask，语音口令面
 * voice-command.ts）。
 *
 * 异常回退（纯面 planTranscript）：ask 发送失败（未连接）→ 转写文本回填
 * voiceDraft（面板采纳进输入框——文本态可重试，零静默丢话）；转写失败 →
 * useVoiceInput error 面（面板 toast，Composer 同构）。
 *
 * 双模（mode）：面板双模 UI 已随 B2 面板语音退役——mode 恒 voice；mic 不可用
 * （unsupported）自动回退 text（朗读闸零合成防御保留）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useVoiceInput } from "@/shared/lib/useVoiceInput";
import { createWorkletRmsMeter, type RmsMeter, type RmsMeterFactory } from "@/shared/lib/rms-meter";import type { PcmPumpFactory } from "@/shared/lib/pcm-pump";
import { pcmFrameToBase64 } from "@/shared/lib/pcm-pump";
import { createPcmRing, type PcmRing } from "../voiceprint/model/pcm-ring";
import type { SpeechPlayerFactory } from "@/shared/lib/pcm-player";
import { readSttProviderPref } from "@/shared/lib/stt-provider-pref";
import {
  readTtsVoicePref,
  readVoiceVolumePref,
  readStewardSpeakReplyPref,
  readVoiceVadSensitivityPref,
  readVoiceMinDurationPref,
  readVoiceSilenceWindowPref,
  readVoiceCheckPref,
  readZcrTolerancePref,
  voiceRmsThresholdFromSensitivity,
  readWelcomeAudioPref,
  readWelcomeTextPref,
  readBargeInIntentPref,
} from "@/shared/lib/voice-pref";
import { isStopIntentPhrase } from "./voice-command";
import { setWakeHotkeyFireHandler, syncWakeHotkeyRegistration } from "@/shared/lib/wake-hotkey";
import { warmAudioOutputOnce } from "./audio-output-warmup";
import { beginSpeechLease, endSpeechLease, speechLeaseActive } from "@/shared/lib/speech-mutex";
import {
  beginDialogueSpeech,
  endDialogueSpeech,
  notificationSpeechActive,
  onNotificationPlaybackChange,
  setMicOccupied,
  stopNotificationSpeech,
} from "@/shared/lib/speech-floor";
import { recordBargeInTrace } from "@/shared/lib/barge-in-trace";
import {
  effectiveRmsThreshold,
  noiseFloorEstimate,
  VOICE_NOISE_CALIB_MIN_FRAMES,
  VOICE_NOISE_CALIB_WINDOW_MS,
} from "@/shared/lib/voice-gate";
import type { MeterFrame } from "@/shared/lib/rms-meter";
import type { EventEnvelope, StewardAskSource } from "@helix/protocol";
import { useSteward, type StewardAskActivity, type StewardPanelItem } from "./useSteward";
import { StewardSpeechOut } from "./steward-speech-out";
import {
  deriveStewardVoicePhase,
  shouldSpeakReply,
  mdToSpeechText,
  planTranscript,
  stepBargeInGate,
  openBargeInSilenceWindow,
  isBargeInArmed,
  INITIAL_BARGE_IN_GATE,
  type BargeInGateState,
  type StewardInputMode,
  type StewardVoicePhase,
} from "./steward-voice-machine";

/** 终帧等待上限（ms）：超时自动回落非流式（V3a 行为等价）。 */
export const STREAM_FINAL_TIMEOUT_MS = 4_000;

// ── ⑥ speech-mutex 租约源（播报-收音互斥：发言期登记，收音侧逐帧查互斥态
//    暂停 STT 上行——流保持开不重开不关，播报完自动恢复；多源幂等计数，
//    嵌套播报正确配对。本钩子内的发言源三个：speechOut 流式队列 / 一次性
//    回执 legacy Audio / 欢迎语固化音频；全局播报源在 useVoiceBroadcast。──
const SPEECH_LEASE_SPEECH_OUT = "steward-speech";
const SPEECH_LEASE_LEGACY = "steward-legacy-audio";
const SPEECH_LEASE_WELCOME = "steward-welcome-audio";

// ── barge-in 意图窗参数（意图门控打断批）──
/** duck 音量比例（播报不停但压低——降自声回灌 + 插话清晰）。 */
const BARGE_IN_INTENT_DUCK_SCALE = 0.2;
/** 窗超时（ms）：无 final 兕底关窗（噪音过门后用户实际没说话/ASR 无产出）。 */
const BARGE_IN_INTENT_WINDOW_MS = 5_000;
/** 排队插话上限（溢出丢新——防长播报期刷屏）。 */
const BARGE_IN_QUEUE_MAX = 3;
/** 语义停止判定超时（ms）：判官无响应/帧丢失 → 回退不停止（照排队）。 */
const JUDGE_STOP_TIMEOUT_MS = 2_500;

// ── ① speech-floor 对话源（出声面协调器：播×播互斥——对话 > 通知）：
//    回答轮在途（askInFlight）/ a 流式播放器在播 / b 一次性回执在播三源
//    任一在场 = 对话发言期——通知播报面（c）被压制（延后/收编，见
//    speech-floor）。源 id 与租约同串（两套计数客自独立，互不混）。──
const SPEECH_FLOOR_ROUND = "steward-answer-round";

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
   *  （Layer）走意图判定分支（停止词表→声纹→排队）而非常规口令/ask 链。 */
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
  /** 排队插话（非停止意图的真插话——播毕后自动提交为新轮 ask：宁多应答不漏）。
   *  上限 3 条溢出丢新。 */
  queueUtterance(text: string): void;
  /** 语义停止判定（意图窗慢通道：非词表停止表达「先别说了/等一下」类——
   *  daemon 判官 noul，回执 steward.judge_stop_intent.result）。超时/未连接/
   *  降级一律 false（照排队不真停）；单飞：新调作废旧调的迟到回执。 */
  judgeStopIntent(text: string): Promise<boolean>;
  /** 临时静音（D5：listening 点击切换——静音期续听挂起，duplex 会话保持）。 */
  readonly muted: boolean;
  /** D5 点击行为：listening 点击 = 临时静音切换（speaking 停读归 stopSpeaking）。 */
  toggleMute(): void;
  /** B2 光球唤起入口（wake-hotkey / steward-open-signal 接线共径——Layer 消费）。 */
  toggleWake(): void;
  /** B2 主动发言（欢迎语/口令回读同链；money 闸内判——偏好关零合成）。 */
  say(text: string): void;
  /** M3-c 声纹面：取本句音频（授权点专用——尾部语音段 Int16 域 PCM；
   *  null = 无语音可用。duplex 收口清环，跨会话旧音频不泄入）。 */
  lastUtterancePcm(): Float32Array | null;
}

export function useStewardVoice(options?: UseStewardVoiceOptions): UseStewardVoice {
  const {
    sendSttTranscribe,
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamFinish,
    sendSttStreamStop,
    subscribeSttFrames,
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
    subscribeVoiceFrames,
    subscribeStewardFrames,
    sendStewardInterrupt,
    sendStewardJudgeStopIntent,
  } = useSession() as {
    sendSttTranscribe?: (audio: string, opts?: { language?: string; provider?: string }) => boolean;
    sendSttStreamStart?: (opts?: { language?: string; provider?: string }) => boolean;
    sendSttStreamChunk?: (audio: string) => boolean;
    sendSttStreamFinish?: () => boolean;
    sendSttStreamStop?: () => boolean;
    subscribeSttFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    sendVoiceSynthesize?: (text: string, opts?: { voice?: string; language?: string }) => boolean;
    sendVoiceSynthesizeStream?: (utterId: string, text: string, opts?: { voice?: string }) => boolean;
    sendVoiceSynthesizeStop?: (utterId?: string) => boolean;
    subscribeVoiceFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    sendStewardInterrupt?: (reason?: string) => boolean;
    sendStewardJudgeStopIntent?: (text: string) => boolean;
  };
  const steward = useSteward(); // B1 订阅解绑：无参（订阅不随面板开合）

  // ── B2 双工会话态（open 参数退役——采样/耳面改 duplex 会话活跃驱动；
  //    duplexRef = 回调面镜像（listener 闭包读实时态），duplexActive = 光球
  //    可见性呈现面；两处同点写归 markDuplex（TR-173 禁渲染体裸写镜像 ref）──
  const [duplexActive, setDuplexActive] = useState(false);
  const duplexRef = useRef(false);
  // ── 底噪校准状态（语音判定钝感批）：duplex 开启后前 ~2.5s 耳帧采样窗估
  //    计环境底噪（P20 低百分位——欢迎语 TTS 回灌是偶发尖峰不拉高估计）；
  //    两门阈值抬升 max(偏好, 底噪×2.5)（effectiveThreshold 单点）。采样帧
  //    不足 → 不校准回落纯偏好值；校准值仅会话期有效（duplex 落清位重采）。──
  const duplexStartedAtRef = useRef(0);
  const calibSamplesRef = useRef<number[]>([]);
  const calibOpenRef = useRef(false);
  /** 底噪估计（null = 未校准/回落——两门用纯偏好值）。 */
  const noiseFloorRef = useRef<number | null>(null);
  const markDuplex = useCallback((v: boolean) => {
    duplexRef.current = v;
    setDuplexActive(v);
    if (v) {
      // 开启即开采样窗（重采）
      duplexStartedAtRef.current = Date.now();
      calibSamplesRef.current = [];
      calibOpenRef.current = true;
      noiseFloorRef.current = null;
    } else {
      // 落位清校准：下次双工重采（cancelWake/关麦后不携旧底噪）
      calibOpenRef.current = false;
      noiseFloorRef.current = null;
      calibSamplesRef.current = [];
    }
  }, []);
  /** 欢迎语期标记（duplex 开启置位；用户开口录音即压位——光球待机驻留，
   *   deriveOrbPhase welcome 入参消费）。 */
  const [welcomeActive, setWelcomeActive] = useState(false);
  /** 通知轨播报占用镜像（光球说话姿驱动——speech-floor 边沿订阅转响应式；
   *   与 barge-in 门武装面（onBargeInLevel 读 notificationSpeechActive）
   *   同信号源：通知语音不驱动 speaking 相位，光球由此镜像补说话姿）。 */
  const [notifSpeaking, setNotifSpeaking] = useState(false);
  useEffect(() => onNotificationPlaybackChange(setNotifSpeaking), []);
  /** B2 临时静音（D5）：静音期续听挂起（自动重听闸），duplex 会话保持。 */
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  /** 终帧拦截钩（D3=b 口令）：ref 转发实时读（onTranscript 闭包不随重渲染刷新）。 */
  const onFinalTextRef = useRef(options?.onFinalText);
  onFinalTextRef.current = options?.onFinalText;

  // ── 双模（打开默认语音模式——brief 口径；unsupported 自动回退文本态）──
  const [mode, setModeState] = useState<StewardInputMode>("voice");

  // ── TTS 朗读层（V3b-2 流式优先 + 回退链）──
  // 流式：delta 切句 → voice.synthesize.stream 逐句 → chunk 入 SpeechPlayer
  // 队列（句间无缝）；回退：流式失败 → 一次性 voice.synthesize → 面板 Audio
  // 播放（V3a 现行为）；再失败只丢句不断对话。
  const [legacySpeaking, setLegacySpeaking] = useState(false);
  const [streamSpeaking, setStreamSpeaking] = useState(false);
  const speaking = legacySpeaking || streamSpeaking;
  const speakPendingRef = useRef(false);
  // ── ③ 回执轮次校验（迟到回执弃播）：fallback 发出时记轮次 id，回执到达
  //    时轮次已变（新 ask 已开）→ 弃播（不 new Audio——旧轮音频不覆盖新轮）。
  //    轮次 id 随 resetAnswer（askInFlight 边沿）递增。──
  const speakRoundRef = useRef(0);
  const answerRoundRef = useRef(0);
  // ── B2 barge-in 触发面（V3b-3）：门状态 + 相位镜像 + 触发闭包转发 ──
  const bargeInGateRef = useRef<BargeInGateState>(INITIAL_BARGE_IN_GATE);
  const phaseRef = useRef<StewardVoicePhase>("idle");
  const bargeInRef = useRef<() => void>(() => {});
  /** executeBargeInStop ref 转发（stt 帧 effect 定义在前——interim 快通道调）。 */
  const executeBargeInStopRef = useRef<() => void>(() => {});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // ── barge-in 意图窗（意图门控打断批）：声学触发后不真停，开窗收插话判
  //    意图（停止词表快通道→声纹→排队）；窗内 duck 播报 + 豁免收音门控。──
  /** 窗开标记（同步读面——onPcmFrame 豁免/final 分流；state 面向 Layer）。 */
  const bargeInIntentRef = useRef(false);
  const [bargeInIntentActive, setBargeInIntentActive] = useState(false);
  // ── 语义停止判定（意图窗慢通道：非词表停止表达——daemon 判官 noul）──
  /** 单飞序列号（新调作废旧调迟到回执）+ 等待队列（回执/超时唤醒）。 */
  const judgeStopSeqRef = useRef(0);
  const judgeStopWaitersRef = useRef<((stop: boolean) => void)[]>([]);
  /** 窗超时计时器（无 final 兕底——噪音过门后用户实际没说话）。 */
  const bargeInWindowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** duck 前各轨原音量（恢复用——Audio 元素/播放器当前值，非偏好重算）。 */
  const duckedVolumesRef = useRef<{ player: number; legacy: number; welcome: number } | null>(null);
  /** 排队插话（非停止意图——播毕后自动提交新轮；上限 3 溢出丢新）。 */
  const queuedUtterancesRef = useRef<string[]>([]);

  // 发送面 ref 转发（speechOut 单例构造——发送器随连接态重绑，streamSenders 先例）
  const speechSendersRef = useRef({
    sendStream: sendVoiceSynthesizeStream,
    sendStopFor: (utterId: string) => sendVoiceSynthesizeStop?.(utterId) ?? false,
    sendStopAll: () => sendVoiceSynthesizeStop?.() ?? false,
    sendFallback: sendVoiceSynthesize,
  });
  speechSendersRef.current = {
    sendStream: sendVoiceSynthesizeStream,
    sendStopFor: (utterId: string) => sendVoiceSynthesizeStop?.(utterId) ?? false,
    sendStopAll: () => sendVoiceSynthesizeStop?.() ?? false,
    sendFallback: sendVoiceSynthesize,
  };
  const speechOutRef = useRef<StewardSpeechOut | null>(null);
  if (speechOutRef.current === null) {
    speechOutRef.current = new StewardSpeechOut({
      senders: {
        sendStream: (utterId, text, opts) => speechSendersRef.current.sendStream?.(utterId, text, opts) ?? false,
        sendStopFor: (utterId) => speechSendersRef.current.sendStopFor(utterId),
        sendStopAll: () => speechSendersRef.current.sendStopAll(),
        sendFallback: (text, opts) => speechSendersRef.current.sendFallback?.(text, opts) ?? false,
      },
      voiceProvider: () => readTtsVoicePref(),
      ...(options?.createPlayer !== undefined
        ? {
            createPlayer: () => {
              const player = options.createPlayer!();
              player.setVolume(Math.max(0, Math.min(1, readVoiceVolumePref() / 100)));
              return player;
            },
          }
        : {}),
    });
  }
  const speechOut = speechOutRef.current;
  useEffect(() => {
    // ⑥ 播放态边沿 = 租约边沿（首块入队播放 → 发言期；播尽/停 → 释放）
    // ① 同边沿接协调器：a 面在播 = 对话发言期（通知面被压制/收编）
    return speechOut.onSpeakingChange((active) => {
      if (active) {
        beginSpeechLease(SPEECH_LEASE_SPEECH_OUT);
        beginDialogueSpeech(SPEECH_LEASE_SPEECH_OUT);
      } else {
        endSpeechLease(SPEECH_LEASE_SPEECH_OUT);
        endDialogueSpeech(SPEECH_LEASE_SPEECH_OUT);
      }
      setStreamSpeaking(active);
    });
  }, [speechOut]);

  /** 一次性回执播放态（legacy Audio）：状态 + 租约 + ① 协调器同点写
   * （播放即持、播毕释放；b 面在播 = 对话发言期）。 */
  const markLegacySpeaking = useCallback((active: boolean) => {
    if (active) {
      beginSpeechLease(SPEECH_LEASE_LEGACY);
      beginDialogueSpeech(SPEECH_LEASE_LEGACY);
    } else {
      endSpeechLease(SPEECH_LEASE_LEGACY);
      endDialogueSpeech(SPEECH_LEASE_LEGACY);
    }
    setLegacySpeaking(active);
  }, []);

  // ── barge-in 意图窗：duck/恢复（意图门控打断批）──
  // duck 目的：播报不停但压低——降低 TTS 自声回灌（豁免门控后插话帧与自声
  // 同流上行，ASR 抗混音能力有限）+ 用户插话更清晰。恢复写回 duck 前原值
  //（非偏好重算——中途改偏好不突跳）。欢迎语/通知轨互斥关系下通常不同时
  // 在播，逐轨各自 duck 各自恢复，未在播轨记原值不动。
  const duckVolume = useCallback(
    (scale: number) => {
      if (duckedVolumesRef.current !== null) return; // 已 duck 幂等
      const legacy = audioRef.current?.volume ?? 1;
      const welcome = welcomeAudioRef.current?.volume ?? 1;
      duckedVolumesRef.current = { player: 1, legacy, welcome };
      speechOut.setVolume(scale); // player 原值不可读——恢复面恒 1（真体从未设过）
      if (audioRef.current !== null) audioRef.current.volume = legacy * scale;
      if (welcomeAudioRef.current !== null) welcomeAudioRef.current.volume = welcome * scale;
    },
    [speechOut],
  );
  const restoreVolume = useCallback(() => {
    const v = duckedVolumesRef.current;
    if (v === null) return; // 未 duck 幂等
    duckedVolumesRef.current = null;
    speechOut.setVolume(v.player);
    if (audioRef.current !== null) audioRef.current.volume = v.legacy;
    if (welcomeAudioRef.current !== null) welcomeAudioRef.current.volume = v.welcome;
  }, [speechOut]);
  /** 窗收位直接操作（stopSpeaking/duplex 收口内联用——不引闭包环）：清标记
   *  + 恢复音量 + 清超时计时器；录音链不动（自动续听照常）。 */
  const settleBargeInWindow = useCallback(() => {
    if (bargeInWindowTimerRef.current !== null) {
      clearTimeout(bargeInWindowTimerRef.current);
      bargeInWindowTimerRef.current = null;
    }
    if (!bargeInIntentRef.current) return;
    bargeInIntentRef.current = false;
    setBargeInIntentActive(false);
    restoreVolume();
  }, [restoreVolume]);

  const stopSpeaking = useCallback(() => {
    // 停播即开残响静默窗（B2：防 TTS 残响被耳 meter 再触发——静音钮/打断同径；
    // B3：窗长取偏好值，设置面改参即时生效）
    bargeInGateRef.current = openBargeInSilenceWindow(bargeInGateRef.current, Date.now(), readVoiceSilenceWindowPref());
    settleBargeInWindow(); // 意图窗随停播收位（手动停读/新轮清在途同径——播都停了判定窗无义）
    speakPendingRef.current = false;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio !== null) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    setLegacySpeaking(false);
    setStreamSpeaking(false); // 静音即停——不依赖播放器回调时序（fake/真体一致）
    // ④ 全轨停止：c 通知面先清（弃播不续）——先于对话面收位，防收编边沿
    //（末源退出 → resume）在队列清空前误放行延后通知
    stopNotificationSpeech();
    // ⑥ 租约同点收位（幂等；不依赖播放器回调时序——同上假/真体一致）
    endSpeechLease(SPEECH_LEASE_SPEECH_OUT);
    endSpeechLease(SPEECH_LEASE_LEGACY);
    // ① 协调器同点收位（幂等——a/b 对话面离场；末源退出 resume 时队列已空
    // → no-op，零误放行）
    endDialogueSpeech(SPEECH_LEASE_SPEECH_OUT);
    endDialogueSpeech(SPEECH_LEASE_LEGACY);
    speechOut.stopSpeaking(); // stop 命令 + 队列清空 + 分句缓冲 reset + 本轮静音
  }, [speechOut, settleBargeInWindow]);

  // ── B2 欢迎语（进入双工时 TTS；字幕同步归 Layer）：speechOut 主动发言
  //    入口 sayNow（切句发流——闸/播放队列全复用，TR-200 播放闸零改动）；
  //    money 闸同构（偏好关零合成，字幕照显）。──
  const { t } = useI18n();
  const say = useCallback(
    (text: string) => {
      if (
        !shouldSpeakReply({ mode: "voice", speakEnabled: readStewardSpeakReplyPref(), askResult: { status: "answer" } })
      ) {
        return;
      }
      speechOut.sayNow(text);
    },
    [speechOut],
  );
  const welcomeTextRef = useRef(options?.welcomeText);
  welcomeTextRef.current = options?.welcomeText;
  // ── 欢迎语固化音频（欢迎词工坊批）：呼出优先播固化解（设置页生成试听
  //    确认的 TTS 回执原样存——零合成延迟、音色即试听即所得）；未固化
  //    回退 TTS 现合成（首次使用/清存储）。固化路径不置 speaking（球保持
  //    待机动画——欢迎语是伴随声非回复）且不占 speechOut 队列。──
  const welcomeAudioRef = useRef<HTMLAudioElement | null>(null);
  const stopWelcomeAudio = useCallback(() => {
    const audio = welcomeAudioRef.current;
    if (audio === null) return;
    welcomeAudioRef.current = null;
    audio.onended = null;
    audio.pause();
    endSpeechLease(SPEECH_LEASE_WELCOME); // ⑥ 欢迎语发言期同占租约（提前停即释放）
    endDialogueSpeech(SPEECH_LEASE_WELCOME); // ① 协调面同点收位（欢迎语 = 管家在跟你说话 → 压通知）
  }, []);
  const speakWelcome = useCallback(() => {
    const cached = readWelcomeAudioPref();
    if (cached !== null) {
      try {
        const audio = new Audio(cached);
        audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
        welcomeAudioRef.current = audio;
        beginSpeechLease(SPEECH_LEASE_WELCOME); // ⑥ 发言期登记（播毕/失败释放）
        beginDialogueSpeech(SPEECH_LEASE_WELCOME); // ① 欢迎语对话源：起播压/停通知（欢迎语×通知重叠修复）
        audio.onended = () => {
          if (welcomeAudioRef.current === audio) welcomeAudioRef.current = null;
          endSpeechLease(SPEECH_LEASE_WELCOME);
          endDialogueSpeech(SPEECH_LEASE_WELCOME);
        };
        void audio.play().catch(() => {
          if (welcomeAudioRef.current === audio) welcomeAudioRef.current = null;
          endSpeechLease(SPEECH_LEASE_WELCOME);
          endDialogueSpeech(SPEECH_LEASE_WELCOME);
        });
        return;
      } catch {
        // 固化解损坏/不可播 → 回退 TTS 现合成
      }
    }
    say(readWelcomeTextPref() ?? welcomeTextRef.current ?? t("steward.voice.welcome"));
  }, [say, t]);

  // 面板卸载（Dock 关/路由外弹层退场）即停读——不留幽灵音频/孤儿在途句。
  // StrictMode 双效应兼容：cleanup 先跑 close() 毒死 useRef 实例，重挂 setup
  // 必须显式 reopen()（否则 disposed 永真 → 朗读全链静默）。
  useEffect(
    () => {
      speechOut.reopen();
      return () => {
        speakPendingRef.current = false;
        const audio = audioRef.current;
        audioRef.current = null;
        if (audio !== null) {
          audio.onended = null;
          audio.onerror = null;
          audio.pause();
        }
        speechOut.close();
        // ⑥ 租约收位（卸载不留幽灵租约——否则后续收音永久暂停）
        endSpeechLease(SPEECH_LEASE_SPEECH_OUT);
        endSpeechLease(SPEECH_LEASE_LEGACY);
        // ① 协调器同点收位（卸载不留幽灵对话位——否则通知面永久延后）
        endDialogueSpeech(SPEECH_LEASE_SPEECH_OUT);
        endDialogueSpeech(SPEECH_LEASE_LEGACY);
        stopWelcomeAudio();
      };
    },
    [speechOut, stopWelcomeAudio],
  );

  // 回答终态 → 朗读闸（money 纪律：语音模式 × 偏好开；answer 判别在
  // speechOut 内收口）。流式优先：delta 已切句发流的轮次不再重复一次性。
  // 模式按 result 时点读（ref 免 listener 重绑）。
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // ── B2 barge-in 门帧消费（耳 meter 回调；armed = 相位派生）──
  // B3：门参数逐帧读偏好（最短发声/静默窗/双参判定/容忍带）+ 门限分档
  //（phase 抬档防 TTS 自声回灌）——设置面改偏好，下一次门判定即用新值
  //（不必重开麦）；触发帧特征入误触埋点环形缓冲（校准数据面）。
  // 底噪校准（语音判定钝感批）：阈值经 effectiveThreshold 单点——与聆听
  // 收口门（useVoiceInput getRmsThreshold 注入）同源，两门一起钝/灵。
  const effectiveThreshold = useCallback(
    () => effectiveRmsThreshold(voiceRmsThresholdFromSensitivity(readVoiceVadSensitivityPref()), noiseFloorRef.current),
    [],
  );
  const onBargeInLevel = useCallback(
    (frame: MeterFrame) => {
      // 门武装面扩展（打断不灵敏修复）：通知播报（c 面）不驱动 speaking 相位
      //（相位只由对话轨 a/b 派生）——无此扩展时通知播报期相位 idle → 门天。
      // 通知占用在场时等价 speaking 语义：门开 + 阈值 ×2 抬档（自声回灌防
      // 线同对话轨——通知语音同样从扬声器出）。
      const notifSpeaking = notificationSpeechActive();
      const gatePhase = notifSpeaking && phaseRef.current === "idle" ? "speaking" : phaseRef.current;
      const armed =
        isBargeInArmed({ mode: modeRef.current, phase: phaseRef.current }) ||
        (modeRef.current === "voice" && notifSpeaking);
      const atMs = Date.now();
      const out = stepBargeInGate(bargeInGateRef.current, {
        rms: frame.rms,
        zcr: frame.zcr,
        atMs,
        armed,
        phase: gatePhase,
        threshold: effectiveThreshold(),
        minDurationMs: readVoiceMinDurationPref(),
        silenceWindowMs: readVoiceSilenceWindowPref(),
        voiceCheck: readVoiceCheckPref(),
        zcrTolerance: readZcrTolerancePref(),
      });
      bargeInGateRef.current = out.state;
      if (out.trigger) {
        recordBargeInTrace({ at: atMs, rms: frame.rms, zcr: frame.zcr, phase: gatePhase, fired: true });
        bargeInRef.current();
      } else if (out.missed !== null) {
        // ⑦ 双态打点：未触发候选段收口（段内峰值帧特征——档位压制/未达持续
        // 的「说话但打不断」样本，与触发帧同一环形缓冲；phase 取段归属相位）
        recordBargeInTrace({
          at: out.missed.peakAtMs,
          rms: out.missed.peakRms,
          zcr: out.missed.peakZcr,
          phase: out.missed.peakPhase,
          fired: false,
        });
      }
    },
    [effectiveThreshold],
  );

  // 耳帧消费（校准采样前置 + barge-in 门）：采样窗内先收帧入样本集；首帧
  // 落在窗外即定稿（≥10 帧取 P20，不足回落 null 纯偏好）——校准完成前两门
  // 用纯偏好值（不因校准挂起判定）。P4 近似（E-221，本批接受现状）：耳侧
  // 底噪估计作用于录音门（双 meter 双路径）——两门同源的是阈值单点，不是
  // 采集路径；meter 合一不在本批。
  const onEarFrame = useCallback(
    (frame: MeterFrame) => {
      if (calibOpenRef.current) {
        if (Date.now() - duplexStartedAtRef.current >= VOICE_NOISE_CALIB_WINDOW_MS) {
          calibOpenRef.current = false; // 采样窗关闭：定稿
          noiseFloorRef.current =
            calibSamplesRef.current.length >= VOICE_NOISE_CALIB_MIN_FRAMES
              ? noiseFloorEstimate(calibSamplesRef.current)
              : null; // 采样不足 → 回落纯偏好
        } else if (!speechLeaseActive()) {
          // 发言租约期帧不入样本（校准污染修复）：欢迎语错峰后恰盖采样窗
          // 大半，TTS 回灌帧混入会把 P20 底噪抬到焊死位（打不断的候选 B 根
          // 因）。租约期跳过采样，样本不足 → 回落纯偏好（宁可不校准，不校
          // 出毒阈值）。
          calibSamplesRef.current.push(frame.rms);
        }
      }
      onBargeInLevel(frame);
    },
    [onBargeInLevel],
  );

  // ── B2 barge-in 耳朵：双工会话期 RMS 采样（duplex 活跃 × 语音模式；
  //    meter 注入面从「面板活跃」平移「双工会话活跃」——语义同构，判据
  //    零改动 E-200；duplex 落即刻 track.stop。mic 不可用/被拒 → barge-in
  //    降级关闭，语音主链不受影响）──
  const earMeterFactoryRef = useRef(options?.createMeter ?? createWorkletRmsMeter);
  earMeterFactoryRef.current = options?.createMeter ?? createWorkletRmsMeter;
  useEffect(() => {
    if (!duplexActive || mode !== "voice") return;
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) return;
    let cancelled = false;
    let meter: RmsMeter | null = null;
    let stream: MediaStream | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const created = await earMeterFactoryRef.current(stream);
        if (created === null || cancelled) {
          created?.close();
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        meter = created;
        created.onLevel((frame) => {
          if (cancelled) return;
          onEarFrame(frame);
        });
      } catch {
        // 麦不可用/被拒：barge-in 降级关闭（环境面——语音主链不受影响）
      }
    })();
    return () => {
      cancelled = true;
      meter?.close();
      if (stream !== null) for (const track of stream.getTracks()) track.stop();
    };
  }, [duplexActive, mode, onEarFrame]);
  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type === "steward.ask.delta") {
        // 流式朗读闸（money 纪律）：语音模式 × 偏好开才喂（文本模式零合成）
        const p = event.payload as { delta?: unknown };
        if (modeRef.current !== "voice" || !readStewardSpeakReplyPref()) return;
        if (typeof p.delta !== "string" || p.delta === "") return;
        speechOut.feedRawDelta(p.delta);
        return;
      }
      if (event.type === "steward.judge_stop_intent.result") {
        // 意图窗慢通道回执：单飞守卫（旧调迟到作废）+ 等待队列整体唤醒
        const p = event.payload as { stop?: unknown };
        const waiters = judgeStopWaitersRef.current;
        if (waiters.length === 0) return; // 窗收位后迟到回执（幂等吞）
        judgeStopWaitersRef.current = [];
        for (const w of waiters) w(p.stop === true);
        return;
      }
      if (event.type !== "steward.ask.result") return;
      const payload = event.payload as { status?: unknown; text?: unknown };
      const status = String(payload.status ?? "");
      // 闸不过（非语音模式/偏好关/非 answer 不合成——confirm/error 零朗读）
      // 时：语音模式下非 answer 终态仍收口轮次（废弃在途未读句缓冲）
      if (!shouldSpeakReply({ mode: modeRef.current, speakEnabled: readStewardSpeakReplyPref(), askResult: { status } })) {
        if (modeRef.current === "voice" && readStewardSpeakReplyPref()) {
          speechOut.answerResult(status, typeof payload.text === "string" ? payload.text : "");
        }
        return;
      }
      const verdict = speechOut.answerResult(status, typeof payload.text === "string" ? payload.text : "");
      if (verdict === "fallback") {
        speakPendingRef.current = true; // 一次性回执单飞门控位
        speakRoundRef.current = answerRoundRef.current; // ③ 记轮次 id（迟到回执弃播判据）
      }
    });
  }, [subscribeStewardFrames, speechOut]);

  // ask 在途 → 新一轮朗读开轮（迟到 delta 归零——句不跨轮泄漏）
  const askInFlight = steward.askInFlight;
  useEffect(() => {
    if (!askInFlight) return;
    // ① 对话发言期开轮（先占面再清在途——防清理边沿瞬时放行通知面）
    beginDialogueSpeech(SPEECH_FLOOR_ROUND);
    answerRoundRef.current += 1; // ③ 轮次 id 递增（旧轮回执自此判为迟到）
    speechOut.resetAnswer(); // ② 新轮清在途（在途句定向 stop + player 旧尾音停 + 闸复位）
    return () => endDialogueSpeech(SPEECH_FLOOR_ROUND); // 收口（含卸载）——a/b 在播仍持面
  }, [askInFlight, speechOut]);

  // 一次性回退回执 → 播放（单飞门控：仅本面 pending 消费——设置页试听回执
  // 不串台；useVoiceBroadcast 顺序播放是全局订阅面，与本点对点面互不相干）
  useEffect(() => {
    if (subscribeVoiceFrames === undefined) return;
    return subscribeVoiceFrames((event: EventEnvelope) => {
      if (event.type === "voice.synthesize.chunk") {
        const p = event.payload as { utterId?: unknown; audio?: unknown; seq?: unknown };
        if (typeof p.utterId === "string" && typeof p.audio === "string")
          speechOut.onChunkFrame(p.utterId, p.audio, typeof p.seq === "number" ? p.seq : undefined);
        return;
      }
      if (event.type === "voice.synthesize.done") {
        const p = event.payload as { utterId?: unknown };
        if (typeof p.utterId === "string") speechOut.onDoneFrame(p.utterId);
        return;
      }
      if (event.type === "voice.synthesize.error") {
        const p = event.payload as { utterId?: unknown };
        if (typeof p.utterId === "string") speechOut.onErrorFrame(p.utterId);
        return;
      }
      if (event.type !== "voice.synthesize.result") return;
      if (!speakPendingRef.current) return;
      speakPendingRef.current = false;
      // ③ 迟到回执弃播：fallback 发出后新 ask 已开轮（轮次 id 已变）→ 旧轮
      // 音频不覆盖新轮——零 new Audio（内容在活动流/toast 可查）
      if (speakRoundRef.current !== answerRoundRef.current) return;
      const payload = event.payload as { status?: unknown; audio?: unknown };
      if (payload.status !== "ok" || typeof payload.audio !== "string") {
        markLegacySpeaking(false);
        return;
      }
      try {
        markLegacySpeaking(true); // ⑥ 回执发言期登记租约 + ① b 面起播占对话面
        // ① a×b 互斥：b 起播即停 a——旧流式尾音/在途句不与回执同时出声
        //（money：在途句逐条定向 stop）
        speechOut.stopInFlightPlayback();
        const audio = new Audio(payload.audio);
        audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
        audioRef.current = audio;
        markLegacySpeaking(true); // ⑥ 回执发言期登记租约
        audio.onended = () => {
          audioRef.current = null;
          markLegacySpeaking(false);
        };
        audio.onerror = () => {
          audioRef.current = null;
          markLegacySpeaking(false);
        };
        void audio.play().catch(() => {
          // 自动播放策略拒绝等：跳过（不重试不打扰——面板交互态在场，
          // 下轮用户点击后天然解锁）
          audioRef.current = null;
          markLegacySpeaking(false);
        });
      } catch {
        markLegacySpeaking(false);
      }
    });
  }, [subscribeVoiceFrames, speechOut, markLegacySpeaking]);

  // ── 录音 + 转写 → ask（转写文本一次性喂 ask；失败回填草稿可重试）──
  const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
  // ── 流式面（V3b-1）：interim 上屏 + 终帧收口 + 回落链 ──
  const [interim, setInterim] = useState<string | null>(null);
  const [streamDegraded, setStreamDegraded] = useState(false);
  /** start 已发（等 started 回执；期间 chunk 照发——daemon 缓冲）。 */
  const streamArmedRef = useRef(false);
  /** started.ok 的 streamId（单飞门控判别位；null = 未就绪）。 */
  const streamIdRef = useRef<string | null>(null);
  /** 流已死（started.error/终帧 error/超时）——本轮不再上行/等帧。 */
  const streamDeadRef = useRef(false);
  /** finish 已发，等终帧（超时回落计时器在飞）。 */
  const finalPendingRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamSenders = { sendSttStreamStart, sendSttStreamChunk, sendSttStreamFinish, sendSttStreamStop };
  const streamSendersRef = useRef(streamSenders);
  streamSendersRef.current = streamSenders;

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  // ── M3-c 声纹面：授权点音频环（PCM 帧无条件入环——STT 上行门与环互不
  //    干涉；duplex 收口清环防跨会话泄入）。──
  const pcmRingRef = useRef<PcmRing | null>(null);
  if (pcmRingRef.current === null) pcmRingRef.current = createPcmRing();

  // PCM 帧 → 声纹环（无条件）+ stt.stream.chunk（仅 armed 且未死；他态零上行——money 纪律）
  // ⑥ 互斥门：播报发言期（任一租约在场）本地暂停上行——流保持开（不重开
  // 不关流），播报完自动恢复；TTS 自声回灌不再污染转写（「回执冲掉说话」根修）。
  const onPcmFrame = useCallback((frame: ArrayBuffer) => {
    pcmRingRef.current?.push(frame);
    if (!streamArmedRef.current || streamDeadRef.current) return;
    // 发言期暂停上行（意图窗豁免：插话帧与自声同流上行——duck 压低回灌，
    // 窗关回门控）。
    if (speechLeaseActive() && !bargeInIntentRef.current) return;
    const send = streamSendersRef.current.sendSttStreamChunk;
    if (typeof send !== "function") return;
    send(pcmFrameToBase64(frame));
  }, []);

  // blob 就位（deferred 态）→ 流在途？finish 等终帧 : 立即回落非流式
  const finalTimeoutMsRef = useRef(options?.streamFinalTimeoutMs ?? STREAM_FINAL_TIMEOUT_MS);
  finalTimeoutMsRef.current = options?.streamFinalTimeoutMs ?? STREAM_FINAL_TIMEOUT_MS;
  const onDeferredHold = useCallback(() => {
    const senders = streamSendersRef.current;
    if (streamArmedRef.current && !streamDeadRef.current && streamIdRef.current !== null && typeof senders.sendSttStreamFinish === "function") {
      finalPendingRef.current = true;
      senders.sendSttStreamFinish();
      clearFallbackTimer();
      fallbackTimerRef.current = setTimeout(() => {
        // 终帧超时 → 回落非流式（V3a 行为等价）；timer 回调读不到最新
        // voiceRef——经 ref 转发（下方 voiceRef 声明前置提升）
        finalPendingRef.current = false;
        streamDeadRef.current = true;
        setStreamDegraded(true);
        voiceRef.current.transcribeNow();
      }, finalTimeoutMsRef.current);
    } else {
      voiceRef.current.transcribeNow();
    }
  }, [clearFallbackTimer]);

  const askRef = useRef(steward.ask);
  askRef.current = steward.ask;

  // 声纹总闸派发口（ref 转发——handleTranscript 闭包读稳定口）：发问 +
  // planTranscript 回退（零静默丢话）；source 按双工态归类（addressee 判定）。
  const submitUtterance = useCallback((utterance: string) => {
    const source = duplexRef.current ? "voice-duplex" : "voice-manual";
    const sent = askRef.current(utterance, source);
    const plan = planTranscript(utterance, sent);
    if (plan.kind === "fallback") setVoiceDraft(plan.draft);
  }, []);
  const submitUtteranceRef = useRef(submitUtterance);
  submitUtteranceRef.current = submitUtterance;

  // 双工会话收口（B2：组合键再按（D2 单键 toggle 关麦）/ Esc 共径）：关麦
  //（track.stop 即刻零转写，ed508171 同纪律）+ 废流（stt.stream.stop）+ 停朗
  // 读（synthesize stop + 队列清空）+ 停欢迎语固化音频 + duplex 落（光球淡
  // 出数据面）+ 静音/欢迎语位复位。**不动在途 ask 轮**（零 interrupt/
  // abortInFlight——结果照常落历史，D6）。流 refs 收位防孤儿 timer/上行
  //（money 纪律）。
  const cancelWake = useCallback(() => {
    clearFallbackTimer();
    pcmRingRef.current?.clear(); // 声纹环清位（跨会话旧音频不泄入新会话第一句）
    finalPendingRef.current = false;
    streamIdRef.current = null;
    if (streamArmedRef.current && !streamDeadRef.current) {
      streamSendersRef.current.sendSttStreamStop?.();
    }
    streamArmedRef.current = false;
    streamDeadRef.current = true;
    setInterim(null);
    voiceRef.current.cancel();
    if (duplexRef.current) {
      stopSpeaking(); // D6 停朗读（队列清空 + 残响静默窗）
      stopWelcomeAudio();
      markDuplex(false);
      setWelcomeActive(false);
      mutedRef.current = false;
      setMuted(false);
    }
  }, [clearFallbackTimer, stopSpeaking, stopWelcomeAudio, markDuplex]);

  const handleTranscript = useCallback(
    (text: string) => {
      // 转写消费门（幽灵 ask/TTS 防线）：duplex 双工活跃、唤醒会话（B4）、
      // 或录音/转写在途相位（V3a 手动单轮）任一成立才消费；否则零 ask 零朗
      // 读（4282f4ca 同根族：与 useVoiceInput 迟归代数守卫分层，状态面漏网时
      // 行为面兕底——关掉的管家不开口）。拦截面含关麦后残影 asking/speaking
      //（旧 ask 轮在途/在朗读——D6 不 abort，但迟到转写不得借道开新轮）。
      if (
        !duplexRef.current &&
        phaseRef.current !== "listening" &&
        phaseRef.current !== "transcribing"
      )
        return;
      // 欢迎期收位：用户第一句定稿（VAD 静音丢弃轮不至此）——停欢迎语固化
      // 音频（开场白让位对话；录制期间相位已压过欢迎位，此处收 state 兼兜底）
      setWelcomeActive(false);
      stopWelcomeAudio();
      /** 即将 ask 的文本路由：口令拦截（D3=b）优先——consumed 零 ask；
       *  意图窗内 final 传 ctx（Layer 判定分支：停止词表→声纹→排队）。 */
      const routeToAsk = (utterance: string) => {
        if (onFinalTextRef.current?.(utterance, { bargeInIntent: bargeInIntentRef.current }) === "consumed") return;
        submitUtteranceRef.current(utterance);
      };
      routeToAsk(text);
    },
    [stopWelcomeAudio],
  );
  const voice = useVoiceInput(handleTranscript, {
    sendSttTranscribe,
    subscribeSttFrames,
    onPcmFrame,
    deferredTranscribe: true,
    onDeferredHold,
    // 收口门共基（语音判定钝感批）：阈值注入底噪校准单点——与 barge-in 门
    // 同源（max(偏好, 底噪×2.5)）；缺省（无注入）时 useVoiceInput 自读偏好
    getRmsThreshold: effectiveThreshold,
    ...(options?.createMeter !== undefined ? { createMeter: options.createMeter } : {}),
    ...(options?.createPump !== undefined ? { createPump: options.createPump } : {}),
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // 麦克占用镜像（重叠修复）：收音/转写期 → speech-floor 麦克占用——通知
  // 播报延后不叠用户说话；占用释放（说完）边沿触发延后队列串行放行。卸载
  // 同步复位（不留占用残位阻断后续通知）。
  useEffect(() => {
    setMicOccupied(voice.state === "recording" || voice.state === "transcribing");
  }, [voice.state]);
  useEffect(() => () => setMicOccupied(false), []);

  // 流式帧消费（与 useVoiceInput 回执面双订阅扇出——LISTEN_SURFACE 官方
  // 形态；streamId 单飞门控：他流/旧流帧丢弃，非 pending 终帧丢弃）
  useEffect(() => {
    if (subscribeSttFrames === undefined) return;
    return subscribeSttFrames((event: EventEnvelope) => {
      if (event.type === "stt.stream.started") {
        if (!streamArmedRef.current) return; // 非本轮（他面/迟到）不消费
        const p = event.payload as { status?: unknown; streamId?: unknown; reason?: unknown };
        if (p.status === "ok" && typeof p.streamId === "string") {
          streamIdRef.current = p.streamId;
        } else {
          // 开流失败：静默降级（录音照常，停后 blob 回落非流式）
          streamDeadRef.current = true;
          setStreamDegraded(true);
        }
      } else if (event.type === "stt.stream.interim") {
        const p = event.payload as { streamId?: unknown; prior?: unknown; text?: unknown; stash?: unknown };
        if (p.streamId !== streamIdRef.current) return; // 单飞门控
        const prior = typeof p.prior === "string" ? p.prior : "";
        const text = typeof p.text === "string" ? p.text : "";
        const stash = typeof p.stash === "string" ? p.stash : "";
        const accumulated = `${prior}${text}${stash}`;
        setInterim(accumulated);
        // 意图窗快通道（interim 级）：强停止词全等命中即真停——不等 VAD 收口
        // 与 final（真停延迟从 ~2.5-4s 压到 ~1s 内）；录音继续（用户后续语音
        // 同轮收口自然衔接）。误停代价可按受（ASR 修正期「停」误现——打断本
        // 低频且用户确在插话，损失远小于延迟）。
        if (bargeInIntentRef.current && isStopIntentPhrase(accumulated)) {
          recordBargeInTrace({ at: Date.now(), rms: 0, zcr: 0, phase: phaseRef.current, fired: true });
          executeBargeInStopRef.current();
        }
      } else if (event.type === "stt.stream.final") {
        const p = event.payload as { status?: unknown; streamId?: unknown; text?: unknown };
        if (p.streamId !== streamIdRef.current) return; // 单飞门控
        if (!finalPendingRef.current) return; // 未在等终帧（已废弃/未 finish）→ 丢弃
        clearFallbackTimer();
        finalPendingRef.current = false;
        streamIdRef.current = null;
        if (p.status === "ok") {
          const text = typeof p.text === "string" ? p.text : "";
          if (text.trim() !== "") setInterim(text); // final 替换 interim（转正前闪现）
          voiceRef.current.resolveStreaming(text);
        } else {
          // 流失败 → 回落非流式（blob 整段转写，V3a 行为等价）
          streamDeadRef.current = true;
          setStreamDegraded(true);
          voiceRef.current.transcribeNow();
        }
      }
    });
  }, [subscribeSttFrames, clearFallbackTimer]);

  // 听音本体（手动点击与 barge-in 共用）：流式复位 + 开流（同步发——失败
  // 静默降级）+ 录音启动；不带停播序（调用方按打断序安排）
  const beginListening = useCallback(async () => {
    clearFallbackTimer();
    setInterim(null);
    setStreamDegraded(false);
    streamIdRef.current = null;
    streamDeadRef.current = false;
    finalPendingRef.current = false;
    // 开流门（money 纪律）：仅语音模式 listening 态开——点击开始才建 WS；
    // provider 偏好非 dashscope（无流式能力）不开流零连接
    const pref = readSttProviderPref();
    const sendStart = streamSendersRef.current.sendSttStreamStart;
    streamArmedRef.current =
      typeof sendStart === "function" && (pref === undefined || pref === "dashscope") && sendStart({ language: "zh" });
    await voiceRef.current.start();
  }, [clearFallbackTimer]);

  // B2 barge-in 打断序（①②③不可换序——UX 与一致性分离）：①立即停播
  // （零延迟）②steward.interrupt（daemon abortInFlight 幂等善后）③进
  // listening 开 stt.stream.start 新流；新转写 final → steward.ask 新轮。
  // 意图门控批：偏好开（默认）→ 开意图窗（不真停：duck + 收插话判意图——
  // 停止意图才走三步序）；偏好关 → 回退声学直停（原行为零改动）。
  const openBargeInIntentWindow = useCallback(() => {
    if (bargeInIntentRef.current) return; // 窗已开幂等（fired 闩锁外再防线）
    bargeInIntentRef.current = true;
    setBargeInIntentActive(true);
    duckVolume(BARGE_IN_INTENT_DUCK_SCALE);
    void beginListening(); // 开麦+开新转写流（收插话）——不 stopSpeaking 不 interrupt
    if (bargeInWindowTimerRef.current !== null) clearTimeout(bargeInWindowTimerRef.current);
    bargeInWindowTimerRef.current = setTimeout(() => {
      bargeInWindowTimerRef.current = null;
      // 窗超时兕底：无 final（噪音过门后用户实际没说话/麦克失败/ASR 无产出）
      // ——不真停不排队，恢复音量关窗回门控（自动续听照常）。
      settleBargeInWindow();
    }, BARGE_IN_INTENT_WINDOW_MS);
  }, [duckVolume, beginListening, settleBargeInWindow]);

  /** 真停（停止意图确认——Layer 意图判定后调）：三步序①停播全轨②interrupt；
   *  ③收音不显式开——interim 快通路径录音本就在跑（后续语音同轮收口），
   *  final 慢通路径靠自动续听（idle 边沿）重开。 */
  const executeBargeInStop = useCallback(() => {
    settleBargeInWindow(); // 窗先收（恢复音量——stopSpeaking 面再收幂等）
    stopSpeaking(); // ①（含残响静默窗 + 全轨停止）
    sendStewardInterrupt?.("barge-in"); // ②（幂等；未连接本地停播即事实）
  }, [settleBargeInWindow, stopSpeaking, sendStewardInterrupt]);
  executeBargeInStopRef.current = executeBargeInStop;

  /** 窗收口不真停（噪音/旁人/非停止插话——Layer 判定后调）。 */
  const closeBargeInIntentWindow = useCallback(() => {
    settleBargeInWindow();
  }, [settleBargeInWindow]);

  /** 排队插话（非停止意图的真插话：播毕后自动提交新轮——宁多应答不漏）。 */
  const queueUtterance = useCallback((text: string) => {
    const q = queuedUtterancesRef.current;
    if (text.trim() === "" || q.length >= BARGE_IN_QUEUE_MAX) return; // 上限溢出丢新
    q.push(text);
  }, []);

  /** 语义停止判定（意图窗慢通道）：非词表停止表达（「先别说了/等一下」）经
   *  daemon 判官 noul 判定。回执/超时/未连接（send false）均收敛布尔——
   *  false = 不停止（照排队，与 daemon 降级链同向保守）；单飞序列号作废
   *  旧调迟到回执。TR-168：send 返回 false 即时回退不悬挂等待。 */
  const judgeStopIntent = useCallback(
    (text: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        judgeStopSeqRef.current += 1;
        const seq = judgeStopSeqRef.current;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (stop: boolean) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          judgeStopWaitersRef.current = judgeStopWaitersRef.current.filter((w) => w !== finish);
          // 单飞：旧调作废 → false（不悬挂——保守回退照排队）
          resolve(seq === judgeStopSeqRef.current ? stop : false);
        };
        judgeStopWaitersRef.current.push(finish);
        if (sendStewardJudgeStopIntent?.(text) === false) return finish(false); // 未连接/未装配
        timer = setTimeout(() => finish(false), JUDGE_STOP_TIMEOUT_MS);
      }),
    [sendStewardJudgeStopIntent],
  );

  const bargeIn = useCallback(() => {
    if (readBargeInIntentPref()) {
      openBargeInIntentWindow();
      return;
    }
    stopSpeaking(); // ①（含残响静默窗）
    const interruptOk = sendStewardInterrupt?.("barge-in") ?? false; // ②
    if (interruptOk === false) {
      // 未连接：打断帧未达 daemon——本地停播即事实（零回滚）；后续 ask
      // 发送失败走 voiceDraft 回填既有降级（零静默丢话）
    }
    void beginListening(); // ③
  }, [stopSpeaking, beginListening, sendStewardInterrupt, openBargeInIntentWindow]);
  bargeInRef.current = bargeIn;

  // 新一轮说话 = 停上轮朗读 + 听音本体（手动 barge-in 同构先序）
  const startListening = useCallback(async () => {
    stopSpeaking();
    await beginListening();
  }, [stopSpeaking, beginListening]);

  const stopListening = useCallback(() => {
    voiceRef.current.stop();
  }, []);

  // ── B2 双工听音锁（重入防护）：beginListening 的 getUserMedia 窗口内
  //    stateRef 仍 idle——自动续听 effect 与 toggleWake 并发触发会双开麦；
  //    锁内串行（useVoiceInput 自身 stateRef 守卫在 await 后才生效）。──
  const beginListeningLockRef = useRef(false);
  const guardedBeginListening = useCallback(async () => {
    if (beginListeningLockRef.current) return;
    beginListeningLockRef.current = true;
    try {
      await beginListening();
    } finally {
      beginListeningLockRef.current = false;
    }
  }, [beginListening]);

  // ── B2 双工 toggle（全局组合键唯一入口；D2 单键 toggle）：无会话 →
 //    进双工（光球浮现 + 欢迎语 + 持续麦）；duplex 在途 → 关麦收口（D6）。──
  const toggleWake = useCallback(async () => {
    // 关麦收口（D2 再按）：duplex 在途 → cancelWake 收场
    if (duplexRef.current) {
      cancelWake();
      return;
    }
    const phase = phaseRef.current;
    // mic 不可用 / 录音链在途 no-op；speaking 相位进待命 = 手动开麦同构先序
    // （先停播——duplex 外的残留朗读）。**asking 态不封锁**（管家可靠性批
    // 2026-10-06 事故根修）：daemon 挂起/排队期 askInFlight 永真 → phase
    // 恒 asking——此时恰是用户最需要唤出确认入口的时刻（确认卡/口令经
    // 双工会话可达），旧实现的 asking no-op 会把快捷键永久封锁。
    if (phase === "unsupported" || phase === "listening" || phase === "transcribing") {
      return;
    }
    stopSpeaking();
    setModeState("voice");
    // B2 双工开场：duplex 置位（光球可见/耳 meter 采样窗）+ 欢迎语
    //（固化音频优先——设置页欢迎词工坊确认解零合成直播；未固化回退 TTS
    // 现合成（money 闸仅作用此路径——固化音频为用户确认资产直接播））。
    // 光球开場呈待机动画（welcomeActive + 开麦前瞬态），用户开口即转倾听
    markDuplex(true);
    setWelcomeActive(true);
    // 问题 8 错峰：欢迎语移到 beginListening 完成后播——输出（固化音频）
    // 与输入（getUserMedia 麦会话）两个音频会话不再并发冷启动（首次呼出
    // 顿挫病根；输出通道已由挂载预热激活）。E-208 门参数零改动：欢迎语
    // 本就不置 speaking 相位，错峰仅挪播放起点不动门消费。
    await guardedBeginListening();
    if (!duplexRef.current) return; // 错峰窗口内快速关麦：会话已收口，欢迎语不补播
    speakWelcome();
  }, [cancelWake, guardedBeginListening, stopSpeaking, markDuplex, speakWelcome]);
  const toggleWakeRef = useRef(toggleWake);
  toggleWakeRef.current = toggleWake;
  /** 光球入口（ref 定格——Layer 接线稳定引用）。 */
  const toggleWakeStable = useCallback(() => {
    void toggleWakeRef.current();
  }, []);

  // 全局组合键注册面（wake-hotkey 单点）：挂载即读偏好注册（壳不读
  // ~/.helix/，偏好读取全在前端——红线不破）；卸载清位。
  useEffect(() => {
    // ── 输出通道预热（问题 8 冷启动修复）：挂载（光球层常驻——app 壳级
    //    用户无感窗口）即静音播零音量音频，提前激活 WKWebView CoreAudio
    //    输出会话——首次呼出的欢迎语不再与通道冷启动竞争。一次性（模块
    //    级单发位——重复挂载不重复预热）；任何失败静默吞不影响后续链路；
    //    **不预热麦克风**——静默开麦有隐私/权限语义问题（指示灯/授权提示
    //    不能无手势点亮），输入侧由欢迎语错峰承担。──
    warmAudioOutputOnce();
    setWakeHotkeyFireHandler(() => {
      void toggleWakeRef.current();
    });
    void syncWakeHotkeyRegistration();
    return () => setWakeHotkeyFireHandler(null);
  }, []);

  // Esc = 手动退出并关麦（duplex 会话期监听挂；唤醒词机制已拆，无待命态遗留）
  useEffect(() => {
    if (!duplexActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelWake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duplexActive, cancelWake]);

  // 面板卸载/路由退场：在录强制停链路自然走完之外，废弃未收口的流（abort
  // 上游——money 纪律零孤儿连接；final 已 pending 时 timer 兑底回落后停）
  useEffect(
    () => () => {
      clearFallbackTimer();
      if (streamArmedRef.current && !finalPendingRef.current) {
        streamSendersRef.current.sendSttStreamStop?.();
      }
      streamArmedRef.current = false;
      streamDeadRef.current = true;
    },
    [clearFallbackTimer],
  );

  // unsupported 自动回退文本态（mic 环境不可用——语音模式不可达）
  const phase = deriveStewardVoicePhase({
    voiceState: voice.state,
    askInFlight: steward.askInFlight,
    speaking,
  });
  // B2：相位镜像（耳帧回调读实时态）+ 离开可打断相位复位门闩锁（下一轮可
  // 再触发；静默窗跨轮保留——残响防线）
  phaseRef.current = phase;
  useEffect(() => {
    if (!isBargeInArmed({ mode, phase })) {
      const out = stepBargeInGate(bargeInGateRef.current, { rms: 0, atMs: Date.now(), armed: false });
      bargeInGateRef.current = out.state;
      // ⑦ 相位离场收口在途候选段（未触发打点——同径同格式；phase 取段归属）
      if (out.missed !== null) {
        recordBargeInTrace({
          at: out.missed.peakAtMs,
          rms: out.missed.peakRms,
          zcr: out.missed.peakZcr,
          phase: out.missed.peakPhase,
          fired: false,
        });
      }
    }
  }, [mode, phase]);
  useEffect(() => {
    if (phase === "unsupported") setModeState("text");
  }, [phase]);

  // ── 排队插话 drain（意图窗批 D1=排队）：播毕/无在途轮且用户未在说话时
  //    自动提交队首（逐条——新 ask 的 asking 相位会压后续 drain 到轮收口）；
  //    duplex 收口清队列（关会话即弃——上下文已不连续）。──
  useEffect(() => {
    if (!duplexActive) {
      queuedUtterancesRef.current = [];
      return;
    }
    if (legacySpeaking || streamSpeaking || askInFlight) return;
    // 通知播报中不提交（回归修复：排队回答的 ask 会开 SPEECH_FLOOR_ROUND
    // 收编截断在播通知——「上一条没播完下一条就开始」体感根源之一；通知
    // 播毕边沿串行放行）。
    if (notifSpeaking) return;
    if (phase === "listening" || phase === "transcribing") return; // 用户在说话/转写在途不打扰
    const q = queuedUtterancesRef.current;
    if (q.length === 0) return;
    const next = q.shift()!;
    submitUtteranceRef.current(next);
  }, [duplexActive, legacySpeaking, streamSpeaking, askInFlight, notifSpeaking, phase]);

  // interim 出态清理（listening/transcribing 外不残留浮字）
  useEffect(() => {
    if (phase !== "listening" && phase !== "transcribing") setInterim(null);
  }, [phase]);

  // ── B2 双工循环（设计稿 §3.3）：duplex 中说完（回 idle 且无唤醒会话）
  //    → 自动续听（新 stt.stream.start，VAD 分段继续听直到关麦）；边沿触发
  //    （离开 idle 重新武装防重复）+ muted 挂起（D5）+ 重入锁。──
  const relistenArmedRef = useRef(true);
  useEffect(() => {
    if (!duplexActive) {
      relistenArmedRef.current = true; // 会话外重置（下双工首轮武装）
      return;
    }
    const idle = phase === "idle";
    if (!idle) {
      relistenArmedRef.current = true;
      return;
    }
    if (!relistenArmedRef.current || mutedRef.current) return;
    relistenArmedRef.current = false;
    void guardedBeginListening();
  }, [duplexActive, phase, muted, guardedBeginListening]);

  // 切模式：进 text = 停朗读 + 在录强制停（转写链照常走完；answer 不再朗读）
  const setMode = useCallback(
    (next: StewardInputMode) => {
      setModeState(next);
      if (next === "text") {
        stopSpeaking();
        stopListening();
      }
    },
    [stopSpeaking, stopListening],
  );

  // ── B2 临时静音（D5 光球点击）：listening 点击 = 静音（停采集——麦克风
  //    指示落地，duplex 会话保持，自动续听挂起）；再点恢复（自动续听边沿
  //    重启）。speaking 相位点击归 stopSpeaking（Layer 按相位分发）。──
  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (!next) return; // 恢复路径：muted 落 → 自动续听 effect 边沿重启
    voiceRef.current.cancel(); // 静音即停采集（track.stop 即刻）
    if (streamArmedRef.current && !streamDeadRef.current) {
      streamSendersRef.current.sendSttStreamStop?.();
    }
    streamArmedRef.current = false;
    streamDeadRef.current = true;
    streamIdRef.current = null; // 单飞门控同步收位（静音期迟到 final 零消费）
    setInterim(null);
    relistenArmedRef.current = true; // 恢复后首轮武装
  }, []);

  return {
    ...steward,
    mode,
    setMode,
    phase,
    level: voice.level,
    userSpeaking: voice.userSpeaking,
    interim,
    streamDegraded,
    speaking,
    voiceError: voice.error,
    voiceDraft,
    cancelWake,
    startListening,
    stopListening,
    stopSpeaking,
    clearVoiceDraft: useCallback(() => setVoiceDraft(null), []),
    duplexActive,
    welcomeActive,
    notifSpeaking,
    bargeInIntentActive,
    executeBargeInStop,
    closeBargeInIntentWindow,
    queueUtterance,
    judgeStopIntent,
    muted,
    toggleMute,
    toggleWake: toggleWakeStable,
    say,
    submitUtterance,
    lastUtterancePcm: useCallback(() => pcmRingRef.current?.takeUtterance() ?? null, []),
  };
}
