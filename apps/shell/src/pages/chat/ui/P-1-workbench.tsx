/**
 * P-1 工作台骨架（F(2.1).1；CL-2；T5.2 布局重组）：header 全宽置顶
 * （.app-header 提升为布局顶层，横跨侧栏与主区）+ header 之下横排 =
 * 侧栏 264px（可折叠 56px 窄条，折叠态归 P-2 侧栏组件内部）+ 主区
 * （.app：连接横幅槽 → 消息流 → composer——既有 ChatPage 装配零改动迁入）
 * + SubAgent 抽屉收起竖条（absolute 叠于 .wb-body 右缘）。
 *
 * 主区 children 由 pages/chat/ChatPage 注入（.app 直系子序 = conn-banner →
 * msg-flow → composer-wrap，F 层布局断言面）；header 由本组件渲染
 * （widgets/top-bar），UsagePopover/ModelSwitchMenu 随 header 同为
 * .workbench 直系子元素（absolute，backdrop-filter 包含块约束）。
 */
import type { ReactNode } from "react";
import SessionSidebar from "@/widgets/session-sidebar/ui/P-2-session-sidebar";
import DrawerRail from "@/widgets/subagent-drawer/ui/P-1-drawer-rail";
import AppHeader from "@/widgets/top-bar/ui/P-1-top-bar";

export interface WorkbenchProps {
  /** 主区内容（.app 列：横幅/消息流/composer） */
  children: ReactNode;
  /** 开实例抽屉（rail 点击 → 最近实例；卡片入口归消息流） */
  onOpenInstance: (instanceId: string) => void;
  /** P-4 路由入口（F(2.1).4 齿轮；app 路由层注入） */
  onOpenSettings?: () => void;
}

const Workbench = function Workbench({ children, onOpenInstance, onOpenSettings }: WorkbenchProps) {
  return (
    <div className="workbench">
      <AppHeader onOpenInstance={onOpenInstance} onOpenSettings={onOpenSettings} />
      <div className="wb-body">
        <SessionSidebar />
        {children}
        <DrawerRail onOpen={onOpenInstance} />
      </div>
    </div>
  );
};

export default Workbench;
