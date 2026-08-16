/**
 * P-4 模型与厂商配置 —— 路由壳（F(2.1).4；CL-3 页面本体归 T3.3）。
 *
 * 本任务交付：独立 URL 挂载位 + 返回壳（返回工作台入口 + 页头）。返回走
 * pushState 回工作台路由——工作台常驻 DOM（display 切换），活跃会话/输入/
 * 滚动位全保留。
 */
import { ArrowLeft } from "lucide-react";
import { useI18n } from "@/shared/i18n";

export interface P4ModelsConfigProps {
  onBack: () => void;
}

const P4ModelsConfig = function P4ModelsConfig({ onBack }: P4ModelsConfigProps) {
  const { t } = useI18n();
  return (
    <div className="p4-page" data-p4-page>
      <div className="scanline-overlay" aria-hidden="true" />
      <header className="p4-head">
        <button
          className="hud-btn hud-btn-ghost"
          id="btn-p4-back"
          type="button"
          onClick={onBack}
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
          {t("chat.settings.back")}
        </button>
        <h1 className="p4-title">{t("chat.settings.title")}</h1>
      </header>
    </div>
  );
};

export default P4ModelsConfig;
