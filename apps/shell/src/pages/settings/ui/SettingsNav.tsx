/**
 * SettingsNav 设置分区导航（S2 设置页实页化；sidebar 槽组件）。
 *
 * 结构按「分区列表」设计（data-section 锚；列表首项 = 模型设置）。本次
 * 仅一项，不虚构未规划分区。
 *
 * ── 未来分区追加方式（预留说明，S2 裁决口径）──
 * 1. 新分区 = SETTINGS_SECTIONS 追加一项（id 进 SettingsSectionId 联合，
 *    labelKey 走 chat.settings.nav.* 词条族）；
 * 2. 内容组件落 src/pages/settings/ui/ 下，SettingsPage 分区 switch 追加
 *    分支渲染（无 URL 子路由——route.ts 是扁平路由，不扩机制）；
 * 3. 不建空占位项：分区有实内容才入列表。
 *
 * 纯展示（TR-AD-8）：分区表内置本文件（静态 UI 配置），激活态/切换回调
 * props 注入，不读 store；视觉语言沿 Cyber-HUD 侧栏既有模式（参考
 * .sidebar/.ses 激活态 cyan，样式在 workbench.css 设置页段落）。
 */
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";

/** 设置分区 id（新增分区在此扩展联合类型）。 */
export type SettingsSectionId = "models";

/** 分区清单（首项 = 模型设置；追加方式见文件头预留说明）。 */
export const SETTINGS_SECTIONS: readonly {
  id: SettingsSectionId;
  labelKey: string;
}[] = [
  { id: "models", labelKey: "chat.settings.nav.models" },
];

export interface SettingsNavProps {
  /** 当前激活分区（页面本地 state 注入）。 */
  active: SettingsSectionId;
  /** 切换分区回调。 */
  onSelect: (section: SettingsSectionId) => void;
}

const SettingsNav = function SettingsNav({ active, onSelect }: SettingsNavProps) {
  const { t } = useI18n();
  return (
    <nav className="set-nav" data-settings-nav aria-label={t("chat.settings.nav.label")}>
      <div className="set-nav-label">{t("chat.settings.nav.label")}</div>
      <div className="set-nav-list" role="tablist">
        {SETTINGS_SECTIONS.map((section) => {
          const on = section.id === active;
          return (
            <button
              key={section.id}
              className={cn("set-nav-item", on && "on")}
              type="button"
              role="tab"
              aria-selected={on}
              data-section={section.id}
              onClick={() => onSelect(section.id)}
            >
              {t(section.labelKey)}
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default SettingsNav;
