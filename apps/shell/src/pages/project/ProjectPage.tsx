/**
 * project 占位页（CL-4；T3.4；S4 壳统一收尾）：施工牌模板实例（AD-1 只做
 * 框架不做填充）。S4 迁 AppLayout 统一壳组装：headerLeft = 页名（header
 * 固定置顶）；main = ConstructionBoard 施工牌本体（name/route/preview
 * 完整呈现，data-construction 断言锚随牌不动；.construction 自带
 * height:100% 居中，落 .layout-main 即整区居中，滚动只发生在 layout-main）。
 *
 * sidebar 槽：本页不启用（不传槽位）——预留语义：未来项目域若加左栏
 * （项目文件树/分支列表等）经 AppLayout sidebar 槽挂入，届时页面升实页。
 * 页面域/会话域分离：零数据面，路由行由 app 层注入。
 */
import { FolderKanban } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import ConstructionBoard from "@/shared/ui/ConstructionBoard";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";

const ProjectPage = function ProjectPage({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <AppLayout
      headerLeft={<h1 className="tb-title">{t("chat.nav.pages.project.label")}</h1>}
    >
      <ConstructionBoard
        icon={FolderKanban}
        name={t("chat.nav.pages.project.label")}
        route={path}
        preview={t("chat.nav.pages.project.preview")}
      />
    </AppLayout>
  );
};

export default ProjectPage;
