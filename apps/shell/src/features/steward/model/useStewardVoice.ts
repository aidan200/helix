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
 *   （含 c——弃播不续）。欢迎语固化音频已接齐协调面（SPEECH_LEASE_WELCOME
 *   租约 + beginDialogueSpeech 协调位 + cede-on-voice 让位同点收位）。
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
 * 参数零改动（欢迎语本就不置 speaking 相位，仅挪播放起点）。**欢迎语让位
 * （cede-on-voice，问题 1 修复）**：固化欢迎语播放期人声过门（barge-in 门
 * 同源武装、gatePhase=speaking ×2 抬档防自声）= 用户开口 → 停欢迎语让位
 *（租约/协调面随 stop 收位，收音上行即恢复），不走打断全停/意图窗。
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
import { useVoiceInput } from "@/shared/lib/useVoiceInput";
import { pcmFrameToBase64 } from "@/shared/lib/pcm-pump";
import { createPcmRing, type PcmRing } from "../voiceprint/model/pcm-ring";
import { BargeInIntentWindow } from "./steward-bargein-window";
import { NoiseCalibration } from "./steward-ear-calibration";
import { readSttProviderPref } from "@/shared/lib/stt-provider-pref";
import {
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
import { setWakeHotkeyFireHandler, syncWakeHotkeyRegistration } from "@/shared/lib/wake-hotkey";
import { warmAudioOutputOnce } from "./audio-output-warmup";
import { speechLeaseActive } from "@/shared/lib/speech-mutex";
import {
  notificationSpeechActive,
  onNotificationPlaybackChange,
  onNotificationQueueChange,
  setMicOccupied,
} from "@/shared/lib/speech-floor";
import { recordBargeInTrace } from "@/shared/lib/barge-in-trace";
import {
  effectiveRmsThreshold,
} from "@/shared/lib/voice-gate";
import type { MeterFrame } from "@/shared/lib/rms-meter";
import type { EventEnvelope } from "@helix/protocol";
import { useSteward } from "./useSteward";
import { useStewardVoiceSpeechOut } from "./useStewardVoiceSpeechOut";
import {
  deriveStewardVoicePhase,
  mdToSpeechText,
  planTranscript,
  stepBargeInGate,
  isBargeInArmed,
  INITIAL_BARGE_IN_GATE,
  type BargeInGateState,
  type StewardInputMode,
  type StewardVoicePhase,
} from "./steward-voice-machine";

/** 终帧等待上限（ms）：超时自动回落非流式（V3a 行为等价）。 */
export const STREAM_FINAL_TIMEOUT_MS = 4_000;

// ⑥ speech-mutex 租约源随出声面协调迁出 useStewardVoiceSpeechFace.ts
// （P2 体量门 ④ 轻拆批）。

// ── barge-in 意图窗参数（意图门控打断批）──
/** duck 音量比例（播报不停但压低——降自声回灌 + 插话清晰）。 */
const BARGE_IN_INTENT_DUCK_SCALE = 0.2;
/** 窗超时（ms）：无 final 兕底关窗（噪音过门后用户实际没说话/ASR 无产出）。 */
const BARGE_IN_INTENT_WINDOW_MS = 5_000;
/** 停止意图判定（Jev 单轨）超时（ms）：判官无响应/帧丢失 → 判不出归一
 *  （fail-stop 归消费面——窗内判不出=真停，宁误停不漏停）。 */
const JUDGE_STOP_TIMEOUT_MS = 2_500;
// 批 3b 退役：BARGE_IN_QUEUE_MAX（排队插话）随裁决 #2 拆除——判非 stop
// 丢弃关窗，无排队。

// ① speech-floor 对话源（SPEECH_FLOOR_ROUND）随对话面帧订阅装配迁出
// useStewardVoiceFrames.ts（P2 体量门 ④ 轻拆批）。
/** 接口面契约迁出 steward-voice-contract.ts（P2 体量门 ④ 轻拆批：声明逐字
 *  迁移零语义改动）；此处 re-export 保公共 API 面不变（消费方零感知）。 */
export type { UseStewardVoiceOptions, UseStewardVoice } from "./steward-voice-contract";
import type { UseStewardVoiceOptions, UseStewardVoice } from "./steward-voice-contract";
import { useStewardVoiceSpeechFrames, useStewardVoiceSttFrames } from "./useStewardVoiceFrames";
import { useStewardVoiceEarMeter } from "./useStewardVoiceEarMeter";
import { useStewardVoiceSpeechFace } from "./useStewardVoiceSpeechFace";

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
    sendStewardInterrupt?: (reason?: string, scope?: "current" | "all") => boolean;
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
  /** 底噪校准采样窗（批 4b 收口 steward-ear-calibration——原 4 refs 内联）。 */
  const calibRef = useRef<NoiseCalibration | null>(null);
  if (calibRef.current === null) calibRef.current = new NoiseCalibration();
  const noiseCalib = calibRef.current;
  const markDuplex = useCallback((v: boolean) => {
    duplexRef.current = v;
    setDuplexActive(v);
    if (v) {
      noiseCalib.open(Date.now()); // 开启即开采样窗（重采）
    } else {
      noiseCalib.close(); // 落位清校准：下次双工重采（cancelWake/关麦后不携旧底噪）
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
  // ── TTS 队列计数（光球左上角徽标）：流式在途句（speechOut 深度透出）+
  //    一次性回执在播（legacy 面 +1）+ 广播/通知轨（队列镜像）——三面合并
  //    单计数（双轨入账：有声必有计数）。──
  const [streamQueue, setStreamQueue] = useState(0);
  const [broadcastQueue, setBroadcastQueue] = useState(0);
  useEffect(() => onNotificationQueueChange(setBroadcastQueue), []);
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
  /** cedeWelcome 转发（a/b 起播边沿消费——onSpeakingChange/markLegacySpeaking
   *   定义在 cedeWelcome 之前，ref 免时序死结（bargeInRef 同构先例）。） */
  const cedeWelcomeRef = useRef<() => void>(() => {});
  /** executeBargeInStop ref 转发（stt 帧 effect 定义在前——interim 快通道调）。 */
  const executeBargeInStopRef = useRef<() => void>(() => {});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // ── barge-in 意图窗（意图门控打断批）：声学触发后不真停，开窗收插话判
  //    意图（声纹→Jev 停止判定）；窗内 duck 播报 + 豁免收音门控。──
  /** 窗开标记（同步读面——onPcmFrame 豁免/final 分流；state 面向 Layer）。 */
  const [bargeInIntentActive, setBargeInIntentActive] = useState(false);
  /** 音轨 refs 上移（window 实例构造依赖——useRef 零副作用声明序无关行为）。 */
  const welcomeAudioRef = useRef<HTMLAudioElement | null>(null);
  const pcmRingRef = useRef<PcmRing | null>(null);
  /** settle 转发（window 构造时序：onTimeout 经 ref 延绑——commands-surface 先例）。 */
  const settleRef = useRef<() => void>(() => {});
  // ── 停止意图判定（Jev 单轨——停止词表退役批）：判官 RPC 等待队列
  //    （回执/超时唤醒；迟到回执无等待者即幂等吞）。──
  const judgeStopWaitersRef = useRef<((verdict: "stop" | "other" | "unjudged") => void)[]>([]);

  // 出声面单例装配迁出 useStewardVoiceSpeechOut.ts（P2 体量门 ④ 轻拆批：
  // 构造体逐字迁移、调用点原位——单例与 sender 重绑语义不变）。
  const speechOut = useStewardVoiceSpeechOut({
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
    createPlayer: options?.createPlayer,
    speakPendingRef,
    speakRoundRef,
    answerRoundRef,
  });

  // ── barge-in 意图窗状态机（批 4b 收口：duck 三轨记账/超时 timer/mark 锚
  //    全部内聚纯类 steward-bargein-window.ts）──
  const bargeInWindowRef = useRef<BargeInIntentWindow | null>(null);
  if (bargeInWindowRef.current === null) {
    bargeInWindowRef.current = new BargeInIntentWindow({
      tracks: {
        setPlayerVolume: (v) => speechOut.setVolume(v),
        getLegacyVolume: () => audioRef.current?.volume ?? 1,
        setLegacyVolume: (v) => {
          if (audioRef.current !== null) audioRef.current.volume = v;
        },
        getWelcomeVolume: () => welcomeAudioRef.current?.volume ?? 1,
        setWelcomeVolume: (v) => {
          if (welcomeAudioRef.current !== null) welcomeAudioRef.current.volume = v;
        },
      },
      mark: () => pcmRingRef.current?.mark(),
      onTimeout: () => settleRef.current(), // 窗超时兜底：不真停，恢复音量关窗回门控
      windowMs: BARGE_IN_INTENT_WINDOW_MS,
    });
  }
  const bargeInWindow = bargeInWindowRef.current;
  // 出声面协调与停播序迁出 useStewardVoiceSpeechFace.ts（P2 体量门 ④ 轻拆批：
  // hook 体逐字迁移、调用点原位——effect 注册序不变）。
  const {
    stopLegacyAudio,
    markLegacySpeaking,
    settleBargeInWindow,
    stopSpeaking,
    say,
    stopWelcomeAudio,
    speakWelcome,
  } = useStewardVoiceSpeechFace({
    speechOut,
    audioRef,
    welcomeAudioRef,
    bargeInWindow,
    bargeInGateRef,
    speakPendingRef,
    cedeWelcomeRef,
    setLegacySpeaking,
    setStreamSpeaking,
    setStreamQueue,
    setBargeInIntentActive,
    settleRef,
    welcomeText: options?.welcomeText,
  });

  // 回答终态 → 朗读闸（money 纪律：语音模式 × 偏好开；answer 判别在
  // speechOut 内收口）。流式优先：delta 已切句发流的轮次不再重复一次性。
  // 模式按 result 时点读（ref 免 listener 重绑）。
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // ── 欢迎语让位（cede-on-voice，问题 1 修复）：固化欢迎语播放期用户开口 →
  //    停欢迎语让位（stop 同点收租约/协调位 → 收音上行即恢复，当前句剩余部分
  //    照常流式上行）。与 barge-in（停播报）的边界：欢迎语是伴随声非回复，
  //    无需打断序/意图窗/停止判定——让位即停，触发窗自带残响静默窗。──
  const cedeWelcome = useCallback(() => {
    setWelcomeActive(false);
    stopWelcomeAudio();
  }, [stopWelcomeAudio]);
  cedeWelcomeRef.current = cedeWelcome; // ref 转发（a/b 起播边沿实时读）

  // ── B2 barge-in 门帧消费（耳 meter 回调；armed = 相位派生）──
  // B3：门参数逐帧读偏好（最短发声/静默窗/双参判定/容忍带）+ 门限分档
  //（phase 抬档防 TTS 自声回灌）——设置面改偏好，下一次门判定即用新值
  //（不必重开麦）；触发帧特征入误触埋点环形缓冲（校准数据面）。
  // 底噪校准（语音判定钝感批）：阈值经 effectiveThreshold 单点——与聆听
  // 收口门（useVoiceInput getRmsThreshold 注入）同源，两门一起钝/灵。
  const effectiveThreshold = useCallback(
    () => effectiveRmsThreshold(voiceRmsThresholdFromSensitivity(readVoiceVadSensitivityPref()), noiseCalib.estimate()),
    [],
  );
  const onBargeInLevel = useCallback(
    (frame: MeterFrame) => {
      // 门武装面扩展（打断不灵敏修复）：通知播报（c 面）不驱动 speaking 相位
      //（相位只由对话轨 a/b 派生）——无此扩展时通知播报期相位 idle → 门天。
      // 通知占用在场时等价 speaking 语义：门开 + 阈值 ×2 抬档（自声回灌防
      // 线同对话轨——通知语音同样从扬声器出）。欢迎语让位批：固化欢迎语播放期
      // 同理武装（gatePhase=speaking 恒抬档防自声），触发走让位分支（下方）。
      const welcomeSpeaking = welcomeAudioRef.current !== null;
      const notifSpeaking = notificationSpeechActive();
      const gatePhase = welcomeSpeaking
        ? "speaking"
        : notifSpeaking && phaseRef.current === "idle"
          ? "speaking"
          : phaseRef.current;
      const armed =
        isBargeInArmed({ mode: modeRef.current, phase: phaseRef.current }) ||
        (modeRef.current === "voice" && (notifSpeaking || welcomeSpeaking));
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
        // 欢迎语让位（问题 1 修复）：固化欢迎语播放期人声过门 = 用户开口——
        // 让位停欢迎语（收音上行即恢复），不走 barge-in（打断全停/意图窗是
        // 对话语音的语义，欢迎语无需停止判定；触发窗自带残响静默窗）。
        if (welcomeAudioRef.current !== null && !isBargeInArmed({ mode: modeRef.current, phase: phaseRef.current })) {
          cedeWelcome();
          return;
        }
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
    [effectiveThreshold, cedeWelcome],
  );

  // 耳帧消费（校准采样前置 + barge-in 门）：采样窗内先收帧入样本集；首帧
  // 落在窗外即定稿（≥10 帧取 P20，不足回落 null 纯偏好）——校准完成前两门
  // 用纯偏好值（不因校准挂起判定）。P4 近似（E-221，本批接受现状）：耳侧
  // 底噪估计作用于录音门（双 meter 双路径）——两门同源的是阈值单点，不是
  // 采集路径；meter 合一不在本批。
  const onEarFrame = useCallback(
    (frame: MeterFrame) => {
      // 底噪校准采样窗（批 4b 收口 steward-ear-calibration——定稿/发言期
      // 排除语义等价迁移：租约期帧不入样本——TTS 回灌帧混入会把 P20 底噪
      // 抬到焊死位（打不断的候选 B 根因）；样本不足回落纯偏好。）
      noiseCalib.finalizeIfDue(Date.now());
      noiseCalib.feed(frame.rms, speechLeaseActive(), Date.now());
      onBargeInLevel(frame);
    },
    [onBargeInLevel],
  );

  // 耳 meter 采样装配迁出 useStewardVoiceEarMeter.ts（P2 体量门 ④ 轻拆批：
  // hook 体逐字迁移、调用点原位——effect 注册序不变）。
  useStewardVoiceEarMeter({
    active: duplexActive,
    mode,
    onEarFrame,
    createMeter: options?.createMeter,
  });
  // 帧订阅面（对话面三件：steward 帧消费 + ask 在途开轮 + voice 回执帧）
  // 迁出 useStewardVoiceFrames.ts（P2 体量门 ④ 轻拆批：钩子体逐字迁移、
  // 调用点原位——effect 注册序不变）。
  useStewardVoiceSpeechFrames({
    subscribeStewardFrames,
    subscribeVoiceFrames,
    modeRef,
    speechOut,
    judgeStopWaitersRef,
    speakPendingRef,
    speakRoundRef,
    answerRoundRef,
    audioRef,
    stopLegacyAudio,
    markLegacySpeaking,
    askInFlight: steward.askInFlight,
  });

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
  if (pcmRingRef.current === null) pcmRingRef.current = createPcmRing(); // 声明上移 barge-in 区（window mark 依赖）

  // PCM 帧 → 声纹环（无条件）+ stt.stream.chunk（仅 armed 且未死；他态零上行——money 纪律）
  // ⑥ 互斥门：播报发言期（任一租约在场）本地暂停上行——流保持开（不重开
  // 不关流），播报完自动恢复；TTS 自声回灌不再污染转写（「回执冲掉说话」根修）。
  const onPcmFrame = useCallback((frame: ArrayBuffer) => {
    pcmRingRef.current?.push(frame);
    if (!streamArmedRef.current || streamDeadRef.current) return;
    // 发言期暂停上行（意图窗豁免：插话帧与自声同流上行——duck 压低回灌，
    // 窗关回门控）。
    if (speechLeaseActive() && !bargeInWindow.isActive()) return; // 意图窗豁免（状态机同步读面）
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
       *  意图窗内 final 传 ctx（Layer 判定分支：声纹→Jev 停止判定）。 */
      const routeToAsk = (utterance: string) => {
        if (onFinalTextRef.current?.(utterance, { bargeInIntent: bargeInWindow.isActive() }) === "consumed") return;
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

  // 流式帧消费面迁出 useStewardVoiceFrames.ts（P2 体量门 ④ 轻拆批：钩子体
  // 逐字迁移、调用点原位——effect 注册序不变）。
  useStewardVoiceSttFrames({
    subscribeSttFrames,
    streamArmedRef,
    streamIdRef,
    streamDeadRef,
    finalPendingRef,
    clearFallbackTimer,
    voiceRef,
    setInterim,
    setStreamDegraded,
  });

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

  // ── B2 双工听音锁（重入防护）：beginListening 的 getUserMedia 窗口内
  //    stateRef 仍 idle——自动续听 effect 与 toggleWake/打断入口并发触发会
  //    双开麦；锁内串行（useVoiceInput 自身 stateRef 守卫在 await 后才生效）。
  //    评审 useStewardVoice:1180：锁必须覆盖**全部** beginListening 入口
  //    （toggleWake/自动续听/openBargeInIntentWindow/bargeIn/startListening）
  //    ——任何一处直调 beginListening 都把双开麦竞态窗口重新敞开。
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

  // B2 barge-in 打断序（①②③不可换序——UX 与一致性分离）：①立即停播
  // （零延迟）②steward.interrupt（daemon abortInFlight 幂等善后）③进
  // listening 开 stt.stream.start 新流；新转写 final → steward.ask 新轮。
  // 意图门控批：偏好开（默认）→ 开意图窗（不真停：duck + 收插话判意图——
  // 停止意图才走三步序）；偏好关 → 回退声学直停（原行为零改动）。
  const openBargeInIntentWindow = useCallback(() => {
    if (bargeInWindow.isActive()) return; // 窗已开幂等（fired 闩锁外再防线）
    setBargeInIntentActive(true); // 呈现位（状态位/mark/duck/timer 归状态机）
    bargeInWindow.open(BARGE_IN_INTENT_DUCK_SCALE); // duck+mark 锚+超时 timer 内聚
    void guardedBeginListening(); // 开麦+开新转写流（收插话）——不 stopSpeaking 不 interrupt
  }, [bargeInWindow, guardedBeginListening]);

  /** 真停（停止意图确认——Layer 意图判定后调）：三步序①停播全轨②interrupt
   *  携 scope=all 全停（批 3b 裁决乙：语音停止判定 = abort 当前 + 清空 daemon
   *  ask 队列；面板停止钮缺省 current 轻停——两轨分野在此）；③收音不显式
   *  开——final 判定路径靠自动续听（idle 边沿）重开。 */
  const executeBargeInStop = useCallback(() => {
    settleBargeInWindow(); // 窗先收（恢复音量——stopSpeaking 面再收幂等）
    stopSpeaking(); // ①（含残响静默窗 + 全轨停止）
    sendStewardInterrupt?.("barge-in", "all"); // ②（幂等；未连接本地停播即事实）
  }, [settleBargeInWindow, stopSpeaking, sendStewardInterrupt]);
  executeBargeInStopRef.current = executeBargeInStop;

  /** 窗收口不真停（噪音/旁人/非停止插话——Layer 判定后调）。 */
  const closeBargeInIntentWindow = useCallback(() => {
    settleBargeInWindow();
  }, [settleBargeInWindow]);

  // 批 3b 退役（裁决 #2）：queueUtterance（排队插话）拆除——播报期单向广播，
  // 判非 stop = 丢弃关窗。

  /** 停止意图判定（Jev 单轨——停止词表退役批）：daemon 判官 noul 语义判定。
   *  回执/超时/未连接（send false）/异常均收敛三态——判不出归一 "unjudged"
   *  （不抛不悬挂）；fail-stop 归消费面（窗内判不出=真停宁误停不漏停）。 */
  const judgeStopIntent = useCallback(
    (text: string): Promise<"stop" | "other" | "unjudged"> =>
      new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (verdict: "stop" | "other" | "unjudged") => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          judgeStopWaitersRef.current = judgeStopWaitersRef.current.filter((w) => w !== finish);
          resolve(verdict);
        };
        judgeStopWaitersRef.current.push(finish);
        // 未装配（测试替身/旧装配面）与未连接（send=false）同归 unjudged——
        // 旧实现只覆盖「已装配且返回 false」，sender 缺席时仍挂满 JUDGE_STOP
        // 超时才收敛（窗内判不出就白等 2.5s）
        if (typeof sendStewardJudgeStopIntent !== "function") return finish("unjudged");
        if (sendStewardJudgeStopIntent(text) === false) return finish("unjudged"); // TR-84：不悬挂等待
        timer = setTimeout(() => finish("unjudged"), JUDGE_STOP_TIMEOUT_MS);
      }),
    [sendStewardJudgeStopIntent],
  );

  const bargeIn = useCallback(() => {
    if (readBargeInIntentPref()) {
      openBargeInIntentWindow();
      return;
    }
    stopSpeaking(); // ①（含残响静默窗）
    const interruptOk = sendStewardInterrupt?.("barge-in", "all") ?? false; // ②（裁决乙：语音停通道全停——与 executeBargeInStop 同径）
    if (interruptOk === false) {
      // 未连接：打断帧未达 daemon——本地停播即事实（零回滚）；后续 ask
      // 发送失败走 voiceDraft 回填既有降级（零静默丢话）
    }
    void guardedBeginListening(); // ③
  }, [stopSpeaking, guardedBeginListening, sendStewardInterrupt, openBargeInIntentWindow]);
  bargeInRef.current = bargeIn;

  // 新一轮说话 = 停上轮朗读 + 听音本体（手动 barge-in 同构先序）
  const startListening = useCallback(async () => {
    stopSpeaking();
    await guardedBeginListening();
  }, [stopSpeaking, guardedBeginListening]);

  const stopListening = useCallback(() => {
    voiceRef.current.stop();
  }, []);

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

  // 批 3b 退役（裁决 #2）：排队插话 drain 拆除——播报期单向广播，判非 stop
  //    即丢弃，无队列无自动提交（跨端队列不一致 bug 连根消灭：真停全停
  //    后 shell 排队不再残留自动开口）。

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
    // 问题 2 裁决 b：通知播报期不续听（播报不叠用户说话）——武装位不清，
    // 通知收口（notifSpeaking 落）边沿自动续听。
    if (notifSpeaking) return;
    relistenArmedRef.current = false;
    void guardedBeginListening();
  }, [duplexActive, phase, muted, notifSpeaking, guardedBeginListening]);

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
    ttsQueue: streamQueue + (legacySpeaking ? 1 : 0) + broadcastQueue,
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
    judgeStopIntent,
    muted,
    toggleMute,
    toggleWake: toggleWakeStable,
    say,
    submitUtterance,
    lastUtterancePcm: useCallback(
      (opts?: { fromMark?: boolean }) => pcmRingRef.current?.takeUtterance(opts ?? {}) ?? null,
      [],
    ),
  };
}
