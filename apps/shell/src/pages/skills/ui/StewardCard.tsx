/**
 * 管家档案卡（管家公民权批 + 管家配置并轨批：模型选择并入本卡——与 kind 配置卡
 * 同一选择器形态（filterAvailableModels 可用性过滤 + provider optgroup），
 * 写面 steward.set_config {model} 经 AgentPage 注入，本卡不直连 SessionContext）。
 *
 * 与 kind 配置卡的差异：
 * - 无「启用/禁用」开关（启停在设置页通用配置；工具/提示词面无写面）；
 * - 无 spawn 入口（不可派生）。
 *
 * 内容三块：模型槽位选择器 / system prompt 折叠面板（默认收起显示首行任务
 * 描述摘要，展开全文——数据随档案一次拉全，开/关纯本地态）/ 工具清单（注册
 * 面八工具：名称 + 一句话描述）。
 */
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AgentStewardProfileGetResultPayload, CatalogModel } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { filterAvailableModels } from "@/features/model-switch/model/available-models";
import type { AuthProviderEntry } from "@/entities/session/model/state";

/** 管家档案卡（数据 = agent.steward_profile.get.result 载荷；模型写面回调注入）。 */
export default function StewardCard({
  profile,
  catalog,
  auth,
  authLoaded,
  onModelChange,
}: {
  profile: AgentStewardProfileGetResultPayload | null;
  /** 模型目录（null = 未加载——选择器禁用）。 */
  catalog: CatalogModel[] | null;
  auth: Record<string, AuthProviderEntry>;
  authLoaded: boolean;
  /** 模型槽位写面（steward.set_config {model}；新态经 config.result → 档案重拉回填）。 */
  onModelChange: (model: string) => void;
}) {
  const { t } = useI18n();
  const [promptOpen, setPromptOpen] = useState(false);
  const promptSummary = profile === null ? "" : profile.systemPrompt.split("\n", 1)[0] ?? "";

  // 模型选项（ProfileCard 同口径：filterAvailableModels 可用性过滤 + provider
  // 分组；现值兑底——provider 未 configured / 不在目录仍保留，select 不说谎）
  const modelsByProvider = useMemo(() => {
    const visible = filterAvailableModels({
      models: catalog ?? [],
      auth,
      authLoaded,
      currentModel: profile?.model ?? undefined,
      query: "",
    });
    const current = profile?.model ?? null;
    const withCurrent =
      current !== null && !visible.some((m) => m.id === current)
        ? [
            {
              id: current,
              providerId: current.split("/", 1)[0] ?? current,
            } as CatalogModel,
            ...visible,
          ]
        : visible;
    const map = new Map<string, CatalogModel[]>();
    for (const m of withCurrent) {
      const list = map.get(m.providerId);
      if (list) list.push(m);
      else map.set(m.providerId, [m]);
    }
    return map;
  }, [catalog, auth, authLoaded, profile?.model]);

  return (
    <section className="hud-card ag-card" data-agent-card="steward">
      <header className="ag-card-head">
        <h2 className="ag-card-title">{t("agents.stewardTitle")}</h2>
        <span className="hud-chip" data-kind-chip>
          steward
        </span>
        {/* 常驻徽标（非「只读」——常驻定位语义，写面恒无） */}
        <span className="hud-badge hud-badge-off" data-ro-badge>
          {t("agents.stewardBadge")}
        </span>
      </header>

      {/* 常驻标注 + 定位说明（daemon 内嵌常驻服务，非 SubAgent profile） */}
      <p className="ag-note" data-steward-residency>
        {t("agents.stewardResidency")}
      </p>
      <p className="ag-note">{t("agents.stewardNote")}</p>

      {/* 模型槽位：可编辑选择器（与 kind 卡同形态；写面 steward.set_config） */}
      <div className="ag-model" data-steward-model>
        <label className="hud-label" htmlFor="sel-model-steward">
          {t("agents.modelLabel")}
        </label>
        <div className="sel-wrap">
          <select
            id="sel-model-steward"
            className="hud-input"
            data-steward-model-select
            value={profile?.model ?? ""}
            disabled={profile === null || catalog === null}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {/* 未设置现值占位（disabled——set_config 不支持清空槽位，仅作显示） */}
            {(profile === null || profile.model === null) && (
              <option value="" disabled>
                {profile === null ? t("agents.stewardLoading") : t("agents.stewardModelUnset")}
              </option>
            )}
            {[...modelsByProvider.entries()].map(([providerId, models]) => (
              <optgroup label={providerId} key={providerId}>
                {models.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="sel-chev">
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
        </div>
      </div>

      {/* system prompt 折叠面板：默认收起显示首行任务描述；展开全文（数据随档案
          一次拉全——开/关纯本地态零新命令） */}
      <div className="ag-group" data-steward-prompt>
        <div className="ag-bp-head">
          <h3 className="ag-group-label">{t("agents.stewardPromptLabel")}</h3>
          <button
            type="button"
            className="hud-btn hud-btn-ghost sm"
            data-steward-prompt-toggle
            onClick={() => setPromptOpen((open) => !open)}
          >
            {promptOpen ? t("agents.stewardPromptHide") : t("agents.stewardPromptView")}
          </button>
        </div>
        {promptOpen ? (
          <pre className="ag-base-prompt" data-steward-prompt-text>
            {profile?.systemPrompt ?? ""}
          </pre>
        ) : (
          profile !== null && (
            <p className="ag-desc" data-steward-prompt-summary title={promptSummary}>
              {promptSummary}
            </p>
          )
        )}
      </div>

      {/* 工具清单：注册面八工具（名称 + 一句话描述；无启停开关） */}
      <div className="ag-group">
        <h3 className="ag-group-label">{t("agents.toolsLabel")}</h3>
        {profile === null ? (
          <p className="ag-loading" role="status" data-steward-loading>
            {t("agents.stewardLoading")}
          </p>
        ) : (
          profile.tools.map((tool) => (
            <div className="ag-row" data-steward-tool-row={tool.name} key={tool.name}>
              <div className="ag-row-main">
                <span className="ag-name">{tool.name}</span>
                <span className="ag-desc" title={tool.description}>
                  {tool.description}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
