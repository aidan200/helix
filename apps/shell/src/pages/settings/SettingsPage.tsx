/**
 * settings 占位页（CL-4；T3.4）：施工牌模板实例（AD-1 只做框架不做填充）。
 * 页面域/会话域分离：零数据面，路由行由 app 层注入。
 * 注：原 pages/settings/ 的 P-4 模型配置页已迁移至 pages/models/（Q-4b）。
 */
import { Settings } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import ConstructionBoard from "@/shared/ui/ConstructionBoard";

const SettingsPage = function SettingsPage({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <ConstructionBoard
      icon={Settings}
      name={t("chat.nav.pages.settings.label")}
      route={path}
      preview={t("chat.nav.pages.settings.preview")}
    />
  );
};

export default SettingsPage;
