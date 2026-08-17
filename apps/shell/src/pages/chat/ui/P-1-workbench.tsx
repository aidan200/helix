/**
 * P-1 工作台三区骨架（F(2.1).1；CL-2）：侧栏 264px（可折叠 56px 图标条，
 * 折叠态归 P-2 侧栏组件内部）+ 主区（.app：顶栏 → 连接横幅槽 → 消息流 →
 * composer——既有 ChatPage 装配零改动迁入）+ SubAgent 抽屉收起竖条。
 *
 * 主区 children 由 pages/chat/ChatPage 注入（.app 直系子序 = app-header →
 * conn-banner → msg-flow → composer-wrap，F 层布局断言面）。
 */
import type { ReactNode } from "react";
import SessionSidebar from "@/widgets/session-sidebar/ui/P-2-session-sidebar";
import DrawerRail from "@/widgets/subagent-drawer/ui/P-1-drawer-rail";

export interface WorkbenchProps {
  /** 主区内容（.app 列：顶栏/横幅/消息流/composer） */
  children: ReactNode;
  /** 开实例抽屉（rail 点击 → 最近实例；卡片入口归消息流） */
  onOpenInstance: (instanceId: string) => void;
}

const Workbench = function Workbench({ children, onOpenInstance }: WorkbenchProps) {
  return (
    <div className="workbench">
      <SessionSidebar />
      {children}
      <DrawerRail onOpen={onOpenInstance} />
    </div>
  );
};

export default Workbench;
