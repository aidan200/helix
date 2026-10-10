/**
 * useStewardWelcomeAudio —— 欢迎语固化音频生命周期（批 4b 域收口，从
 * useStewardVoice 迁出——行为逐项等价）。
 *
 * 呼出优先播固化解（设置页生成试听确认的 TTS 回执原样存——零合成延迟、
 * 音色即试听即所得）；未固化回退 TTS 现合成（首次使用/清存储）。固化路径
 * 不置 speaking（球保持待机动画——欢迎语是伴随声非回复）且不占 speechOut
 * 队列。
 *
 * 音轨 ref 归组合根持有（barge-in duck 三轨共享——welcome 是其中一轨），
 * 本 hook 经参数接收；租约对（speech-mutex ⑥/speech-floor ①）模块级
 * 单例直接消费（SPEECH_LEASE_WELCOME 同源常量）。
 */
import { useCallback, useRef, type MutableRefObject } from "react";
import { beginSpeechLease, endSpeechLease } from "@/shared/lib/speech-mutex";
import { beginDialogueSpeech, endDialogueSpeech } from "@/shared/lib/speech-floor";
import { readWelcomeAudioPref, readWelcomeTextPref } from "@/shared/lib/voice-pref";
import { readVoiceVolumePref } from "@/shared/lib/voice-pref";

/** 欢迎语音轨租约源（speech-mutex/speech-floor 同源常量——迁移原值）。 */
const SPEECH_LEASE_WELCOME = "steward-welcome-audio";

export interface UseStewardWelcomeAudioDeps {
  /** 固化解音轨（组合根共享 ref——barge-in duck 三轨之一）。 */
  readonly audioRef: MutableRefObject<HTMLAudioElement | null>;
  /** 回退 TTS 现合成入口（组合根 say——money 闸在 say 内判）。 */
  readonly say: (text: string) => void;
  /** 缺省欢迎文案（选项 welcomeText——固化解/偏好文案双缺时兜底）。 */
  readonly welcomeText: string | undefined;
  /** i18n 兜底文案键值。 */
  readonly fallbackText: string;
}

export function useStewardWelcomeAudio(deps: UseStewardWelcomeAudioDeps): {
  /** 停固化音频（提前停/卸载面——租约同点释放）。 */
  stop: () => void;
  /** 呼出播报（固化优先/回退现合成）。 */
  speak: () => void;
} {
  const { audioRef, say, welcomeText, fallbackText } = deps;
  const welcomeTextRef = useRef(welcomeText);
  welcomeTextRef.current = welcomeText;
  const sayRef = useRef(say);
  sayRef.current = say; // ref 转发实时读（stop/speak 闭包不随 say 重绑）

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    audioRef.current = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    endSpeechLease(SPEECH_LEASE_WELCOME); // ⑥ 欢迎语发言期同占租约（提前停即释放）
    endDialogueSpeech(SPEECH_LEASE_WELCOME); // ① 协调面同点收位（欢迎语 = 管家在跟你说话 → 压通知）
  }, [audioRef]);

  const speak = useCallback(() => {
    const cached = readWelcomeAudioPref();
    if (cached !== null) {
      try {
        const audio = new Audio(cached);
        audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
        audioRef.current = audio;
        beginSpeechLease(SPEECH_LEASE_WELCOME); // ⑥ 发言期登记（播毕/失败释放）
        beginDialogueSpeech(SPEECH_LEASE_WELCOME); // ① 欢迎语对话源：起播压/停通知
        audio.onended = () => {
          if (audioRef.current === audio) audioRef.current = null;
          endSpeechLease(SPEECH_LEASE_WELCOME);
          endDialogueSpeech(SPEECH_LEASE_WELCOME);
        };
        // 泄漏修复：播放异常（解码失败/中断）同点收位——onended 不会来的
        // 异常路径若不收位，租约/协调位永占（收音上行死 + 通知永延后）。
        audio.onerror = () => {
          if (audioRef.current === audio) audioRef.current = null;
          endSpeechLease(SPEECH_LEASE_WELCOME);
          endDialogueSpeech(SPEECH_LEASE_WELCOME);
        };
        void audio.play().catch(() => {
          if (audioRef.current === audio) audioRef.current = null;
          endSpeechLease(SPEECH_LEASE_WELCOME);
          endDialogueSpeech(SPEECH_LEASE_WELCOME);
        });
        return;
      } catch {
        // 固化解损坏/不可播 → 回退 TTS 现合成
      }
    }
    sayRef.current(readWelcomeTextPref() ?? welcomeTextRef.current ?? fallbackText);
  }, [audioRef, fallbackText]);

  return { stop, speak };
}
