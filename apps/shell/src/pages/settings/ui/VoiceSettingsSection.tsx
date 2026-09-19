/**
 * 语音设置分区（语音输入批 V1 STT + 语音播报批 V2 TTS）。
 *
 * STT（V1）：
 * - provider 选择：偏好存 localStorage（helix.stt.provider；缺省 auto =
 *   daemon 装配序自动选首个已配 key 的——dashscope 主选、siliconflow 兜底）；
 *   Composer 转写命令随偏好携带 payload.provider（auto 不带）；
 * - key 录入：复用 auth.set_key 通道（setProviderKey——dashscope 作为新
 *   provider id 经 daemon ModelService sttProviderIds 放行）；状态显示自
 *   auth.list（进入分区拉取 requestAuthList；dashscope/siliconflow 在
 *   daemon authList 并入清单）。
 *
 * TTS（V2 播报）：
 * - 播报开关：默认 **off**（helix.voice.broadcast；不偷偷发音频花钱）——
 *   开 = App 根 useVoiceBroadcast 连接就绪后发 voice.subscribe（daemon 侧
 *   money gate：零订阅连接零合成）；关 = voice.unsubscribe；
 * - 音色选择：helix.voice.ttsVoice（qwen3-tts 官方音色清单；默认 Cherry）；
 * - 音量：helix.voice.volume（0–100，播放侧 Audio.volume）；
 * - 试听按钮：voice.synthesize 固定短句（点对点回执）→ Audio 播放——
 *   key/链路/音色一次性验证面。
 * 纯展示 + 命令转发（TR-AD-8）：数据零权威，全部结果帧驱动。
 */
import { useEffect, useRef, useState } from "react";
import { KeyRound, Volume2 } from "lucide-react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import { readSttProviderPref, writeSttProviderPref, STT_PROVIDER_PREF_KEY } from "@/shared/lib/stt-provider-pref";
import {
  DEFAULT_TTS_VOICE,
  TTS_VOICE_OPTIONS,
  readTtsVoicePref,
  readVoiceBroadcastPref,
  readVoiceVolumePref,
  writeTtsVoicePref,
  writeVoiceBroadcastPref,
  writeVoiceVolumePref,
} from "@/shared/lib/voice-pref";
import type { EventEnvelope } from "@helix/protocol";

export { STT_PROVIDER_PREF_KEY }; // re-export (storage single source lives in shared/lib)

const STT_PROVIDERS = ["dashscope", "siliconflow"] as const;

// 试听固定短句 key（链路/音色/key 一次性验证；文案归 i18n——AG-16 零硬编码 CJK）
const AUDITION_TEXT_KEY = "chat.settings.voiceTts.auditionText";

/** 试听结果帧载荷。 */
interface SynthResultPayload {
  status: "ok" | "error";
  audio?: string;
  reason?: string;
}

