/**
 * settings 页（S2 实页化；CL-4 占位 → 实页）：AppLayout 统一壳组装——
 * headerLeft = 页名；sidebar = SettingsNav 分区导航（首项 = 模型设置，
 * 追加方式见该组件 docblock 预留说明）；main = 当前选中分区内容
 * （S2 首分区 = 模型配置，自独立 /models 页迁入，功能逻辑零变更）。
 *
 * 分区状态：页面本地 useState（无 URL 子路由——route.ts 是扁平路由，
 * 不扩机制）。页面域/会话域分离：路由行由 app 层注入（data-settings-page
 * 锚）；数据面全在分区组件内。
 *
 * B2：跨页指路（记忆页/管家记忆区引导 → 模型分区向量 tab）经
 * settings-section-bus 一次性 pending 信号——挂载时消费切分区 + 透传
 * initialTab（分区条件渲染保证重挂载接初值）。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/shared/i18n";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import ModelsSettingsSection from "./ui/ModelsSettingsSection";
import GeneralSettingsSection from "./ui/GeneralSettingsSection";
import McpSettingsSection from "./ui/McpSettingsSection";
import SkillsSettingsSection from "./ui/SkillsSettingsSection";
import VoiceSettingsSection from "./ui/VoiceSettingsSection";
import SettingsNav, {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "./ui/SettingsNav";
import { clearPendingSection, peekPendingSection, type ModelsTab } from "./settings-section-bus";

const SettingsPage = function SettingsPage({ path, onOpenStewardMemory }: { path: string; onOpenStewardMemory: () => void }) {
  const { t } = useI18n();
  // 首分区缺省选中（列表非空由编译期字面量保证；首项 = 模型设置）；
  // B2：跨页指路 pending 信号（记忆页/管家区引导 → models 分区 + tab 位）。
  // 渲染期只读 peek（不清位）——StrictMode 双渲染腿/并发渲染废弃腿会多次跑
  // 渲染体，渲染期 consume 会让后来的那腿必得 null 从而丢信号；清位在挂载
  // effect（双跑幂等），保证一次性语义不泄漏给下一次挂载。
  const pending = peekPendingSection();
  const [section, setSection] = useState<SettingsSectionId>(
    pending?.section != null && SETTINGS_SECTIONS.some((s) => s.id === pending.section)
      ? (pending.section as SettingsSectionId)
      : SETTINGS_SECTIONS[0]!.id,
  );
  const [modelsTab, setModelsTab] = useState<ModelsTab>(pending?.tab ?? "chat");
  useEffect(() => {
    clearPendingSection();
  }, []);
  /** 管家区引导：切模型分区 + 向量 tab（同页内切分区——条件渲染重挂载接初值）。 */
  const openModelsEmbeddingTab = useCallback(() => {
    setModelsTab("embedding");
    setSection("models");
  }, []);
  return (
    <div data-settings-page={path}>
      <AppLayout
        headerLeft={<h1 className="tb-title">{t("chat.nav.pages.settings.label")}</h1>}
        sidebar={<SettingsNav active={section} onSelect={setSection} />}
      >
        {section === "models" && <ModelsSettingsSection initialTab={modelsTab} />}
        {section === "general" && (
          <GeneralSettingsSection
            onOpenModelsEmbeddingTab={openModelsEmbeddingTab}
            onOpenMemory={onOpenStewardMemory}
          />
        )}
        {section === "mcp" && <McpSettingsSection />}
        {section === "skills" && <SkillsSettingsSection />}
        {section === "voice" && <VoiceSettingsSection />}
      </AppLayout>
    </div>
  );
};

export default SettingsPage;
