/**
 * 管家只读档案卡（管家公民权批；ProfileCard 卡片骨架同构——hud-card 载体）。
 *
 * 与 kind 配置卡的三点差异（用户拍板的设计决定，不可改）：
 * - 无「启用/禁用」开关（管家常驻——全卡零 switch）；
 * - 无模型选择器编辑：只显示当前 steward.model 槽位 + 「在设置页语音管家段
 *   修改」指引（写面在设置页，本卡纯观测）；
 * - 无 spawn 入口（不可派生）。
 *
 * 内容三块：system prompt 折叠面板（默认收起显示首行任务描述摘要，展开
 * 全文——数据随档案一次拉全，开/关纯本地态）/ 工具清单（注册面八工具：
 * 名称 + 一句话描述）/ 模型显示 + 指引。常驻标注行含三要素四词组
 * 「内嵌常驻 · WS 直通 · 不可配置 · 不可派生」。
 */
import { useState } from "react";
import type { AgentStewardProfileGetResultPayload } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";

/** 管家档案卡（只读观测面；数据 = agent.steward_profile.get.result 载荷）。 */
export default function StewardCard({
  profile,
}: {
  profile: AgentStewardProfileGetResultPayload | null;
}) {
  const { t } = useI18n();
  const [promptOpen, setPromptOpen] = useState(false);
  const promptSummary = profile === null ? "" : profile.systemPrompt.split("\n", 1)[0] ?? "";

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

      {/* 常驻标注：三要素四词组 + 定位说明（daemon 内嵌常驻服务，非 SubAgent profile） */}
      <p className="ag-note" data-steward-residency>
        {t("agents.stewardResidency")}
      </p>
      <p className="ag-note">{t("agents.stewardNote")}</p>

      {/* 模型槽位：只显示 + 指引（写面在设置页语音管家段；无选择器） */}
      <div className="ag-model" data-steward-model>
        <span className="hud-label">{t("agents.modelLabel")}</span>
        <span className="ag-name" data-steward-model-value>
          {profile === null ? t("agents.stewardLoading") : profile.model ?? t("agents.stewardModelUnset")}
        </span>
        <p className="ag-note" data-steward-model-note>
          {t("agents.stewardModelNote")}
        </p>
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
