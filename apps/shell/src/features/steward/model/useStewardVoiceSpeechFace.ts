/**
 * useStewardVoiceSpeechFace —— 出声面协调与停播序（P2 体量门 ④ 轻拆批：从
 * useStewardVoice.ts 机械迁出，hook 体逐字未改；调用点原位——effect 注册序
 * 与迁出前一致）。
 *
 * 四轨（a 流式 / b 回执 / c 通知 / d 欢迎语）播×播互斥与全轨停止单点
 * （E-266）：
 * - b 面让位（stopLegacyAudio）/ a 起播收编 b、d（onSpeakingChange 边沿）；
 * - 租约 + 协调位同点写（markLegacySpeaking / 卸载收位）；
 * - 停播序 stopSpeaking（残响静默窗 + 意图窗收位 + 全轨 stop）；
 * - 欢迎语固化音频生命周期（useStewardWelcomeAudio）+ 主动发言 say。
 *
 * 状态机（duck 三轨记账/意图窗）仍归 steward-bargein-window——本 hook 只
 * 持协调位与停播序，不判打断。
 */
import { useCallback, useEffect } from "react";
import { useI18n } from "@/shared/i18n";
import { beginDialogueSpeech, endDialogueSpeech, stopNotificationSpeech } from "@/shared/lib/speech-floor";
import { beginSpeechLease, endSpeechLease } from "@/shared/lib/speech-mutex";
import { readStewardSpeakReplyPref, readVoiceSilenceWindowPref } from "@/shared/lib/voice-pref";
import type { BargeInIntentWindow } from "./steward-bargein-window";
import { openBargeInSilenceWindow, shouldSpeakReply, type BargeInGateState } from "./steward-voice-machine";
import { useStewardWelcomeAudio } from "./useStewardWelcomeAudio";
import type { StewardSpeechOut } from "./steward-speech-out";

// ── ⑥ speech-mutex 租约源（播报-收音互斥：发言期登记，收音侧逐帧查互斥态
//    暂停 STT 上行——流保持开不重开不关，播报完自动恢复；多源幂等计数，
//    嵌套播报正确配对。本钩子内的发言源三个：speechOut 流式队列 / 一次性
//    回执 legacy Audio / 欢迎语固化音频；全局播报源在 useVoiceBroadcast。──
const SPEECH_LEASE_SPEECH_OUT = "steward-speech";
const SPEECH_LEASE_LEGACY = "steward-legacy-audio";
const SPEECH_LEASE_WELCOME = "steward-welcome-audio";

/** 出声面协调的注入面（单例/ref/状态设值器由组合根持有——同实例同序）。 */
export interface StewardVoiceSpeechFaceDeps {
  readonly speechOut: StewardSpeechOut;
  readonly audioRef: { current: HTMLAudioElement | null };
  readonly welcomeAudioRef: { current: HTMLAudioElement | null };
  readonly bargeInWindow: BargeInIntentWindow;
  readonly bargeInGateRef: { current: BargeInGateState };
  readonly speakPendingRef: { current: boolean };
  readonly cedeWelcomeRef: { current: () => void };
  readonly setLegacySpeaking: (active: boolean) => void;
  readonly setStreamSpeaking: (active: boolean) => void;
  readonly setStreamQueue: (depth: number) => void;
  readonly setBargeInIntentActive: (active: boolean) => void;
  readonly settleRef: { current: () => void };
  readonly welcomeText?: string;
}

export interface StewardVoiceSpeechFace {
  readonly stopLegacyAudio: () => void;
  readonly markLegacySpeaking: (active: boolean) => void;
  readonly settleBargeInWindow: () => void;
  readonly stopSpeaking: () => void;
  readonly say: (text: string) => void;
  readonly stopWelcomeAudio: () => void;
  readonly speakWelcome: () => void;
}

