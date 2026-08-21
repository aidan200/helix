/**
 * P-1 工作台骨架（F(2.1).1；CL-2；T5.2；S1 应用壳统一迁移 AppLayout）。
 *
 * 组装契约（S1 布局契约，供后续页面迁移参照）：
 * - headerLeft = TopBarInfo（会话标题 + 双 chip）；headerRight =
 *   TopBarActions（StatsBadge + 模型徽标 + 连接状态，受控开合）；
 * - sidebar = SessionSidebar（264px，可折叠 56px 窄条归 P-2 组件内部）；
 * - children = .wb-main 包裹容器（position:relative + flex，服务 DrawerRail
 *   右缘叠放与 .app 拉伸；.app 内部结构与 class 不动，直系子序 =
 *   conn-banner → msg-flow → composer 保持 F 层断言面）；
 * - UsagePopover / ModelSwitchMenu 由本层渲染在 AppLayout 平级（S1 布局
 *   契约：.app-header 带 backdrop-filter，popover 入 header 会丢失毛玻璃
 *   采样；平级挂靠 .page-area（position:relative）与 AppLayout 根同坐标
 *   系，top/right 定位零偏移；z-index 45/46 > .app-layout z:2）。
 */
import { useState } from "react";
import type { ReactNode } from "react";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import SessionSidebar from "@/widgets/session-sidebar/ui/P-2-session-sidebar";
import DrawerRail from "@/widgets/subagent-drawer/ui/P-1-drawer-rail";
import { TopBarActions, TopBarInfo } from "@/widgets/top-bar/ui/P-1-top-bar";
import { UsagePopover } from "@/widgets/top-bar/ui/SessionStats";
import ModelSwitchMenu from "@/features/model-switch/ui/P-3-model-switch";

export interface WorkbenchProps {
  /** 主区内容（.app 列：横幅/消息流/composer） */
  children: ReactNode;
  /** 开实例抽屉（rail 点击 → 最近实例；卡片入口归消息流） */
  onOpenInstance: (instanceId: string) => void;
}

const Workbench = function Workbench({ children, onOpenInstance }: WorkbenchProps) {
  // header 槽开合状态（受控注入 TopBarActions；popover 渲染在本层）
  const [statsOpen, setStatsOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  return (
    <>
      <AppLayout
        headerLeft={<TopBarInfo />}
        headerRight={
          <TopBarActions
            statsOpen={statsOpen}
            modelMenuOpen={modelMenuOpen}
            onToggleStats={() => setStatsOpen((v) => !v)}
            onToggleModelMenu={() => setModelMenuOpen((v) => !v)}
          />
        }
        sidebar={<SessionSidebar />}
      >
        <div className="wb-main">
          {children}
          <DrawerRail onOpen={onOpenInstance} />
        </div>
      </AppLayout>
      {/* popover 载体：AppLayout 平级浮层（S1 布局契约，见文件头注释） */}
      {statsOpen && (
        <UsagePopover onClose={() => setStatsOpen(false)} onOpenInstance={onOpenInstance} />
      )}
      {modelMenuOpen && <ModelSwitchMenu onClose={() => setModelMenuOpen(false)} />}
    </>
  );
};

export default Workbench;
