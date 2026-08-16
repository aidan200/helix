/**
 * P-1 抽屉关闭态竖条（F(2.1).1 主区构成；review.md「抽屉关闭态」）：右侧
 * 26px 竖条（SUB-AGENTS 标签 + 计数徽标），点击展开 M2 既有抽屉（打不开
 * 具体实例通道时取最近实例——卡片入口仍是主寻址位）。无实例时不渲染
 * （空会话无抽屉入口）。
 */
import { ChevronsRight } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

export interface DrawerRailProps {
  onOpen: (instanceId: string) => void;
}

const DrawerRail = function DrawerRail({ onOpen }: DrawerRailProps) {
  const { t } = useI18n();
  const { state } = useSession();
  const instances = state.instances;
  if (instances.length === 0) return null;
  const latest = instances[instances.length - 1]!;
  return (
    <button
      className="drawer-rail"
      type="button"
      data-drawer-rail
      data-rail-count={instances.length}
      title={t("chat.rail.open")}
      aria-label={`${t("chat.rail.open")} · ${instances.length}`}
      onClick={() => onOpen(latest.instanceId)}
    >
      <ChevronsRight size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="rail-label">{t("chat.rail.label")}</span>
      <span className="rail-count">{instances.length}</span>
    </button>
  );
};

export default DrawerRail;
