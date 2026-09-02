/**
 * settings 页（S2 实页化；CL-4 占位 → 实页）：AppLayout 统一壳组装——
 * headerLeft = 页名；sidebar = SettingsNav 分区导航（首项 = 模型设置，
 * 追加方式见该组件 docblock 预留说明）；main = 当前选中分区内容
 * （S2 首分区 = 模型配置，自独立 /models 页迁入，功能逻辑零变更）。
 *
 * 分区状态：页面本地 useState（无 URL 子路由——route.ts 是扁平路由，
 * 不扩机制）。页面域/会话域分离：路由行由 app 层注入（data-settings-page
 * 锚）；数据面全在分区组件内。
 */
import { useState } from "react";
import { useI18n } from "@/shared/i18n";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import ModelsSettingsSection from "./ui/ModelsSettingsSection";
import GeneralSettingsSection from "./ui/GeneralSettingsSection";
import SettingsNav, {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "./ui/SettingsNav";

const SettingsPage = function SettingsPage({ path }: { path: string }) {
  const { t } = useI18n();
  // 首分区缺省选中（列表非空由编译期字面量保证；S2 仅一项）
  const [section, setSection] = useState<SettingsSectionId>(
    SETTINGS_SECTIONS[0]!.id,
  );
  return (
    <div data-settings-page={path}>
      <AppLayout
        headerLeft={<h1 className="tb-title">{t("chat.nav.pages.settings.label")}</h1>}
        sidebar={<SettingsNav active={section} onSelect={setSection} />}
      >
        {section === "models" && <ModelsSettingsSection />}
        {section === "general" && <GeneralSettingsSection />}
      </AppLayout>
    </div>
  );
};

export default SettingsPage;