export function useStewardVoiceSpeechFace(deps: StewardVoiceSpeechFaceDeps): StewardVoiceSpeechFace {
  const {
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
    welcomeText,
  } = deps;
  // ── b 面（一次性回执）让位停播：a×b 互斥反向边（b 起播已停 a，本边补齐
  //    a 起播/新轮开轮收编 b——单向收编是双声重叠残留缺口）。租约/协调位
  //    同点收位（幂等——unmount/stopSpeaking 共径零双发）。──
  const stopLegacyAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    audioRef.current = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    setLegacySpeaking(false);
    endSpeechLease(SPEECH_LEASE_LEGACY);
    endDialogueSpeech(SPEECH_LEASE_LEGACY);
  }, []);
  useEffect(() => {
    // ⑥ 播放态边沿 = 租约边沿（首块入队播放 → 发言期；播尽/停 → 释放）
    // ① 同边沿接协调器：a 面在播 = 对话发言期（通知面被压制/收编）
    return speechOut.onSpeakingChange((active) => {
      if (active) {
        stopLegacyAudio(); // 反向互斥：a 起播收编 b（旧回执不让位就双声）
        cedeWelcomeRef.current(); // d×a 反向让位：回答起播收编欢迎语（问题 1 让位哲学延伸，零双声）
        beginSpeechLease(SPEECH_LEASE_SPEECH_OUT);
        beginDialogueSpeech(SPEECH_LEASE_SPEECH_OUT);
      } else {
        endSpeechLease(SPEECH_LEASE_SPEECH_OUT);
        endDialogueSpeech(SPEECH_LEASE_SPEECH_OUT);
      }
      setStreamSpeaking(active);
    });
  }, [speechOut]);
  // 队列深度透出订阅（光球角标数据源——pending 变化即推）
  useEffect(() => speechOut.onQueueChange(setStreamQueue), [speechOut]);

  /** 一次性回执播放态（legacy Audio）：状态 + 租约 + ① 协调器同点写
   * （播放即持、播毕释放；b 面在播 = 对话发言期）。 */
  const markLegacySpeaking = useCallback((active: boolean) => {
    if (active) {
      cedeWelcomeRef.current(); // d×b 反向让位：回执起播收编欢迎语（零双声）
      beginSpeechLease(SPEECH_LEASE_LEGACY);
      beginDialogueSpeech(SPEECH_LEASE_LEGACY);
    } else {
      endSpeechLease(SPEECH_LEASE_LEGACY);
      endDialogueSpeech(SPEECH_LEASE_LEGACY);
    }
    setLegacySpeaking(active);
  }, []);

  // ── barge-in 意图窗：settle（批 4b：委托状态机——原 duckVolume/restoreVolume/
  //    settleBargeInWindow 三函数收口：duck 三轨记账恢复/timer 清位/mark 锚内聚）──
  const settleBargeInWindow = useCallback(() => {
    bargeInWindow.settle();
    setBargeInIntentActive(false);
  }, [bargeInWindow]);
  settleRef.current = settleBargeInWindow; // ref 转发（window onTimeout 延绑）

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
  // ── 欢迎语固化音频（批 4b：域收口 useStewardWelcomeAudio——行为等价；
  //    welcomeAudioRef 声明上移 barge-in 区（window tracks 三轨共享））──
  const { stop: stopWelcomeAudio, speak: speakWelcome } = useStewardWelcomeAudio({
    audioRef: welcomeAudioRef,
    say,
    welcomeText,
    fallbackText: t("steward.voice.welcome"),
  });

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
        // barge-in 意图窗收口（timer + duck 三轨音量）：不 dispose 则 5s 超时
        // timer 在卸载后照跑——onTimeout 经 settleRef 调 setState（卸载后 setState
        // 残留形态），且 duck 音量永无恢复面（三轨停在压低音量）
        bargeInWindow.dispose();
        stopWelcomeAudio();
      };
    },
    [speechOut, stopWelcomeAudio, bargeInWindow],
  );
  return { stopLegacyAudio, markLegacySpeaking, settleBargeInWindow, stopSpeaking, say, stopWelcomeAudio, speakWelcome };
}