const VoiceSettingsSection = function VoiceSettingsSection() {
  const { t } = useI18n();
  const toast = useToast();
  const { topology, requestAuthList, setProviderKey, sendVoiceSynthesize, subscribeVoiceFrames } = useSession();
  const [provider, setProvider] = useState<string>(() => readSttProviderPref() ?? "auto");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // ── TTS 偏好态（初值 localStorage；写 = 偏好 + 立即生效面由 useVoiceBroadcast 消费）──
  const [broadcastOn, setBroadcastOn] = useState<boolean>(() => readVoiceBroadcastPref());
  const [voice, setVoice] = useState<string>(() => readTtsVoicePref());
  const [volume, setVolume] = useState<number>(() => readVoiceVolumePref());
  const [auditioning, setAuditioning] = useState(false);
  const auditionPendingRef = useRef(false);

  useEffect(() => {
    requestAuthList();
  }, [requestAuthList]);

  // 试听回执消费（单飞门控：仅 pending 时消费；TR-89 双登记——LISTEN_SURFACE
  // subscribeVoiceFrames 谓词 + 此消费清单）
  useEffect(() => {
    if (subscribeVoiceFrames === undefined) return;
    return subscribeVoiceFrames((event: EventEnvelope) => {
      if (event.type !== "voice.synthesize.result") return;
      if (!auditionPendingRef.current) return;
      auditionPendingRef.current = false;
      setAuditioning(false);
      const payload = event.payload as unknown as SynthResultPayload;
      if (payload.status === "ok" && typeof payload.audio === "string") {
        try {
          const audio = new Audio(payload.audio);
          audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
          void audio.play().catch(() => toast.push("err", t("chat.settings.voiceTts.auditionBlocked")));
        } catch {
          toast.push("err", t("chat.settings.voiceTts.auditionBlocked"));
        }
      } else {
        toast.push("err", String(payload.reason ?? t("chat.settings.voiceTts.auditionFail")));
      }
    });
  }, [subscribeVoiceFrames, toast, t]);

  const onPickProvider = (id: string) => {
    setProvider(id);
    writeSttProviderPref(id);
  };

  const onSaveKey = (pid: string) => {
    const key = (drafts[pid] ?? "").trim();
    if (key === "") return;
    if (!setProviderKey(pid, key)) toast.push("err", t("chat.settings.voice.keySendFail"));
    setDrafts((d) => ({ ...d, [pid]: "" }));
  };

  const onToggleBroadcast = (on: boolean) => {
    setBroadcastOn(on);
    writeVoiceBroadcastPref(on);
  };

  const onPickVoice = (id: string) => {
    setVoice(id);
    writeTtsVoicePref(id);
  };

  const onVolume = (v: number) => {
    setVolume(v);
    writeVoiceVolumePref(v);
  };

  const onAudition = () => {
    if (auditionPendingRef.current) return;
    const sent = sendVoiceSynthesize(t(AUDITION_TEXT_KEY), { voice, language: "zh" });
    if (!sent) {
      toast.push("err", t("chat.settings.voiceTts.auditionSendFail"));
      return;
    }
    auditionPendingRef.current = true;
    setAuditioning(true);
  };

  const auth = topology.modelConfig.auth;

  return (
    <div className="pg" data-voice-settings>
      <h2 className="pg-title">{t("chat.settings.voice.title")}</h2>
      <p className="pg-note">{t("chat.settings.voice.note")}</p>

      <div className="set-card" data-voice-provider>
        <div className="set-card-label">{t("chat.settings.voice.provider")}</div>
        <div className="voice-provider-row" role="radiogroup" aria-label={t("chat.settings.voice.provider")}>
          {(["auto", ...STT_PROVIDERS] as const).map((id) => (
            <label key={id} className={cn("voice-provider-opt", provider === id && "on")}>
              <input
                type="radio"
                name="stt-provider"
                checked={provider === id}
                onChange={() => onPickProvider(id)}
              />
              {t(`chat.settings.voice.provider.${id}`)}
            </label>
          ))}
        </div>
        <div className="pg-note">{t("chat.settings.voice.providerHint")}</div>
      </div>

      {STT_PROVIDERS.map((pid) => {
        const entry = auth[pid];
        return (
          <div className="set-card" key={pid} data-voice-key-row={pid}>
            <div className="set-card-label">
              <KeyRound size={12} aria-hidden /> {pid}
              {entry?.configured ? (
                <span className="voice-key-mask">{entry.keyMasked ?? "****"}</span>
              ) : (
                <span className="voice-key-unset">{t("chat.settings.voice.unset")}</span>
              )}
            </div>
            <div className="voice-key-input">
              <input
                type="password"
                value={drafts[pid] ?? ""}
                placeholder={t("chat.settings.voice.keyPlaceholder")}
                onChange={(e) => setDrafts((d) => ({ ...d, [pid]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveKey(pid);
                }}
              />
              <button
                type="button"
                className="hud-btn hud-btn-cyan"
                disabled={(drafts[pid] ?? "").trim() === ""}
                onClick={() => onSaveKey(pid)}
              >
                {t("chat.settings.voice.save")}
              </button>
            </div>
          </div>
        );
      })}

      {/* ── TTS 播报段（语音播报批 V2）────────────────────── */}
      <h2 className="pg-title" style={{ marginTop: 24 }}>
        <Volume2 size={14} aria-hidden /> {t("chat.settings.voiceTts.title")}
      </h2>
      <p className="pg-note">{t("chat.settings.voiceTts.note")}</p>

      <div className="set-card" data-tts-broadcast>
        <div className="set-card-label">{t("chat.settings.voiceTts.broadcast")}</div>
        <div className="voice-provider-row" role="radiogroup" aria-label={t("chat.settings.voiceTts.broadcast")}>
          <label className={cn("voice-provider-opt", !broadcastOn && "on")}>
            <input type="radio" name="tts-broadcast" value="off" checked={!broadcastOn} onChange={() => onToggleBroadcast(false)} />
            {t("chat.settings.voiceTts.broadcast.off")}
          </label>
          <label className={cn("voice-provider-opt", broadcastOn && "on")}>
            <input type="radio" name="tts-broadcast" value="on" checked={broadcastOn} onChange={() => onToggleBroadcast(true)} />
            {t("chat.settings.voiceTts.broadcast.on")}
          </label>
        </div>
        <div className="pg-note">{t("chat.settings.voiceTts.broadcastHint")}</div>
      </div>

      <div className="set-card" data-tts-voice>
        <div className="set-card-label">{t("chat.settings.voiceTts.voice")}</div>
        <div className="voice-key-input">
          <select
            aria-label={t("chat.settings.voiceTts.voice")}
            value={voice === "" ? DEFAULT_TTS_VOICE : voice}
            onChange={(e) => onPickVoice(e.target.value)}
            style={{ flex: 1 }}
          >
            {TTS_VOICE_OPTIONS.map((id) => (
              <option key={id} value={id}>
                {t(`chat.settings.voiceTts.voiceOpt.${id}`)}
              </option>
            ))}
          </select>
          <button type="button" className="hud-btn hud-btn-cyan" disabled={auditioning} onClick={onAudition}>
            {auditioning ? t("chat.settings.voiceTts.auditioning") : t("chat.settings.voiceTts.audition")}
          </button>
        </div>
        <div className="pg-note">{t("chat.settings.voiceTts.voiceHint")}</div>
      </div>

      <div className="set-card" data-tts-volume>
        <div className="set-card-label">{t("chat.settings.voiceTts.volume")}</div>
        <div className="voice-key-input">
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            aria-label={t("chat.settings.voiceTts.volume")}
            onChange={(e) => onVolume(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span className="voice-key-mask">{volume}</span>
        </div>
      </div>
    </div>
  );
};
export default VoiceSettingsSection;
