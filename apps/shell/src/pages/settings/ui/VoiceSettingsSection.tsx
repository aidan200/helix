/**
 * 语音设置分区（语音输入批 V1 STT + 语音播报批 V2 TTS + 设置页 UX 重排批）。
 *
 * 结构（UX 重排批）：General 分区同构——pg-title + section-label 组标签 +
 * hud-card 卡（fld/hud-label/hud-btn），开关一律 checkbox（set-check 类，
 * MCP 表单 mcp-enabled 同构）；radio 假开关与零样式私有类（set-card、
 * set-card-label、pg-note、voice-provider 系、voice-key 系）随批退役。
 *
 * STT（V1）：
 * - 识别服务偏好：偏好存 localStorage（helix.stt.provider；缺省 auto =
 *   daemon 装配序自动选首个已配 key 的——dashscope 主选、siliconflow 兜底）；
 *   Composer 转写命令随偏好携带 payload.provider（auto 不带）；
 * - 配置态区分（语音服务卡退役批）：未配 key 的服务选择钮直接禁选
 *   （disabled）+ 「· 未配置」后缀——不配 key 的服务选了也用不了，与其
 *   留一个点了转写必报错的选项，不如入口处就不给选；不做第二状态卡、
 *   不指路；key 管理唯一入口归「模型」分区。数据复用进入分区即发的
 *   requestAuthList，无新拉取。
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
import { ChevronDown } from "lucide-react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import { readSttProviderPref, writeSttProviderPref } from "@/shared/lib/stt-provider-pref";
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
  const { topology, requestAuthList, sendVoiceSynthesize, sendVoiceSubscribe, sendVoiceUnsubscribe, subscribeVoiceFrames } = useSession();
  const [provider, setProvider] = useState<string>(() => readSttProviderPref() ?? "auto");
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

  const onToggleBroadcast = (on: boolean) => {
    setBroadcastOn(on);
    writeVoiceBroadcastPref(on);
    // 即时生效：订阅是连接级闸门，useVoiceBroadcast 的重放 effect 仅依赖 conn——
    // 开关切换必须当场补发，否则要等下次重连（V2 缺陷修复）
    if (on) sendVoiceSubscribe(readTtsVoicePref());
    else sendVoiceUnsubscribe();
  };

  const onPickVoice = (id: string) => {
    setVoice(id);
    writeTtsVoicePref(id);
    // 音色偏好随订阅上报——订阅态下切换音色即时生效（否则下一帧仍是旧音色）
    sendVoiceSubscribe(id);
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

      <h3 className="section-label gen-group-label first">{t("chat.settings.voice.groupService")}</h3>
      <div className="hud-card" data-voice-provider>
        <p className="ag-note">{t("chat.settings.voice.note")}</p>
        <div className="fld">
          <span className="hud-label">{t("chat.settings.voice.provider")}</span>
          <div className="lang-switch" role="group" aria-label={t("chat.settings.voice.provider")}>
            {(["auto", ...STT_PROVIDERS] as const).map((id) => {
              // 配置态区分（语音服务卡退役批）：auto 恒可选；具名服务未配 key
              // → 禁选（disabled + 标灰 + 后缀）——不配 key 选了也用不了，
              // 入口处不给选，不留一个转写必报错的选项
              const unconfigured = id !== "auto" && auth[id]?.configured !== true;
              return (
                <button
                  key={id}
                  type="button"
                  className={cn("hud-btn sm", provider === id ? "hud-btn-cyan" : "hud-btn-ghost", unconfigured && "opt-nokey")}
                  data-stt-option={id}
                  aria-pressed={provider === id}
                  disabled={unconfigured}
                  onClick={() => onPickProvider(id)}
                >
                  {t(`chat.settings.voice.providerOpt.${id}`)}
                  {unconfigured && <span className="opt-nokey-tag">{t("chat.settings.voice.notConfigured")}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <span className="ag-note">{t("chat.settings.voice.providerHint")}</span>
      </div>

      {/* ── TTS 播报段（语音播报批 V2）────────────────────── */}
      <h2 className="pg-title pg-subtitle">{t("chat.settings.voiceTts.title")}</h2>

      <h3 className="section-label gen-group-label first">{t("chat.settings.voiceTts.groupSwitch")}</h3>
      <div className="hud-card" data-tts-broadcast>
        <p className="ag-note">{t("chat.settings.voiceTts.note")}</p>
        <label className="set-check" data-tts-enabled>
          <input
            type="checkbox"
            checked={broadcastOn}
            onChange={(e) => onToggleBroadcast(e.target.checked)}
          />
          {t("chat.settings.voiceTts.broadcastOn")}
        </label>
        <span className="ag-note">{t("chat.settings.voiceTts.broadcastHint")}</span>
      </div>

      <h3 className="section-label gen-group-label">{t("chat.settings.voiceTts.groupVoice")}</h3>
      <div className="hud-card" data-tts-voice>
        <div className="fld">
          <label className="hud-label" htmlFor="tts-voice">
            {t("chat.settings.voiceTts.voice")}
          </label>
          <div className="set-inline">
            <div className="sel-wrap">
              <select
                id="tts-voice"
                className="hud-input"
                value={voice === "" ? DEFAULT_TTS_VOICE : voice}
                onChange={(e) => onPickVoice(e.target.value)}
              >
                {TTS_VOICE_OPTIONS.map((id) => (
                  <option key={id} value={id}>
                    {t(`chat.settings.voiceTts.voiceOpt.${id}`)}
                  </option>
                ))}
              </select>
              <span className="sel-chev">
                <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
              </span>
            </div>
            <button type="button" className="hud-btn hud-btn-cyan" disabled={auditioning} onClick={onAudition}>
              {auditioning ? t("chat.settings.voiceTts.auditioning") : t("chat.settings.voiceTts.audition")}
            </button>
          </div>
        </div>
        <div className="fld">
          <label className="hud-label" htmlFor="tts-volume">
            {t("chat.settings.voiceTts.volume")}
          </label>
          <div className="set-inline">
            <input
              id="tts-volume"
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => onVolume(Number(e.target.value))}
            />
            <span className="hud-chip" data-tts-volume-value>
              {volume}
            </span>
          </div>
        </div>
        <span className="ag-note">{t("chat.settings.voiceTts.voiceHint")}</span>
      </div>
    </div>
  );
};
export default VoiceSettingsSection;
