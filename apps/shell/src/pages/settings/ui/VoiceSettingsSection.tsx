/**
 * 语音输入设置分区（语音输入批 V1：最小 STT 配置区）。
 *
 * - provider 选择：偏好存 localStorage（helix.stt.provider；缺省 auto =
 *   daemon 装配序自动选首个已配 key 的——dashscope 主选、siliconflow 兜底）；
 *   Composer 转写命令随偏好携带 payload.provider（auto 不带）；
 * - key 录入：复用 auth.set_key 通道（setProviderKey——dashscope 作为新
 *   provider id 经 daemon ModelService sttProviderIds 放行）；状态显示自
 *   auth.list（进入分区拉取 requestAuthList；dashscope/siliconflow 在
 *   daemon authList 并入清单）。
 * 纯展示 + 命令转发（TR-AD-8）：数据零权威，全部结果帧驱动。
 */
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import { readSttProviderPref, writeSttProviderPref, STT_PROVIDER_PREF_KEY } from "@/shared/lib/stt-provider-pref";

export { STT_PROVIDER_PREF_KEY }; // re-export (storage single source lives in shared/lib)

const STT_PROVIDERS = ["dashscope", "siliconflow"] as const;

const VoiceSettingsSection = function VoiceSettingsSection() {
  const { t } = useI18n();
  const toast = useToast();
  const { topology, requestAuthList, setProviderKey } = useSession();
  const [provider, setProvider] = useState<string>(() => readSttProviderPref() ?? "auto");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    requestAuthList();
  }, [requestAuthList]);

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
    </div>
  );
};

export default VoiceSettingsSection;
