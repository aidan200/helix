/**
 * 管家设置分区（V2.5 收官批）：启用开关 + 模型槽位选择。
 *
 * 数据面（daemon 权威，结果帧驱动——TR-84 禁乐观假反馈）：
 * - 进入分区 → steward.get_config（幂等读）+ requestModelConfig（目录，
 *   模型选择数据源复用设置页模型分区同一 topology.modelConfig.catalog）；
 *   回执 steward.config.result → 本地 {enabled, model} 态；
 * - 启用开关（radio 关/开，语音 TTS 播报开关同构）：切换 →
 *   steward.set_config {enabled}；回执 config.result 新态同步本地选中
 *   （不乐观翻转）；send false（未连接）→ err toast；
 * - 模型槽位（select，选项 = 可用性过滤后目录 id「provider/model-id」——
 *   V2.5 补丁：与 P-3 菜单 / AgentPage S3a / 语音区同口径，仅显示已配置
 *   （configured）provider 的模型；现值兑底（provider 未 configured /
 *   不在目录仍保留——select 不说谎））：换值 → steward.set_config {model}；
 *   回执帧同步 select 值；
 *
 * 与面板互不干扰：本分区不复用 useSteward（其订阅闸门效应
 * [conn,open,enabled] 与面板开合态纠缠——两处独立实例的 subscribe/
 * unsubscribe 会互踩，TR-169 族）；仅消费 config 点对点回执，广播帧
 * 两消费者各取所需（设置页改配置，已开面板同帧收新态）。
 *
 * money gate 语义：开关默认关；关 = daemon 侧 steward.ask 直接拒答零
 * LLM 调用（服务端权威），面板呈关闭引导。
 */
import { useEffect, useMemo, useState } from "react";
import { ConciergeBell } from "lucide-react";
import { useSession } from "@/entities/session/SessionContext";
import { filterAvailableModels } from "@/features/model-switch/model/available-models";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import type { EventEnvelope } from "@helix/protocol";

/** 管家设置现态（steward.config.result 载荷同构）。 */
interface StewardConfig {
  readonly enabled: boolean;
  readonly model: string;
}

const StewardSettingsSection = function StewardSettingsSection() {
  const { t } = useI18n();
  const toast = useToast();
  const { topology, requestModelConfig, requestAuthList, sendStewardGetConfig, sendStewardSetConfig, subscribeStewardFrames } =
    useSession();
  // null = 未收到 config.result（现态到达前开关段按默认关展示）
  const [config, setConfig] = useState<StewardConfig | null>(null);

  // 进入分区拉取（幂等读；命令面 ref 恒定——mount 单发，无自激面）+ auth.list
  // （V2.5 补丁：configured 过滤数据源，每次进入刷新——P-3/P-4/AgentPage 同口径）
  useEffect(() => {
    sendStewardGetConfig();
    requestModelConfig();
    requestAuthList();
  }, [sendStewardGetConfig, requestModelConfig, requestAuthList]);

  // config 回执消费（本分区写面 + 面板/他处写面同帧广播——单一状态源）
  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type !== "steward.config.result") return;
      const payload = event.payload as StewardConfig;
      setConfig({ enabled: payload.enabled === true, model: String(payload.model ?? "") });
    });
  }, [subscribeStewardFrames]);

  const onToggleEnabled = (on: boolean) => {
    const ok = sendStewardSetConfig({ enabled: on });
    if (ok === false) toast.push("err", t("chat.modelsConfig.sendFailToast")); // TR-168 严格判
    // 本地态等回执帧（不乐观）
  };

  const onPickModel = (model: string) => {
    const ok = sendStewardSetConfig({ model });
    if (ok === false) toast.push("err", t("chat.modelsConfig.sendFailToast"));
  };

  const mc = topology.modelConfig;
  const models = useMemo(() => mc.catalog?.models ?? [], [mc.catalog]);
  // 可用性过滤后选项（V2.5 补丁，canonical = features/model-switch 的
  // filterAvailableModels，P-3 菜单 / AgentPage ProfileCard 同源）：
  // authLoaded=true 时仅保留 provider configured 的模型（verifyStatus 不
  // 参与）；现值兑底（provider 未 configured 也保留，防 select 找不到现值）；
  // authLoaded=false 不过滤（防加载期空态）。现值不在目录（daemon 默认/
  // 自定义）再补额外选项——select 不说谎
  const options = useMemo(() => {
    const visible = filterAvailableModels({
      models,
      auth: mc.auth,
      authLoaded: mc.authLoaded,
      currentModel: config?.model,
      query: "",
    });
    const ids = visible.map((m) => m.id);
    const current = config?.model ?? "";
    return current !== "" && !ids.includes(current) ? [current, ...ids] : ids;
  }, [models, mc.auth, mc.authLoaded, config?.model]);

  const enabled = config?.enabled === true;

  return (
    <div className="pg" data-steward-settings>
      <h2 className="pg-title">
        <ConciergeBell size={14} aria-hidden /> {t("chat.settings.steward.title")}
      </h2>
      <p className="pg-note">{t("chat.settings.steward.note")}</p>

      <div className="set-card" data-steward-enabled-card>
        <div className="set-card-label">{t("chat.settings.steward.enable")}</div>
        <div className="voice-provider-row" role="radiogroup" aria-label={t("chat.settings.steward.enable")}>
          <label className={cn("voice-provider-opt", !enabled && "on")}>
            <input
              type="radio"
              name="steward-enabled"
              value="off"
              checked={!enabled}
              onChange={() => onToggleEnabled(false)}
            />
            {t("chat.settings.steward.enable.off")}
          </label>
          <label className={cn("voice-provider-opt", enabled && "on")}>
            <input
              type="radio"
              name="steward-enabled"
              value="on"
              checked={enabled}
              onChange={() => onToggleEnabled(true)}
            />
            {t("chat.settings.steward.enable.on")}
          </label>
        </div>
        <div className="pg-note">{t("chat.settings.steward.enableHint")}</div>
      </div>

      <div className="set-card" data-steward-model-card>
        <div className="set-card-label">{t("chat.settings.steward.model")}</div>
        <div className="voice-key-input">
          <select
            aria-label={t("chat.settings.steward.model")}
            data-testid="steward-model-select"
            value={config?.model ?? ""}
            style={{ flex: 1 }}
            onChange={(e) => onPickModel(e.target.value)}
          >
            {/* 现态未到达的过渡态占位 / 零可用空占位（hidden；避免受控 value 无匹配项） */}
            {(config === null || options.length === 0) && <option value="" hidden />}
            {options.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className="pg-note">{t("chat.settings.steward.modelHint")}</div>
      </div>
    </div>
  );
};
export default StewardSettingsSection;
