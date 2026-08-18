/**
 * trace 占位页（CL-4；T3.4）：施工牌模板实例（AD-1 只做框架不做填充）。
 * 页面域/会话域分离：零数据面，路由行由 app 层注入。
 */
import { Activity } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import ConstructionBoard from "@/shared/ui/ConstructionBoard";

const TracePage = function TracePage({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <ConstructionBoard
      icon={Activity}
      name={t("chat.nav.pages.trace.label")}
      route={path}
      preview={t("chat.nav.pages.trace.preview")}
    />
  );
};

export default TracePage;
